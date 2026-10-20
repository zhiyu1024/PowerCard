/**
 * Android 原生模式的 /api 兼容层（可在 Node 中单测，不依赖 window）。
 *
 * 设计目标：让现有 public/app.js 完全无感知地跑在 APK 的 WebView 里。
 * - 配置通过原生桥加密存取；
 * - 设备请求通过原生桥直接走手机网络（无 CORS）；
 * - 状态解析复用 public/shared/parser.js；
 * - 返回标准 Response，响应体与 docs/api-contract.md 一致。
 */
import { parseStatusResponse, powerLabel } from "./parser.js";

const DEFAULT_CONFIG = Object.freeze({
  statusUrl: "",
  powerOnUrl: "",
  powerOffUrl: "",
  rebootUrl: "",
  lanAddress: "",
  wanAddress: "",
  subnetMask: "",
  gateway: "",
  macAddress: "",
  pollIntervalSec: 10,
  requestTimeoutMs: 5000,
  confirmActions: true,
  powerField: "",
  onlineField: "",
});

const URL_FIELDS = ["statusUrl", "powerOnUrl", "powerOffUrl", "rebootUrl"];
const PROFILE_FIELDS = [
  "wanAddress",
  "lanAddress",
  "subnetMask",
  "gateway",
  "macAddress",
  "powerField",
  "onlineField",
];
const ACTION_META = {
  on: { urlKey: "powerOnUrl", label: "开机" },
  off: { urlKey: "powerOffUrl", label: "关机" },
  reboot: { urlKey: "rebootUrl", label: "重启" },
};
const STATUS_CACHE_TTL_MS = 1500;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function nowIso() {
  return new Date().toISOString();
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizeMac(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const compact = text.replace(/[:-]/g, "").replace(/\./g, "");
  if (!/^[0-9a-fA-F]{12}$/.test(compact)) return text;
  return compact.toUpperCase().match(/.{2}/g).join(":");
}

export function normalizeConfig(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const config = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (key === "confirmActions") {
      config[key] = value === true || value === "true";
    } else if (key === "pollIntervalSec" || key === "requestTimeoutMs") {
      const number = Number(value);
      config[key] = Number.isFinite(number) ? number : DEFAULT_CONFIG[key];
    } else {
      config[key] = String(value).trim();
    }
  }
  config.pollIntervalSec = clamp(Math.round(config.pollIntervalSec), 5, 300);
  config.requestTimeoutMs = clamp(Math.round(config.requestTimeoutMs), 1000, 30000);
  config.macAddress = normalizeMac(config.macAddress);
  return config;
}

function isDemoConfig(config) {
  return !config.statusUrl && !config.powerOnUrl && !config.powerOffUrl && !config.rebootUrl;
}

function validateHttpUrl(value) {
  if (!value) return "";
  if (value.length > 2048) return "URL 不能超过 2048 个字符";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "URL 必须以 http:// 或 https:// 开头";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "URL 必须以 http:// 或 https:// 开头";
  }
  if (url.hash) return "URL 不能包含 # 片段";
  return "";
}

function validateConfig(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const config = normalizeConfig(raw);
  const errors = {};
  for (const key of URL_FIELDS) {
    const message = validateHttpUrl(config[key]);
    if (message) errors[key] = message;
  }
  for (const key of PROFILE_FIELDS) {
    if (config[key].length > 255) errors[key] = "不能超过 255 个字符";
  }
  const rawPoll = source.pollIntervalSec;
  if (
    rawPoll !== undefined &&
    rawPoll !== null &&
    (!Number.isInteger(Number(rawPoll)) || Number(rawPoll) < 5 || Number(rawPoll) > 300)
  ) {
    errors.pollIntervalSec = "轮询间隔需为 5–300 秒";
  }
  const rawTimeout = source.requestTimeoutMs;
  if (
    rawTimeout !== undefined &&
    rawTimeout !== null &&
    (!Number.isInteger(Number(rawTimeout)) || Number(rawTimeout) < 1000 || Number(rawTimeout) > 30000)
  ) {
    errors.requestTimeoutMs = "请求超时需为 1000–30000 毫秒";
  }
  return { config, errors };
}

function rawOf(result) {
  if (!result || typeof result.body !== "string") return null;
  return {
    contentType: typeof result.contentType === "string" ? result.contentType : "text/plain",
    body: result.body,
    truncated: result.truncated === true,
  };
}

