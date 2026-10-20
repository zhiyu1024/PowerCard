/**
 * HTTP 应用与路由：/api/* 接口、静态资源、安全响应头。
 *
 * 本文件只做“路由编排 + 响应拼装”，具体能力分别放在：
 * - config.js  配置读取 / 校验 / 原子持久化
 * - parser.js  设备状态解析
 * - device.js  设备请求（只用 GET、超时、错误映射）
 * - demo.js    演示模式模拟设备
 * - logs.js    内存环形请求日志
 * - static.js  public/ 静态服务与 SPA fallback
 */
import http from 'node:http';
import {
  ConfigStore,
  isDemoConfig,
  validateConfig,
  validateHttpUrl,
} from './config.js';
import { parseStatusResponse, powerLabel } from './parser.js';
import { fetchDevice } from './device.js';
import { DemoDevice } from './demo.js';
import { RequestLog } from './logs.js';
import { readJsonBody, sendJson } from './http.js';
import { serveStatic } from './static.js';
import { APP_NAME, APP_VERSION, DEFAULT_CONFIG_PATH, DEFAULT_PUBLIC_DIR } from './version.js';

/** 状态短缓存时长：刷新按钮 / refresh=1 可绕过（契约第 4 节 GET /api/status）。 */
export const STATUS_CACHE_TTL_MS = 1500;

/** 指令动作与配置字段、中文名的映射。只允许这三个动作。 */
const ACTION_META = Object.freeze({
  on: { urlKey: 'powerOnUrl', label: '开机' },
  off: { urlKey: 'powerOffUrl', label: '关机' },
  reboot: { urlKey: 'rebootUrl', label: '重启' },
});
const ACTION_NAMES = Object.freeze(Object.keys(ACTION_META));

