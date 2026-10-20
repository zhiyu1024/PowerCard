/**
 * Android 原生模式启动器。
 *
 * 普通浏览器：检测不到 window.PowerCardNative，本文件什么都不做，原有 PWA 行为不变。
 * APK WebView：把 /api/* 的 fetch 转给原生桥（Android Java 直接发 HTTP），
 * 并对现有 app.js 保持与 docs/api-contract.md 完全一致的响应结构。
 */
import { createNativeApi } from "./shared/native-api.js";

const native = window.PowerCardNative;

if (native && typeof native.getConfigJson === "function" && typeof native.httpGet === "function") {
  window.__POWERCARD_NATIVE__ = true;

  let seq = 0;
  const pending = new Map();

  const bridge = {
    getConfigJson() {
      try {
        return native.getConfigJson() || "{}";
      } catch {
        return "{}";
      }
    },
    saveConfigJson(json) {
      try {
        return native.saveConfigJson(String(json)) === true;
      } catch {
        return false;
      }
    },
    httpGet(url, timeoutMs) {
      return new Promise((resolve) => {
        const id = `req_${Date.now()}_${++seq}`;
        const timer = window.setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          resolve({
            ok: false,
            status: null,
            contentType: "",
            body: "",
            truncated: false,
            latencyMs: timeoutMs,
            error: { code: "TIMEOUT", message: `请求超时（${timeoutMs} ms）` },
          });
        }, Math.max(5000, timeoutMs + 4000));

        pending.set(id, { resolve, timer });

        try {
          native.httpGet(id, String(url), Number(timeoutMs) || 5000);
        } catch (error) {
          window.clearTimeout(timer);
          pending.delete(id);
          resolve({
            ok: false,
            status: null,
            contentType: "",
            body: "",
            truncated: false,
            latencyMs: 0,
            error: {
              code: "NETWORK",
              message: (error && error.message) || "原生网络请求失败",
            },
          });
        }
      });
    },
    version: (() => {
      try {
        return native.getAppVersion ? native.getAppVersion() : "1.0.0";
      } catch {
        return "1.0.0";
      }
    })(),
  };

  // Java 侧 evaluateJavascript 会调用这个函数：
  // window.__powercardHttpResult("req_1", { ok:true, status:200, ... })
  window.__powercardHttpResult = (requestId, result) => {
    const entry = pending.get(String(requestId));
    if (!entry) return;
    pending.delete(String(requestId));
    window.clearTimeout(entry.timer);
    if (typeof result === "string") {
      try {
        result = JSON.parse(result);
      } catch {
        result = null;
      }
    }
    if (!result || typeof result !== "object") {
      entry.resolve({
        ok: false,
        status: null,
        contentType: "",
        body: "",
        truncated: false,
        latencyMs: 0,
        error: { code: "NETWORK", message: "原生网络请求没有返回有效结果" },
      });
      return;
    }
    entry.resolve(result);
  };

  const api = createNativeApi(bridge);
  const originalFetch = window.fetch.bind(window);

  window.fetch = function nativeFetch(input, init = {}) {
    const raw = typeof input === "string" ? input : input && input.url;
    if (typeof raw === "string" && raw.startsWith("/api/")) {
      return api.handleApiRequest(raw, init);
    }
    return originalFetch(input, init);
  };

  // Android 返回键：先让网页关闭设置抽屉 / 确认框；返回 true 表示已消费。
  window.__powercardBack = function powercardBack() {
    const dialog = document.querySelector("dialog[open]");
    if (!dialog) return false;
    if (dialog.id === "settingsDialog") {
      const close = document.getElementById("settingsClose");
      if (close) {
        close.click();
        return true;
      }
    }
    if (dialog.id === "confirmDialog") {
      const cancel = document.getElementById("confirmCancel");
      if (cancel) {
        cancel.click();
        return true;
      }
    }
    return false;
  };

  // 便于调试面板显示，不暴露配置内容。
  window.__POWERCARD_NATIVE_VERSION__ = bridge.version;
}