function errorOf(result, fallbackMessage) {
  if (result && result.error && typeof result.error === "object") {
    return {
      code: result.error.code || "NETWORK",
      message: result.error.message || fallbackMessage || "请求失败",
    };
  }
  return { code: "NETWORK", message: fallbackMessage || "请求失败" };
}

/**
 * @param {{
 *   getConfigJson: () => string,
 *   saveConfigJson: (json: string) => boolean,
 *   httpGet: (url: string, timeoutMs: number) => Promise<object>,
 *   version?: string,
 *   now?: () => number,
 *   delay?: (ms: number) => Promise<void>
 * }} bridge
 */
export function createNativeApi(bridge) {
  if (!bridge || typeof bridge.httpGet !== "function") {
    throw new Error("createNativeApi 需要 httpGet");
  }
  const now = typeof bridge.now === "function" ? bridge.now : Date.now;
  const delay =
    typeof bridge.delay === "function"
      ? bridge.delay
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const version = bridge.version || "1.0.0";

  const demo = { power: "on", online: true };
  const statusCache = { key: null, at: 0, payload: null };
  const logs = [];
  let logSeq = 0;

  function clearStatusCache() {
    statusCache.key = null;
    statusCache.at = 0;
    statusCache.payload = null;
  }

  function readConfig() {
    let raw = {};
    try {
      const text = bridge.getConfigJson();
      if (typeof text === "string" && text.trim()) raw = JSON.parse(text);
    } catch {
      raw = {};
    }
    return normalizeConfig(raw);
  }

  function writeConfig(config) {
    const ok = bridge.saveConfigJson(JSON.stringify(config));
    if (!ok) throw new Error("配置保存失败");
    clearStatusCache();
  }

  function recordLog(kind, { url, httpStatus = null, ok, latencyMs = 0, error = null, raw = null }) {
    logSeq += 1;
    logs.unshift({
      id: `l_${now()}_${logSeq}`,
      at: nowIso(),
      kind,
      method: "GET",
      url,
      httpStatus,
      ok,
      latencyMs,
      error,
      rawPreview: raw && raw.body ? String(raw.body).slice(0, 300) : "",
    });
    if (logs.length > 30) logs.length = 30;
  }

  function failurePayload({ mode, sourceUrl = null, error, latencyMs = 0, httpStatus = null, raw = null }) {
    return {
      ok: false,
      mode,
      online: false,
      onlineInferred: false,
      power: "unknown",
      powerLabel: powerLabel("unknown"),
      latencyMs,
      fetchedAt: nowIso(),
      sourceUrl,
      httpStatus,
      raw,
      mapping: null,
      warning: null,
      error,
    };
  }

  function demoStatus() {
    const payload = {
      ok: true,
      mode: "demo",
      online: demo.online,
      onlineInferred: false,
      power: demo.power,
      powerLabel: powerLabel(demo.power),
      latencyMs: 0,
      fetchedAt: nowIso(),
      sourceUrl: null,
      httpStatus: null,
      raw: {
        contentType: "application/json",
        body: JSON.stringify({ demo: true, online: demo.online, power: demo.power }),
        truncated: false,
      },
      mapping: null,
      warning: null,
      error: null,
    };
    recordLog("status", { url: null, ok: true, latencyMs: 0, raw: payload.raw });
    return payload;
  }

  async function runStatus({ mode, sourceUrl, powerField, onlineField, timeoutMs, kind }) {
    const result = await bridge.httpGet(sourceUrl, timeoutMs);
    let payload;
    if (!result || result.ok !== true) {
      payload = failurePayload({
        mode,
        sourceUrl,
        error: errorOf(result, `请求 ${sourceUrl} 失败`),
        latencyMs: Number(result && result.latencyMs) || 0,
        httpStatus: result && Number.isInteger(result.status) ? result.status : null,
        raw: rawOf(result),
      });
    } else {
      const raw = rawOf(result);
      const parsed = parseStatusResponse({
        text: raw ? raw.body : "",
        contentType: raw ? raw.contentType : "",
        powerField,
        onlineField,
      });
      payload = {
        ok: true,
        mode,
        online: parsed.online,
        onlineInferred: parsed.onlineInferred,
        power: parsed.power,
        powerLabel: powerLabel(parsed.power),
        latencyMs: Number(result.latencyMs) || 0,
        fetchedAt: nowIso(),
        sourceUrl,
        httpStatus: Number.isInteger(result.status) ? result.status : 200,
        raw,
        mapping: parsed.mapping,
        warning: parsed.warning,
        error: null,
      };
    }
    recordLog(kind, {
      url: sourceUrl,
      httpStatus: payload.httpStatus,
      ok: payload.ok,
      latencyMs: payload.latencyMs,
      error: payload.error,
      raw: payload.raw,
    });
    return payload;
  }

  async function handleConfig(method, init) {
    if (method === "GET") {
      const config = readConfig();
      return jsonResponse({ ok: true, config, mode: isDemoConfig(config) ? "demo" : "live" });
    }
    if (method === "PUT") {
      let input;
      try {
        input = JSON.parse(String(init.body || "{}"));
      } catch {
        return jsonResponse(
          { ok: false, error: { code: "VALIDATION", message: "请求体不是合法 JSON", fields: {} } },
          400,
        );
      }
      const { config, errors } = validateConfig(input);
      if (Object.keys(errors).length > 0) {
        return jsonResponse(
          {
            ok: false,
            error: {
              code: "VALIDATION",
              message: `有 ${Object.keys(errors).length} 项设置需要检查`,
              fields: errors,
            },
          },
          400,
        );
      }
      try {
        writeConfig(config);
      } catch (error) {
        return jsonResponse(
          { ok: false, error: { code: "INTERNAL", message: error.message || "配置保存失败" } },
          500,
        );
      }
      return jsonResponse({ ok: true, config, mode: isDemoConfig(config) ? "demo" : "live" });
    }
    return methodNotAllowed("GET, PUT");
  }

  async function handleStatus(url) {
    const config = readConfig();
    const mode = isDemoConfig(config) ? "demo" : "live";
    if (mode === "demo") return jsonResponse(demoStatus());
    if (!config.statusUrl) {
      return jsonResponse(
        failurePayload({ mode, error: { code: "CONFIG", message: "尚未配置状态接口 URL" } }),
      );
    }
    const refresh = url.searchParams.get("refresh") === "1";
    const cacheKey = `${config.statusUrl}\u0000${config.powerField}\u0000${config.onlineField}\u0000${config.requestTimeoutMs}`;
    if (!refresh && statusCache.key === cacheKey && now() - statusCache.at < STATUS_CACHE_TTL_MS) {
      return jsonResponse(statusCache.payload);
    }
    const payload = await runStatus({
      mode,
      sourceUrl: config.statusUrl,
      powerField: config.powerField,
      onlineField: config.onlineField,
      timeoutMs: config.requestTimeoutMs,
      kind: "status",
    });
    if (!refresh && payload.ok) {
      statusCache.key = cacheKey;
      statusCache.at = now();
      statusCache.payload = payload;
    }
    return jsonResponse(payload);
  }

  async function handleCommand(init) {
    let input;
    try {
      input = JSON.parse(String(init.body || "{}"));
    } catch {
      return jsonResponse(
        { ok: false, error: { code: "VALIDATION", message: "请求体不是合法 JSON", fields: {} } },
        400,
      );
    }
    const action = input && input.action;
    const meta = ACTION_META[action];
    if (!meta) {
      return jsonResponse(
        {
          ok: false,
          error: { code: "VALIDATION", message: "action 必须为 on、off 或 reboot", fields: {} },
        },
        400,
      );
    }
    const config = readConfig();
    const mode = isDemoConfig(config) ? "demo" : "live";
    if (mode === "demo") {
      await delay(600);
      if (action === "off") demo.power = "off";
      else demo.power = "on";
      demo.online = true;
      const raw = {
        contentType: "application/json",
        body: JSON.stringify({ demo: true, online: demo.online, power: demo.power }),
        truncated: false,
      };
      const payload = {
        ok: true,
        mode: "demo",
        action,
        message: `${meta.label}指令已发送`,
        latencyMs: 600,
        httpStatus: null,
        sourceUrl: null,
        raw,
        error: null,
      };
      recordLog("command", { url: null, ok: true, latencyMs: 600, raw });
      return jsonResponse(payload);
    }
    const target = config[meta.urlKey];
    if (!target) {
      return jsonResponse({
        ok: false,
        mode: "live",
        action,
        message: `${meta.label}指令发送失败`,
        latencyMs: 0,
        httpStatus: null,
        sourceUrl: null,
        raw: null,
        error: { code: "CONFIG", message: `尚未配置${meta.label}接口 URL` },
      });
    }
    const result = await bridge.httpGet(target, config.requestTimeoutMs);
    const ok = result && result.ok === true;
    const payload = {
      ok,
      mode: "live",
      action,
      message: `${meta.label}指令${ok ? "已发送" : "发送失败"}`,
      latencyMs: Number(result && result.latencyMs) || 0,
      httpStatus: result && Number.isInteger(result.status) ? result.status : null,
      sourceUrl: target,
      raw: rawOf(result),
      error: ok ? null : errorOf(result, `${meta.label}指令发送失败`),
    };
    recordLog("command", {
      url: target,
      httpStatus: payload.httpStatus,
      ok,
      latencyMs: payload.latencyMs,
      error: payload.error,
      raw: payload.raw,
    });
    return jsonResponse(payload);
  }

  async function handleTest(init) {
    let input;
    try {
      input = JSON.parse(String(init.body || "{}"));
    } catch {
      return jsonResponse({ ok: false, error: { code: "VALIDATION", message: "请求体不是合法 JSON" } }, 400);
    }
    const statusUrl = typeof input.statusUrl === "string" ? input.statusUrl.trim() : "";
    const powerField = typeof input.powerField === "string" ? input.powerField.trim() : "";
    const onlineField = typeof input.onlineField === "string" ? input.onlineField.trim() : "";
    const requestedTimeout = Number(input.requestTimeoutMs);
    const timeoutMs =
      Number.isInteger(requestedTimeout) && requestedTimeout >= 1000 && requestedTimeout <= 30000
        ? requestedTimeout
        : 5000;
    if (!statusUrl) {
      return jsonResponse(
        failurePayload({ mode: "test", error: { code: "CONFIG", message: "尚未配置状态接口 URL" } }),
      );
    }
    const urlError = validateHttpUrl(statusUrl);
    if (urlError) {
      return jsonResponse(
        failurePayload({
          mode: "test",
          sourceUrl: statusUrl,
          error: { code: "INVALID_URL", message: urlError },
        }),
      );
    }
    const payload = await runStatus({
      mode: "test",
      sourceUrl: statusUrl,
      powerField,
      onlineField,
      timeoutMs,
      kind: "test",
    });
    return jsonResponse(payload);
  }

  function methodNotAllowed(allow) {
    return new Response(
      JSON.stringify({ ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "请求方法不被允许" } }),
      {
        status: 405,
        headers: { "Content-Type": "application/json; charset=utf-8", Allow: allow },
      },
    );
  }

  /**
   * @param {string} input 形如 /api/status?refresh=1
   * @param {{method?: string, body?: string|Uint8Array, signal?: AbortSignal}} [init]
   * @returns {Promise<Response>}
   */
  async function handleApiRequest(input, init = {}) {
    const method = String(init.method || "GET").toUpperCase();
    let url;
    try {
      url = new URL(String(input), "https://appassets.androidplatform.net");
    } catch {
      return jsonResponse({ ok: false, error: { code: "BAD_REQUEST", message: "请求地址无效" } }, 400);
    }
    const path = url.pathname;
    try {
      if (path === "/api/health" && method === "GET") {
        return jsonResponse({ ok: true, app: "powercard-remote", version, uptimeSec: 0 });
      }
      if (path === "/api/config") return handleConfig(method, init);
      if (path === "/api/status" && method === "GET") return handleStatus(url);
      if (path === "/api/command" && method === "POST") return handleCommand(init);
      if (path === "/api/test" && method === "POST") return handleTest(init);
      if (path === "/api/logs" && method === "GET") {
        return jsonResponse({ ok: true, logs: logs.map((item) => ({ ...item })) });
      }
      if (path === "/api/status" || path === "/api/command" || path === "/api/test") {
        return methodNotAllowed(
          path === "/api/status" ? "GET" : "POST",
        );
      }
      return jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } }, 404);
    } catch (error) {
      return jsonResponse(
        { ok: false, error: { code: "INTERNAL", message: error && error.message ? error.message : "原生接口错误" } },
        500,
      );
    }
  }

  return {
    handleApiRequest,
    getConfig: readConfig,
    handleConfig,
    handleStatus,
    handleCommand,
    handleTest,
    getLogs: () => logs.map((item) => ({ ...item })),
    getMode: () => (isDemoConfig(readConfig()) ? "demo" : "live"),
  };
}

export { DEFAULT_CONFIG, STATUS_CACHE_TTL_MS, isDemoConfig };
