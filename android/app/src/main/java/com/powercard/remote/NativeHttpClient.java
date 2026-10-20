package com.powercard.remote;

import android.os.Build;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * 原生 HTTP GET：设备状态/开关机请求全部在 Java 层直接发出（手机网络，无 CORS），
 * 不依赖电脑、Node 服务或任何外部服务器。
 *
 * <p>结果字段严格对齐 docs/android-bridge-contract.md 第 3 节：
 * ok/status/contentType/body/truncated/latencyMs/error；错误码
 * INVALID_URL / TIMEOUT / NETWORK / HTTP。任何异常都转成 result.error，不向 JS 抛出。</p>
 */
public final class NativeHttpClient {

    /** 契约：body 最多 8192 字符。 */
    public static final int MAX_BODY_CHARS = 8192;
    public static final int MIN_TIMEOUT_MS = 1000;
    public static final int MAX_TIMEOUT_MS = 30000;

    private static final int MAX_REDIRECTS = 5;
    private static final String ACCEPT = "application/json, text/plain, */*";

    public static final class HttpResult {
        public final boolean ok;
        public final Integer status;
        public final String contentType;
        public final String body;
        public final boolean truncated;
        public final long latencyMs;
        public final String errorCode;
        public final String errorMessage;

        HttpResult(
                boolean ok,
                Integer status,
                String contentType,
                String body,
                boolean truncated,
                long latencyMs,
                String errorCode,
                String errorMessage) {
            this.ok = ok;
            this.status = status;
            this.contentType = contentType;
            this.body = body;
            this.truncated = truncated;
            this.latencyMs = latencyMs;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
        }

        public String toJson() {
            try {
                JSONObject json = new JSONObject();
                json.put("ok", ok);
                json.put("status", status == null ? JSONObject.NULL : status.intValue());
                json.put("contentType", contentType == null ? "" : contentType);
                json.put("body", body == null ? "" : body);
                json.put("truncated", truncated);
                json.put("latencyMs", latencyMs);
                if (errorCode == null) {
                    json.put("error", JSONObject.NULL);
                } else {
                    JSONObject error = new JSONObject();
                    error.put("code", errorCode);
                    error.put("message", errorMessage == null ? "" : errorMessage);
                    json.put("error", error);
                }
                return json.toString();
            } catch (JSONException e) {
                return failureJson("NETWORK", "结果序列化失败", latencyMs);
            }
        }
    }

    private static final class ReadResult {
        final String body;
        final boolean truncated;

        ReadResult(String body, boolean truncated) {
            this.body = body;
            this.truncated = truncated;
        }
    }

    /** 兜底 JSON（序列化失败或线程池拒绝时使用），保证 JS 侧永远能收到回调。 */
    public static String failureJson(String code, String message, long latencyMs) {
        return "{\"ok\":false,\"status\":null,\"contentType\":\"\",\"body\":\"\",\"truncated\":false,\"latencyMs\":"
                + latencyMs
                + ",\"error\":{\"code\":" + JSONObject.quote(code)
                + ",\"message\":" + JSONObject.quote(message) + "}}";
    }

