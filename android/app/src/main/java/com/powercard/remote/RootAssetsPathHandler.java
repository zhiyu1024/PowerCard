package com.powercard.remote;

import android.content.res.AssetManager;
import android.webkit.WebResourceResponse;

import androidx.webkit.WebViewAssetLoader;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

/**
 * 把根路径（如 /styles.css、/app.js、/icons/icon-192.png）映射到 assets/public/。
 *
 * <p>契约要求页面地址为
 * https://appassets.androidplatform.net/assets/public/index.html，
 * 由 {@link WebViewAssetLoader} 的 /assets/ 处理器加载；而 public/index.html 内使用
 * 以 "/" 开头的绝对路径引用同目录资源，因此这里作为兜底把根路径映射到同一份
 * assets/public/ 资源，无需修改前端代码。</p>
 */
final class RootAssetsPathHandler implements WebViewAssetLoader.PathHandler {

    private static final String ASSET_ROOT = "public/";

    private final AssetManager assets;

    RootAssetsPathHandler(AssetManager assets) {
        this.assets = assets;
    }

    @Override
    public WebResourceResponse handle(String path) {
        String relative = normalize(path);
        if (relative == null) {
            return null;
        }
        String assetPath = ASSET_ROOT + relative;
        try {
            InputStream stream = assets.open(assetPath, AssetManager.ACCESS_STREAMING);
            return new WebResourceResponse(mimeType(assetPath), encodingFor(assetPath), stream);
        } catch (IOException e) {
            return null;
        }
    }

    private static String normalize(String path) {
        if (path == null) {
            return null;
        }
        String relative = path;
        while (relative.startsWith("/")) {
            relative = relative.substring(1);
        }
        if (relative.isEmpty()) {
            return "index.html";
        }
        // 路径穿越防护：assets 是只读压缩资源，这里显式拒绝可疑路径
        if (relative.contains("..") || relative.contains("\\") || relative.indexOf('\0') >= 0) {
            return null;
        }
        return relative;
    }

    private static String mimeType(String path) {
        String lower = path.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html") || lower.endsWith(".htm")) {
            return "text/html";
        }
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) {
            return "application/javascript";
        }
        if (lower.endsWith(".css")) {
            return "text/css";
        }
        if (lower.endsWith(".json")) {
            return "application/json";
        }
        if (lower.endsWith(".webmanifest")) {
            return "application/manifest+json";
        }
        if (lower.endsWith(".svg")) {
            return "image/svg+xml";
        }
        if (lower.endsWith(".png")) {
            return "image/png";
        }
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (lower.endsWith(".webp")) {
            return "image/webp";
        }
        if (lower.endsWith(".ico")) {
            return "image/x-icon";
        }
        if (lower.endsWith(".woff2")) {
            return "font/woff2";
        }
        if (lower.endsWith(".woff")) {
            return "font/woff";
        }
        if (lower.endsWith(".ttf")) {
            return "font/ttf";
        }
        if (lower.endsWith(".txt") || lower.endsWith(".map")) {
            return "text/plain";
        }
        return "application/octet-stream";
    }

    private static String encodingFor(String path) {
        String mime = mimeType(path);
        if (mime.startsWith("text/")
                || "application/javascript".equals(mime)
                || "application/json".equals(mime)
                || "application/manifest+json".equals(mime)
                || "image/svg+xml".equals(mime)) {
            return "UTF-8";
        }
        return null;
    }
}