/** 演示模式判定 → "demo" | "live"。 */
function currentMode(config) {
  return isDemoConfig(config) ? 'demo' : 'live';
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 构造“请求设备失败”时的状态响应（HTTP 仍为 200，ok:false）。
 * @param {{mode: string, sourceUrl?: string|null, error: {code: string, message: string}, latencyMs?: number, httpStatus?: number|null, raw?: object|null}} input
 */
function statusFailurePayload({ mode, sourceUrl = null, error, latencyMs = 0, httpStatus = null, raw = null }) {
  return {
    ok: false,
    mode,
    online: false,
    onlineInferred: false,
    power: 'unknown',
    powerLabel: powerLabel('unknown'),
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

/**
 * 创建应用（可独立于 http.Server 测试）。
 *
 * @param {object} [options]
 * @param {string} [options.configPath]  配置文件路径，默认 data/config.json
 * @param {string} [options.publicDir]   静态资源目录，默认 public/
 * @param {DemoDevice} [options.demoDevice] 演示设备实例（测试可注入更短延迟）
 * @param {(message: string) => void} [options.warn] 警告输出（测试可静音）
 * @returns {{
 *   handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>,
 *   store: ConfigStore,
 *   demo: DemoDevice,
 *   logs: RequestLog,
 *   configPath: string,
 *   publicDir: string,
 * }}
 */
export function createApp(options = {}) {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const warn = typeof options.warn === 'function' ? options.warn : (message) => console.warn(`[powercard] ${message}`);

  const store = new ConfigStore(configPath, { warn });
  store.load();

  const demoDevice = options.demoDevice instanceof DemoDevice ? options.demoDevice : new DemoDevice(options.demo ?? {});
  const logs = new RequestLog(options.logLimit ?? 30);

  // 1.5s 短缓存只保存“成功”的 live 状态响应；配置变更时清空。
  const statusCache = { key: null, at: 0, payload: null };
  function clearStatusCache() {
    statusCache.key = null;
    statusCache.at = 0;
    statusCache.payload = null;
  }

  /** 记录一条设备请求日志。 */
  function recordLog(kind, { url, method = 'GET', httpStatus = null, ok, latencyMs = 0, error = null, raw = null }) {
    logs.add({ kind, method, url, httpStatus, ok, latencyMs, error, raw });
  }

  /**
   * 请求设备状态并拼装契约响应。
   * @param {{mode: string, sourceUrl: string, powerField?: string, onlineField?: string, timeoutMs: number, useCache?: boolean, kind: 'status'|'test'}} input
   */
  async function runStatus({ mode, sourceUrl, powerField = '', onlineField = '', timeoutMs, useCache = false, kind = 'status' }) {
    const cacheKey = `${sourceUrl}\u0000${powerField}\u0000${onlineField}\u0000${timeoutMs}`;
    if (useCache && statusCache.key === cacheKey && Date.now() - statusCache.at < STATUS_CACHE_TTL_MS) {
      // 命中短缓存：不再访问设备，也不再写日志（没有发生真实请求）。
      return statusCache.payload;
    }

    const result = await fetchDevice(sourceUrl, { timeoutMs });
    let payload;

    if (!result.ok) {
      payload = statusFailurePayload({
        mode,
        sourceUrl,
        error: result.error,
        latencyMs: result.latencyMs,
        httpStatus: result.httpStatus,
        raw: result.raw,
      });
    } else {
      const parsed = parseStatusResponse({
        text: result.raw.body,
        contentType: result.raw.contentType,
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
        latencyMs: result.latencyMs,
        fetchedAt: nowIso(),
        sourceUrl,
        httpStatus: result.httpStatus,
        raw: result.raw,
        mapping: parsed.mapping,
        warning: parsed.warning,
        error: null,
      };
    }

    recordLog(kind, {
      url: sourceUrl,
      method: 'GET',
      httpStatus: payload.httpStatus,
      ok: payload.ok,
      latencyMs: payload.latencyMs,
      error: payload.error,
      raw: payload.raw,
    });

    if (useCache && payload.ok) {
      statusCache.key = cacheKey;
      statusCache.at = Date.now();
      statusCache.payload = payload;
    }
    return payload;
  }

  /** 演示模式的状态响应：立即返回内存中的模拟状态。 */
  function buildDemoStatus() {
    const snapshot = demoDevice.snapshot();
    const raw = { contentType: 'application/json', body: demoDevice.statusRaw(), truncated: false };
    const payload = {
      ok: true,
      mode: 'demo',
      online: snapshot.online,
      onlineInferred: false,
      power: snapshot.power,
      powerLabel: powerLabel(snapshot.power),
      latencyMs: 0,
      fetchedAt: nowIso(),
      sourceUrl: null,
      httpStatus: null,
      raw,
      mapping: null,
      warning: null,
      error: null,
    };
    recordLog('status', { url: null, method: 'GET', ok: true, latencyMs: 0, raw });
    return payload;
  }

  // ---------------------------------------------------------------------------
  // 各接口实现
  // ---------------------------------------------------------------------------

  function handleGetConfig(_request, response) {
    const config = store.get();
    sendJson(response, 200, { ok: true, config, mode: currentMode(config) });
  }

  async function handlePutConfig(request, response) {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendJson(response, body.status, { ok: false, error: body.error });
      return;
    }

    const result = validateConfig(body.value);
    if (!result.ok) {
      sendJson(response, 400, {
        ok: false,
        error: { code: 'VALIDATION', message: result.message, fields: result.fields },
      });
      return;
    }

    try {
      await store.save(result.config);
    } catch (error) {
      warn(`保存配置失败：${error?.message || error}`);
      sendJson(response, 500, { ok: false, error: { code: 'INTERNAL', message: '配置保存失败，请检查 data 目录权限' } });
      return;
    }

    clearStatusCache();
    sendJson(response, 200, { ok: true, config: store.get(), mode: currentMode(result.config) });
  }

  async function handleGetStatus(_request, response, parsedUrl) {
    const config = store.get();
    const mode = currentMode(config);

    if (mode === 'demo') {
      sendJson(response, 200, buildDemoStatus());
      return;
    }

    // live 模式但状态 URL 未配置（例如只配置了开机 URL）
    if (!config.statusUrl) {
      sendJson(response, 200, statusFailurePayload({
        mode,
        error: { code: 'CONFIG', message: '尚未配置状态接口 URL' },
      }));
      return;
    }

    const refresh = parsedUrl.searchParams.get('refresh') === '1';
    const payload = await runStatus({
      mode,
      sourceUrl: config.statusUrl,
      powerField: config.powerField,
      onlineField: config.onlineField,
      timeoutMs: config.requestTimeoutMs,
      useCache: !refresh,
      kind: 'status',
    });
    sendJson(response, 200, payload);
  }

  async function handlePostCommand(request, response) {
    const body = await readJsonBody(request, { limit: 16 * 1024 });
    if (!body.ok) {
      sendJson(response, body.status, { ok: false, error: body.error });
      return;
    }

    const input = body.value && typeof body.value === 'object' && !Array.isArray(body.value) ? body.value : {};
    const action = input.action;
    if (!ACTION_NAMES.includes(action)) {
      const message = 'action 必须为 on、off 或 reboot';
      sendJson(response, 400, {
        ok: false,
        error: { code: 'VALIDATION', message, fields: { action: message } },
      });
      return;
    }

    const meta = ACTION_META[action];
    const config = store.get();
    const mode = currentMode(config);

    // 演示模式：延迟约 600ms 后改变内存状态
    if (mode === 'demo') {
      const result = await demoDevice.execute(action);
      const raw = { contentType: 'application/json', body: result.rawBody, truncated: false };
      const payload = {
        ok: true,
        mode: 'demo',
        action,
        message: `${meta.label}指令已发送`,
        latencyMs: result.latencyMs,
        httpStatus: null,
        sourceUrl: null,
        raw,
        error: null,
      };
      recordLog('command', { url: null, method: 'GET', ok: true, latencyMs: result.latencyMs, raw });
      sendJson(response, 200, payload);
      return;
    }

    const target = config[meta.urlKey];

    // 未配置对应 URL：仍是 200，ok:false，error.code = CONFIG
    if (!target) {
      sendJson(response, 200, {
        ok: false,
        mode: 'live',
        action,
        message: `${meta.label}指令发送失败`,
        latencyMs: 0,
        httpStatus: null,
        sourceUrl: null,
        raw: null,
        error: { code: 'CONFIG', message: `尚未配置${meta.label}接口 URL` },
      });
      return;
    }

    const result = await fetchDevice(target, { timeoutMs: config.requestTimeoutMs });
    const ok = result.ok;
    const payload = {
      ok,
      mode: 'live',
      action,
      message: `${meta.label}指令${ok ? '已发送' : '发送失败'}`,
      latencyMs: result.latencyMs,
      httpStatus: result.httpStatus ?? null,
      sourceUrl: target,
      raw: result.raw ?? null,
      error: result.error ?? null,
    };
    recordLog('command', {
      url: target,
      method: 'GET',
      httpStatus: payload.httpStatus,
      ok,
      latencyMs: result.latencyMs,
      error: payload.error,
      raw: payload.raw,
    });
    sendJson(response, 200, payload);
  }

  async function handlePostTest(request, response) {
    const body = await readJsonBody(request, { limit: 16 * 1024 });
    if (!body.ok) {
      sendJson(response, body.status, { ok: false, error: body.error });
      return;
    }

    const input = body.value && typeof body.value === 'object' && !Array.isArray(body.value) ? body.value : {};
    const rawUrl = typeof input.statusUrl === 'string' ? input.statusUrl.trim() : '';
    const powerField = typeof input.powerField === 'string' ? input.powerField.trim() : '';
    const onlineField = typeof input.onlineField === 'string' ? input.onlineField.trim() : '';
    // 测试接口不保存配置；超时值非法时退回默认 5000ms，不因此报 400。
    const requestedTimeout = input.requestTimeoutMs;
    const timeoutMs =
      Number.isInteger(requestedTimeout) && requestedTimeout >= 1000 && requestedTimeout <= 30000
        ? requestedTimeout
        : 5000;

    if (!rawUrl) {
      sendJson(response, 200, statusFailurePayload({
        mode: 'test',
        error: { code: 'CONFIG', message: '尚未配置状态接口 URL' },
      }));
      return;
    }

    const checked = validateHttpUrl(rawUrl);
    if (!checked.ok) {
      sendJson(response, 200, statusFailurePayload({
        mode: 'test',
        sourceUrl: rawUrl,
        error: { code: 'INVALID_URL', message: checked.error },
      }));
      return;
    }

    const payload = await runStatus({
      mode: 'test',
      sourceUrl: checked.value,
      powerField,
      onlineField,
      timeoutMs,
      useCache: false,
      kind: 'test',
    });
    sendJson(response, 200, payload);
  }

  function methodNotAllowed(response, allow) {
    sendJson(
      response,
      405,
      { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不被允许' } },
      { headers: { Allow: allow } },
    );
  }

  async function handleApi(request, response, pathname, parsedUrl) {
    const method = request.method || 'GET';
    switch (pathname) {
      case '/api/health':
        if (method !== 'GET') return methodNotAllowed(response, 'GET');
        sendJson(response, 200, {
          ok: true,
          app: APP_NAME,
          version: APP_VERSION,
          uptimeSec: Math.floor(process.uptime()),
        });
        return;
      case '/api/config':
        if (method === 'GET') return handleGetConfig(request, response);
        if (method === 'PUT') return handlePutConfig(request, response);
        return methodNotAllowed(response, 'GET, PUT');
      case '/api/status':
        if (method !== 'GET') return methodNotAllowed(response, 'GET');
        return handleGetStatus(request, response, parsedUrl);
      case '/api/command':
        if (method !== 'POST') return methodNotAllowed(response, 'POST');
        return handlePostCommand(request, response);
      case '/api/test':
        if (method !== 'POST') return methodNotAllowed(response, 'POST');
        return handlePostTest(request, response);
      case '/api/logs':
        if (method !== 'GET') return methodNotAllowed(response, 'GET');
        sendJson(response, 200, { ok: true, logs: logs.list() });
        return;
      default:
        sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: '接口不存在' } });
    }
  }

  async function routeRequest(request, response) {
    const requestUrl = request.url || '/';
    let parsedUrl;
    try {
      // 用固定 base 解析，避免依赖 Host 头；只关心 pathname / searchParams。
      parsedUrl = new URL(requestUrl, 'http://localhost');
    } catch {
      sendJson(response, 400, { ok: false, error: { code: 'BAD_REQUEST', message: '请求地址无效' } });
      return;
    }

    const pathname = parsedUrl.pathname;
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await handleApi(request, response, pathname, parsedUrl);
      return;
    }
    await serveStatic(request, response, { publicDir });
  }

  const handler = async (request, response) => {
    try {
      await routeRequest(request, response);
    } catch (error) {
      warn(`处理请求失败：${error?.stack || error}`);
      if (!response.headersSent) {
        sendJson(response, 500, { ok: false, error: { code: 'INTERNAL', message: '服务器内部错误' } });
      } else {
        response.destroy();
      }
    }
  };

  return { handler, store, demo: demoDevice, logs, configPath, publicDir };
}

/**
 * 创建 HTTP 服务（供 start.js 与测试使用）。
 * @param {Parameters<typeof createApp>[0]} [options]
 * @returns {import('node:http').Server & {app: ReturnType<typeof createApp>}}
 */
export function createServer(options = {}) {
  const app = createApp(options);
  const server = http.createServer(app.handler);
  // 挂到 server 上便于启动脚本打印模式、测试读取状态。
  server.app = app;
  return server;
}
