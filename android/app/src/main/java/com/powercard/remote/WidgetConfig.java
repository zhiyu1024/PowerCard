package com.powercard.remote;

import org.json.JSONObject;

import java.net.URL;
import java.util.Locale;

/**
 * 小组件侧使用的最小配置视图：只需状态 URL、开机/关机 URL、手动字段与超时。
 *
 * <p>配置明文来自 {@link SecureConfigStore#load()}（Android Keystore AES/GCM 解密）。
 * 字段默认值/校验仍由 App 前端负责；这里只做容错解析，缺字段按空字符串处理。</p>
 */
final class WidgetConfig {

    final String statusUrl;
    final String powerOnUrl;
    final String powerOffUrl;
    final String powerField;
    final String onlineField;
    final int requestTimeoutMs;

    private WidgetConfig(String statusUrl, String powerOnUrl, String powerOffUrl,
                         String powerField, String onlineField, int requestTimeoutMs) {
        this.statusUrl = statusUrl;
        this.powerOnUrl = powerOnUrl;
        this.powerOffUrl = powerOffUrl;
        this.powerField = powerField;
        this.onlineField = onlineField;
        this.requestTimeoutMs = requestTimeoutMs;
    }

    static WidgetConfig empty() {
        return new WidgetConfig("", "", "", "", "", 5000);
    }

    static WidgetConfig fromJson(String json) {
        if (json == null || json.trim().isEmpty()) {
            return empty();
        }
        try {
            JSONObject object = new JSONObject(json);
            return new WidgetConfig(
                    stringOrEmpty(object, "statusUrl"),
                    stringOrEmpty(object, "powerOnUrl"),
                    stringOrEmpty(object, "powerOffUrl"),
                    stringOrEmpty(object, "powerField"),
                    stringOrEmpty(object, "onlineField"),
                    intOrDefault(object, "requestTimeoutMs", 5000));
        } catch (Throwable ignored) {
            return empty();
        }
    }

    /** 有状态 URL 才是“已配置”；否则小组件显示“未配置 · 打开 App 设置”。 */
    boolean hasStatusUrl() {
        return isHttpUrl(statusUrl);
    }

    String commandUrl(String pendingAction) {
        return WidgetContract.ACTION_ON.equals(pendingAction) ? powerOnUrl : powerOffUrl;
    }

    /** 小组件单次网络超时：clamp 到 [1000, 5000] ms（goAsync 广播窗口约 10s）。 */
    int widgetTimeoutMs() {
        return Math.max(WidgetContract.MIN_TIMEOUT_MS,
                Math.min(WidgetContract.WIDGET_TIMEOUT_MS, requestTimeoutMs));
    }

    static boolean isHttpUrl(String value) {
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
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static String stringOrEmpty(JSONObject object, String key) {
        Object value = object.opt(key);
        return value instanceof String ? (String) value : "";
    }

    private static int intOrDefault(JSONObject object, String key, int fallback) {
        Object value = object.opt(key);
        if (value instanceof Number) {
            return ((Number) value).intValue();
        }
        return fallback;
    }
}
