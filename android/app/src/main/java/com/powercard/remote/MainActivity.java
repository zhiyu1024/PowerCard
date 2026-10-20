package com.powercard.remote;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewAssetLoader;

import java.util.Locale;

/**
 * 应用唯一 Activity：承载 WebView 原生壳。
 *
 * <p>页面从 https://appassets.androidplatform.net/assets/public/index.html 加载
 * （WebViewAssetLoader 托管本地 assets），页面脚本通过 window.PowerCardNative
 * 调用 Java 原生能力（加密配置存取、原生 HTTP）。</p>
 */
public final class MainActivity extends Activity {

    /** 契约固定的本地资源域名与入口 URL。 */
    public static final String ASSET_HOST = "appassets.androidplatform.net";

    public static final String START_URL =
            "https://appassets.androidplatform.net/assets/public/index.html";

    private static final String PAGE_BACKGROUND = "#f6f4ef";

    private FrameLayout root;
    private WebView webView;
    private WebViewAssetLoader assetLoader;
    private RootAssetsPathHandler rootAssets;
    private NativeBridge nativeBridge;
    private boolean backInFlight;
    private boolean pageVisible;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // release 包必须关闭 WebView 远程调试（契约要求）
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        configureEdgeToEdge();
        setContentView(buildContentView());
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (nativeBridge != null) {
            nativeBridge.shutdown();
            nativeBridge = null;
        }
        if (webView != null) {
            try {
                webView.removeJavascriptInterface(NativeBridge.JS_INTERFACE_NAME);
            } catch (Throwable ignored) {
                // 忽略
            }
            try {
                webView.stopLoading();
                webView.destroy();
            } catch (Throwable ignored) {
                // 忽略
            }
            webView = null;
        }
        super.onDestroy();
    }

    @Override
    public void onConfigurationChanged(@NonNull Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // 声明了 configChanges，旋转/深色模式切换不重建 Activity；WebView 自行适配宽度
    }

    /* ---------------------------------------------------------------------
       Edge-to-edge / 系统栏
       --------------------------------------------------------------------- */

    private void configureEdgeToEdge() {
        Window window = getWindow();
        // Android 15（API 35）默认强制 edge-to-edge；这里显式声明并自行处理安全区
        WindowCompat.setDecorFitsSystemWindows(window, false);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams params = window.getAttributes();
            params.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(params);
        }

        // 系统栏透明，页面暖白背景会透出，视觉上等同 #f6f4ef；图标为深色
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
    }

    private void applyInsets(View content) {
        WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(getWindow(), content);
        controller.setAppearanceLightStatusBars(true);
        controller.setAppearanceLightNavigationBars(true);

        ViewCompat.setOnApplyWindowInsetsListener(content, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout());
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(content);
    }

    /* ---------------------------------------------------------------------
       WebView 原生壳
       --------------------------------------------------------------------- */

    private View buildContentView() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor(PAGE_BACKGROUND));
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        try {
            webView = createWebView();
            root.addView(webView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        } catch (Throwable error) {
            // 极端情况下系统 WebView 不可用：给出可见提示而不是白屏崩溃
            TextView fallback = new TextView(this);
            fallback.setText(R.string.webview_unavailable);
            fallback.setTextColor(Color.parseColor("#1e1e1e"));
            fallback.setTextSize(16f);
            fallback.setGravity(android.view.Gravity.CENTER);
            root.addView(fallback, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }

        applyInsets(root);
        return root;
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private WebView createWebView() {
        WebView web = new WebView(this);
        web.setBackgroundColor(Color.parseColor(PAGE_BACKGROUND));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        // 只加载本地 assets，禁止 file/content 访问与跨源文件访问
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // 页面为暖白浅色主题，不跟随系统深色模式自动反色
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            settings.setForceDark(WebSettings.FORCE_DARK_OFF);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            settings.setAlgorithmicDarkeningAllowed(false);
        }
        settings.setUserAgentString(
                settings.getUserAgentString() + " PowerCardAndroid/" + BuildConfig.VERSION_NAME);

        // WebViewAssetLoader 托管 assets（契约 URL 为 /assets/public/index.html）
        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain(ASSET_HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        // index.html 用 "/xxx" 绝对路径引用同目录资源，兜底映射到 assets/public/
        rootAssets = new RootAssetsPathHandler(getAssets());

        web.setWebViewClient(new AppWebViewClient());
        web.setWebChromeClient(new WebChromeClient());

        // 必须在 loadUrl 之前注入，页面脚本执行前 window.PowerCardNative 已存在
        nativeBridge = new NativeBridge(this, web);
        web.addJavascriptInterface(nativeBridge, NativeBridge.JS_INTERFACE_NAME);

        web.loadUrl(START_URL);
        return web;
    }

    /* ---------------------------------------------------------------------
       返回键：优先交给网页（window.__powercardBack），否则退出
       --------------------------------------------------------------------- */

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // manifest 中关闭了 enableOnBackInvokedCallback，所有版本统一走 legacy 返回键。
        handleBackPressed();
    }

    private void handleBackPressed() {
        if (backInFlight) {
            return;
        }
        WebView web = webView;
        if (web == null || !pageVisible) {
            finish();
            return;
        }
        backInFlight = true;
        try {
            web.evaluateJavascript(
                    "(function(){try{return !!(window.__powercardBack && window.__powercardBack());}"
                            + "catch(e){return false;}})()",
                    value -> {
                        backInFlight = false;
                        if (!"true".equals(value)) {
                            finish();
                        }
                    });
        } catch (Throwable ignored) {
            backInFlight = false;
            finish();
        }
    }

    /* ---------------------------------------------------------------------
       剪贴板（供 native-bridge 的 copyText 使用）
       --------------------------------------------------------------------- */

    void copyToClipboard(String text) {
        try {
            ClipboardManager manager =
                    (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (manager == null) {
                return;
            }
            manager.setPrimaryClip(ClipData.newPlainText(getString(R.string.app_name), text));
        } catch (Throwable ignored) {
            // 剪贴板不可用时静默失败
        }
    }

    /* ---------------------------------------------------------------------
       URL 拦截 / 外部导航
       --------------------------------------------------------------------- */

    private WebResourceResponse intercept(Uri uri) {
        if (uri == null) {
            return null;
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || !"https".equalsIgnoreCase(scheme)
                || host == null || !ASSET_HOST.equalsIgnoreCase(host)) {
            return null;
        }
        WebResourceResponse response = assetLoader.shouldInterceptRequest(uri);
        if (response == null) {
            response = rootAssets.handle(uri.getPath());
        }
        return response;
    }

    /**
     * 只允许 appassets 内部导航；外部 http/https 用系统浏览器打开；
     * 其它协议（mailto/tel 等）尝试交给系统处理，其余一律拦截。
     */
    private boolean handleNavigation(Uri uri) {
        if (uri == null) {
            return true;
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme != null && host != null && ASSET_HOST.equalsIgnoreCase(host)) {
            // 内部资源：交给 WebViewAssetLoader/本地资源处理器
            return false;
        }
        String lower = scheme == null ? "" : scheme.toLowerCase(Locale.ROOT);
        if ("http".equals(lower) || "https".equals(lower)
                || "mailto".equals(lower) || "tel".equals(lower)) {
            openExternally(uri);
        }
        return true;
    }

    private void openExternally(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException ignored) {
            // 没有可用浏览器/拨号器时静默忽略
        }
    }

    private final class AppWebViewClient extends WebViewClient {

        @Override
        public WebResourceResponse shouldInterceptRequest(
                WebView view, @NonNull WebResourceRequest request) {
            return intercept(request.getUrl());
        }

        @Override
        @SuppressWarnings("deprecation")
        public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
            return intercept(Uri.parse(url));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, @NonNull WebResourceRequest request) {
            return handleNavigation(request.getUrl());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleNavigation(Uri.parse(url));
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            pageVisible = false;
            markNativeMode(view);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageVisible = true;
            markNativeMode(view);
        }

        @Override
        public void onReceivedError(
                WebView view, @NonNull WebResourceRequest request, @NonNull WebResourceError error) {
            // 本地资源加载失败时保持 WebView 现状：原生桥仍可用，不跳系统错误页
        }

        private void markNativeMode(WebView view) {
            // 尽力提前设置原生模式标志；native-bridge.js 也应以 window.PowerCardNative 存在为准自行判定
            try {
                view.evaluateJavascript(
                        "(function(){try{window.__POWERCARD_NATIVE__=true;}catch(e){}})()", null);
            } catch (Throwable ignored) {
                // 忽略
            }
        }
    }
}