    public HttpResult get(String rawUrl, int timeoutMs) {
        long startNanos = System.nanoTime();
        int timeout = clampTimeout(timeoutMs);
        if (!isHttpUrl(rawUrl)) {
            return errorResult("INVALID_URL", "URL 必须为 http/https 地址", startNanos);
        }
        long deadlineNanos = startNanos + timeout * 1_000_000L;
        String currentUrl = rawUrl;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            HttpURLConnection connection = null;
            try {
                long remainingMs = (deadlineNanos - System.nanoTime()) / 1_000_000L;
                if (remainingMs <= 0) {
                    return errorResult("TIMEOUT", "请求超时", startNanos);
                }
                URL target = new URL(currentUrl);
                connection = (HttpURLConnection) target.openConnection();
                connection.setRequestMethod("GET");
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                connection.setDoInput(true);
                connection.setConnectTimeout((int) Math.min(remainingMs, Integer.MAX_VALUE));
                connection.setReadTimeout((int) Math.min(remainingMs, Integer.MAX_VALUE));
                connection.setRequestProperty("Accept", ACCEPT);
                connection.setRequestProperty("User-Agent", userAgent());

                int status = connection.getResponseCode();
                String contentType = connection.getContentType();
                String location = connection.getHeaderField("Location");

                if (isRedirect(status) && location != null && !location.isEmpty() && hop < MAX_REDIRECTS) {
                    currentUrl = new URL(target, location).toString();
                    continue;
                }

                ReadResult read = readBody(connection, status);
                long latency = elapsedMs(startNanos);
                if (status >= 200 && status < 300) {
                    return new HttpResult(true, status, contentType, read.body, read.truncated, latency, null, null);
                }
                if (isRedirect(status)) {
                    return new HttpResult(false, status, contentType, read.body, read.truncated, latency,
                            "NETWORK", "重定向次数过多或缺少重定向地址");
                }
                return new HttpResult(false, status, contentType, read.body, read.truncated, latency,
                        "HTTP", "设备返回 HTTP " + status);
            } catch (SocketTimeoutException e) {
                return errorResult("TIMEOUT", "请求超时", startNanos);
            } catch (MalformedURLException e) {
                return errorResult("INVALID_URL", "URL 格式非法", startNanos);
            } catch (IOException e) {
                return errorResult("NETWORK", "网络请求失败（" + e.getClass().getSimpleName() + "）", startNanos);
            } catch (RuntimeException e) {
                return errorResult("NETWORK", "网络请求失败", startNanos);
            } finally {
                if (connection != null) {
                    try {
                        connection.disconnect();
                    } catch (Throwable ignored) {
                        // 忽略
                    }
                }
            }
        }
        return errorResult("NETWORK", "重定向次数过多", startNanos);
    }

    private ReadResult readBody(HttpURLConnection connection, int status) throws IOException {
        InputStream raw = (status >= 200 && status < 300)
                ? connection.getInputStream()
                : connection.getErrorStream();
        if (raw == null) {
            return new ReadResult("", false);
        }
        try (InputStream input = raw) {
            InputStreamReader reader = new InputStreamReader(
                    new BufferedInputStream(input, 8192), StandardCharsets.UTF_8);
            StringBuilder builder = new StringBuilder(MAX_BODY_CHARS + 1);
            char[] buffer = new char[1024];
            int count = 0;
            // 多读 1 个字符用于判断是否截断
            while (count <= MAX_BODY_CHARS) {
                int read = reader.read(buffer);
                if (read < 0) {
                    break;
                }
                int take = Math.min(read, MAX_BODY_CHARS + 1 - count);
                builder.append(buffer, 0, take);
                count += take;
                if (take < read) {
                    break;
                }
            }
            String text = builder.toString();
            if (text.startsWith("\uFEFF")) {
                text = text.substring(1);
            }
            boolean truncated = text.length() > MAX_BODY_CHARS;
            return new ReadResult(
                    truncated ? text.substring(0, MAX_BODY_CHARS) : text,
                    truncated);
        }
    }

    private static HttpResult errorResult(String code, String message, long startNanos) {
        return new HttpResult(false, null, "", "", false, elapsedMs(startNanos), code, message);
    }

    private static long elapsedMs(long startNanos) {
        return Math.max(0L, (System.nanoTime() - startNanos) / 1_000_000L);
    }

    public static int clampTimeout(int timeoutMs) {
        return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, timeoutMs));
    }

    private static boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303 || status == 307 || status == 308;
    }

    private static boolean isHttpUrl(String value) {
        if (value == null) {
            return false;
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty()) {
            return false;
        }
        try {
            URL url = new URL(trimmed);
            String scheme = url.getProtocol();
            if (scheme == null) {
                return false;
            }
            scheme = scheme.toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) {
                return false;
            }
            String host = url.getHost();
            return host != null && !host.isEmpty();
        } catch (MalformedURLException e) {
            return false;
        }
    }

    private static String userAgent() {
        String model = Build.MODEL == null ? "" : Build.MODEL;
        StringBuilder asciiModel = new StringBuilder(model.length());
        for (int i = 0; i < model.length(); i++) {
            char c = model.charAt(i);
            asciiModel.append(c >= 0x20 && c < 0x7f ? c : '_');
        }
        String release = Build.VERSION.RELEASE == null ? "?" : Build.VERSION.RELEASE;
        return "PowerCardNative/1.0.0 (Android " + release + "; " + asciiModel + ")";
    }
}
