/**
 * 静态文件服务（public/）：SPA fallback、正确 MIME、路径穿越防护、安全响应头。
 *
 * 路由优先级：
 * - 已存在的文件 / 目录（目录取 index.html）；
 * - 前端路由（无扩展名且接受 HTML）回退到 index.html；
 * - 缺失的静态资源（有扩展名）返回 404，避免把错误资源当 HTML 返回。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { DEFAULT_PUBLIC_DIR } from './version.js';
import { applySecurityHeaders, sendText } from './http.js';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);

const ALLOWED_METHODS = 'GET, HEAD';

/** 根据扩展名返回 Content-Type，未知类型按二进制流处理。 */
export function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

/**
 * 解析并解码 URL 路径；拒绝非法编码、NUL 与反斜杠（Windows 上会被当作分隔符）。
 * @param {string} requestUrl
 */
function parsePathname(requestUrl) {
  let pathname;
  try {
    pathname = new URL(requestUrl || '/', 'http://localhost').pathname;
  } catch {
    return { ok: false, status: 400, message: '请求地址无效' };
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { ok: false, status: 400, message: '请求地址编码无效' };
  }
  if (decoded.includes('\0')) return { ok: false, status: 400, message: '请求地址无效' };
  if (decoded.includes('\\')) return { ok: false, status: 404, message: '未找到资源' };
  return { ok: true, pathname: decoded };
}

/**
 * 把 URL 路径映射为 publicDir 内的绝对路径；任何越界尝试都视为不存在。
 * @param {string} publicDir
 * @param {string} decodedPath
 */
function resolveInsidePublic(publicDir, decodedPath) {
  const root = path.resolve(publicDir);
  const relative = decodedPath.replace(/^\/+/, '');
  const absolute = path.resolve(root, relative);
  const relativeBack = path.relative(root, absolute);
  // 空字符串表示就是 publicDir 本身（合法）；以 .. 开头或绝对路径说明越界。
  if (relativeBack !== '' && (relativeBack.startsWith('..') || path.isAbsolute(relativeBack))) {
    return { ok: false, filePath: null };
  }
  return { ok: true, filePath: absolute };
}

/** stat 目标；目录转换为目录下的 index.html。 */
async function locateFile(filePath) {
  try {
    const info = await fsp.stat(filePath);
    if (info.isDirectory()) {
      return { filePath: path.join(filePath, 'index.html') };
    }
    if (!info.isFile()) return null;
    return { filePath };
  } catch {
    return null;
  }
}

/** 最后一段是否带扩展名（用于区分“前端路由”与“缺失的静态资源”）。 */
function looksLikeAsset(pathname) {
  const base = path.posix.basename(pathname);
  return /\.[a-z0-9]{1,12}$/i.test(base);
}

/** 客户端是否期望 HTML（浏览器导航请求通常是 text/html；fetch 默认 Accept 为任意类型，也允许回退）。 */
function acceptsHtml(request) {
  const accept = String(request.headers.accept ?? '').toLowerCase();
  if (!accept) return true;
  return accept.includes('text/html') || accept.includes('*/*');
}

/**
 * 发送文件；HEAD 请求只返回头部。
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} filePath
 * @param {Buffer} data
 */
function sendFile(request, response, filePath, data) {
  applySecurityHeaders(response);
  response.statusCode = 200;
  response.setHeader('Content-Type', contentTypeFor(filePath));
  response.setHeader('Content-Length', String(data.byteLength));
  // 前端是 PWA，静态文件不做长缓存，避免更新后拿到旧资源；Service Worker 自行缓存。
  response.setHeader('Cache-Control', 'no-cache');
  if (request.method === 'HEAD') response.end();
  else response.end(data);
}

/**
 * 处理静态资源请求。该函数总是写出响应，不会把请求交回调用方。
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {{publicDir?: string}} [options]
 */
export async function serveStatic(request, response, { publicDir = DEFAULT_PUBLIC_DIR } = {}) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, '方法不被允许', { headers: { Allow: ALLOWED_METHODS }, method: request.method });
    return;
  }

  const parsed = parsePathname(request.url);
  if (!parsed.ok) {
    sendText(response, parsed.status, parsed.message, { method: request.method });
    return;
  }

  const resolved = resolveInsidePublic(publicDir, parsed.pathname);
  if (!resolved.ok) {
    // 路径穿越：不区分“不存在”和“越界”，统一 404，避免泄露目录结构。
    sendText(response, 404, '未找到资源', { method: request.method });
    return;
  }

  // 1) 精确文件或目录 index.html
  const located = await locateFile(resolved.filePath);
  if (located) {
    try {
      const data = await fsp.readFile(located.filePath);
      sendFile(request, response, located.filePath, data);
      return;
    } catch {
      // 例如目录存在但没有 index.html，继续走 SPA fallback
    }
  }

  // 2) SPA fallback：只有“看起来像前端路由”的请求才回退到 index.html
  const isRouteLike = !looksLikeAsset(parsed.pathname) && acceptsHtml(request);
  if (isRouteLike) {
    const indexFile = path.join(path.resolve(publicDir), 'index.html');
    try {
      const data = await fsp.readFile(indexFile);
      sendFile(request, response, indexFile, data);
      return;
    } catch {
      // 前端资源尚未产出时继续返回 404
    }
  }

  sendText(response, 404, '未找到资源', { method: request.method });
}
