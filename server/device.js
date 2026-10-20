/**
 * 设备访问层：只用 GET 访问开机卡，统一处理超时、网络错误、非 2xx 与响应体截断。
 *
 * 设计要点：
 * - 通过 `AbortSignal.timeout()` 实现超时（Node >= 20 可用），不引入第三方依赖；
 * - 限制响应读取的字节数，避免异常设备返回超大响应拖垮进程；
 * - 原始响应按契约最多保留 8192 个字符，超出截断并标记 truncated。
 */
import { validateHttpUrl } from './config.js';
import { USER_AGENT } from './version.js';

/** 契约规定的 raw.body 最大字符数 */
export const MAX_RAW_CHARS = 8192;

/** 读取响应体的字节上限：足够容纳 8192 个多字节字符，同时防止超大响应占满内存 */
const MAX_BODY_BYTES = 65536;

/**
 * 构造响应里的 raw 对象。
 * @param {string} contentType
 * @param {string} body
 * @returns {{contentType: string, body: string, truncated: boolean}}
 */
export function makeRaw(contentType, body) {
  const text = typeof body === 'string' ? body : '';
  const contentTypeText = typeof contentType === 'string' ? contentType : '';
  if (text.length > MAX_RAW_CHARS) {
    return { contentType: contentTypeText, body: text.slice(0, MAX_RAW_CHARS), truncated: true };
  }
  return { contentType: contentTypeText, body: text, truncated: false };
}

/** 从 fetch 抛出的异常里提取尽量短的技术细节，便于日志排查。 */
function describeFetchError(error) {
  const cause = error && error.cause;
  const detail = cause?.code || cause?.message || error?.message || '网络错误';
  return String(detail).slice(0, 120);
}

/**
 * 读取响应体，最多 maxBytes 字节；超时由 AbortSignal 在 fetch/reader 层中断。
 * @param {Response} response
 * @param {number} maxBytes
 */
async function readBodyLimited(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total = maxBytes;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // 无论正常读完还是提前截断，都取消流，及时释放底层连接。
    try {
      await reader.cancel();
    } catch {
      // 连接已关闭时取消会抛错，忽略即可
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

/**
 * 对设备发起一次 GET 请求。
 *
 * @param {string} url 已配置的设备 URL
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<
 *   | {ok: true, latencyMs: number, httpStatus: number, raw: object, error: null}
 *   | {ok: false, latencyMs: number, httpStatus: number|null, raw: object|null, error: {code: string, message: string}}
 * >}
 */
export async function fetchDevice(url, { timeoutMs = 5000 } = {}) {
  const startedAt = Date.now();
  const checked = validateHttpUrl(url);
  if (!checked.ok || !checked.value) {
    return {
      ok: false,
      latencyMs: 0,
      httpStatus: null,
      raw: null,
      error: {
        code: 'INVALID_URL',
        message: checked.ok ? '接口 URL 为空' : checked.error,
      },
    };
  }

  const effectiveTimeout = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
  const timeoutError = {
    ok: false,
    latencyMs: Date.now() - startedAt,
    httpStatus: null,
    raw: null,
    error: { code: 'TIMEOUT', message: `请求超时（${effectiveTimeout} ms）` },
  };
  const networkError = (error) => ({
    ok: false,
    latencyMs: Date.now() - startedAt,
    httpStatus: null,
    raw: null,
    error: { code: 'NETWORK', message: `无法连接设备（${describeFetchError(error)}）` },
  });
  const isTimeout = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';

  let response;
  try {
    response = await fetch(checked.value, {
      method: 'GET', // 契约：只对设备发 GET
      redirect: 'follow',
      signal: AbortSignal.timeout(effectiveTimeout),
      headers: {
        accept: 'application/json, text/plain, */*',
        'user-agent': USER_AGENT,
      },
    });
  } catch (error) {
    return isTimeout(error) ? { ...timeoutError, latencyMs: Date.now() - startedAt } : networkError(error);
  }

  let body;
  try {
    body = await readBodyLimited(response, MAX_BODY_BYTES);
  } catch (error) {
    return isTimeout(error) ? { ...timeoutError, latencyMs: Date.now() - startedAt } : networkError(error);
  }

  const latencyMs = Date.now() - startedAt;
  const raw = makeRaw(response.headers.get('content-type') || '', body);

  if (!response.ok) {
    return {
      ok: false,
      latencyMs,
      httpStatus: response.status,
      raw,
      error: { code: 'HTTP', message: `设备返回 HTTP ${response.status}` },
    };
  }

  return { ok: true, latencyMs, httpStatus: response.status, raw, error: null };
}
