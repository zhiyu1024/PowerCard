package com.powercard.remote;

import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 注入网页的 window.PowerCardNative，接口定义见 docs/android-bridge-contract.md 第 2 节。
 *
 * <p>所有方法都不向 JS 抛异常：同步方法返回兜底值，异步 HTTP 通过主线程
 * evaluateJavascript 调用 window.__powercardHttpResult(requestId, result)。</p>
 */
public final class NativeBridge {

    public static final String JS_INTERFACE_NAME = "PowerCardNative";
    private static final String HTTP_CALLBACK = "window.__powercardHttpResult";
    private static final int MAX_CLIPBOARD_CHARS = 100_000;

    private final MainActivity activity;
    private final WebView webView;
    private final SecureConfigStore configStore;
    private final NativeHttpClient httpClient = new NativeHttpClient();
    private final ExecutorService executor;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile boolean released;

    NativeBridge(MainActivity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.configStore = new SecureConfigStore(activity.getApplicationContext());
        this.executor = Executors.newFixedThreadPool(4, new ThreadFactory() {
            private final AtomicInteger counter = new AtomicInteger(1);

            @Override
            public Thread newThread(Runnable runnable) {
                Thread thread = new Thread(runnable, "powercard-http-" + counter.getAndIncrement());
                thread.setDaemon(true);
                return thread;
            }
        });
    }

    /** 返回配置 JSON 字符串；从未保存过返回 "{}"。 */
    @JavascriptInterface
    public String getConfigJson() {
        return configStore.load();
    }

    /** 保存配置 JSON 字符串；成功返回 true。 */
    @JavascriptInterface
    public boolean saveConfigJson(String json) {
        return configStore.save(json);
    }

    /**
     * 异步 GET。立即返回；完成后在主线程调用
     * window.__powercardHttpResult(requestId, result)。
     * timeoutMs 被限制在 1000–30000。
     */
    @JavascriptInterface
    public void httpGet(String requestId, String url, int timeoutMs) {
        final String id = requestId == null ? "" : requestId;
        try {
            executor.execute(() -> {
                String resultJson;
                try {
                    resultJson = httpClient.get(url, timeoutMs).toJson();
                } catch (Throwable unexpected) {
                    resultJson = NativeHttpClient.failureJson("NETWORK", "网络请求失败", 0L);
                }
                final String payload = resultJson;
                mainHandler.post(() -> deliverHttpResult(id, payload));
            });
        } catch (RejectedExecutionException e) {
            mainHandler.post(() -> deliverHttpResult(
                    id, NativeHttpClient.failureJson("NETWORK", "应用正在退出", 0L)));
        }
    }

    private void deliverHttpResult(String requestId, String resultJson) {
        if (released || webView == null) {
            return;
        }
        try {
            webView.evaluateJavascript(
                    HTTP_CALLBACK + "(" + JSONObject.quote(requestId) + "," + resultJson + ")",
                    null);
        } catch (Throwable ignored) {
            // 页面已销毁等情况：静默丢弃，不向 JS 抛异常
        }
    }

    /** 复制文本到剪贴板（可选能力）。 */
    @JavascriptInterface
    public void copyText(String text) {
        if (text == null) {
            return;
        }
        final String value = text.length() > MAX_CLIPBOARD_CHARS
                ? text.substring(0, MAX_CLIPBOARD_CHARS)
                : text;
        activity.runOnUiThread(() -> activity.copyToClipboard(value));
    }

    /** 返回形如 "1.0.0" 的版本号。 */
    @JavascriptInterface
    public String getAppVersion() {
        return BuildConfig.VERSION_NAME;
    }

    /** Activity 销毁时停止后台线程。 */
    void shutdown() {
        released = true;
        executor.shutdownNow();
    }
}
