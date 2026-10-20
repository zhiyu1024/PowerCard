/**
 * HTTP 公共层：安全响应头、JSON / 文本响应、请求体读取。
 *
 * CSP 说明（契约要求）：允许同源脚本 / 样式 / 图片，禁止内联脚本与内联样式；
 * 因此 script-src / style-src 只有 'self'，没有 'unsafe-inline'。
 */

/** 所有响应都会带上的安全头。 */
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

/** 内容安全策略：同源脚本、样式、图片；服务端反代了设备接口，所以 connect-src 只需 'self'。 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "worker-src 'self'",
].join('; ');

/** 默认请求体大小上限（/api/config 最多 64KB） */
export const DEFAULT_BODY_LIMIT = 64 * 1024;

/**
 * 给响应附加安全头；重复调用不会产生重复头。
 * @param {import('node:http').ServerResponse} response
 */
export function applySecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
  response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
}

/**
 * 发送 JSON 响应：统一 Content-Type 与 Cache-Control（契约第 3 节）。
 * @param {import('node:http').ServerResponse} response
 * @param {number} statusCode
 * @param {unknown} payload
 * @param {{headers?: Record<string, string>}} [options]
 */
export function sendJson(response, statusCode, payload, { headers } = {}) {
  applySecurityHeaders(response);
  if (headers) {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  }
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(payload));
}

/**
 * 发送文本响应（错误页、静态资源降级等）。
 * @param {import('node:http').ServerResponse} response
 * @param {number} statusCode
 * @param {string} text
 * @param {{contentType?: string, cacheControl?: string, headers?: Record<string,string>, method?: string}} [options]
 */
export function sendText(response, statusCode, text, { contentType = 'text/plain; charset=utf-8', cacheControl = 'no-store', headers, method = 'GET' } = {}) {
  applySecurityHeaders(response);
  if (headers) {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  }
  response.statusCode = statusCode;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Cache-Control', cacheControl);
  const body = Buffer.from(text, 'utf8');
  response.setHeader('Content-Length', String(body.byteLength));
  if (method === 'HEAD') response.end();
  else response.end(body);
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 返回值统一为 `{ok:true,value}` 或 `{ok:false,status,error}`，
 * 由路由层直接映射成 400 / 413，避免在每个接口里重复 try/catch。
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {{limit?: number}} [options]
 * @returns {Promise<{ok: true, value: unknown} | {ok: false, status: number, error: {code: string, message: string, fields?: object}}>}
 */
export function readJsonBody(request, { limit = DEFAULT_BODY_LIMIT } = {}) {
  return new Promise((resolve) => {
    const contentLength = Number.parseInt(String(request.headers['content-length'] ?? ''), 10);
    if (Number.isInteger(contentLength) && contentLength > limit) {
      request.resume();
      resolve({
        ok: false,
        status: 413,
        error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大', fields: {} },
      });
      return;
    }

    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    request.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        finish({
          ok: false,
          status: 413,
          error: { code: 'PAYLOAD_TOO_LARGE', message: `请求体不能超过 ${limit} 字节`, fields: {} },
        });
        request.resume(); // 丢弃剩余数据，避免连接悬挂
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        finish({ ok: true, value: {} });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(text) });
      } catch {
        finish({
          ok: false,
          status: 400,
          error: { code: 'VALIDATION', message: '请求体不是合法 JSON', fields: {} },
        });
      }
    });

    request.on('error', () => {
      finish({
        ok: false,
        status: 400,
        error: { code: 'VALIDATION', message: '读取请求体失败', fields: {} },
      });
    });
  });
}
