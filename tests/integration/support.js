/**
 * 集成测试公共工具：真实 HTTP 服务 + 临时 mock 设备 + 临时工作目录。
 *
 * 所有端口均由系统随机分配（listen 0），不占用 8787；
 * 所有配置写入 os.tmpdir() 下的临时目录，不触碰真实 data/config.json。
 */
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../server/server.js';

/** 监听随机端口，返回实际端口。 */
export function listenOnRandomPort(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(address && typeof address === 'object' ? address.port : 0);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

/** 关闭 server 并强制断开 keep-alive 连接，保证测试进程能退出。 */
export function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** 创建临时工作目录（配置 + 静态资源都放这里）。 */
export async function createTempWorkspace() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'powercard-it-'));
  return {
    tmpDir,
    configPath: path.join(tmpDir, 'data', 'config.json'),
    publicDir: path.join(tmpDir, 'public'),
    async cleanup() {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

/** 启动被测应用（随机端口），返回 baseUrl 与 close。 */
export async function startAppServer({ configPath, publicDir, warn, demoDevice, logLimit } = {}) {
  const server = createServer({
    configPath,
    publicDir,
    warn: typeof warn === 'function' ? warn : () => {},
    demoDevice,
    logLimit,
  });
  const port = await listenOnRandomPort(server);
  return {
    server,
    app: server.app,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => closeServer(server),
  };
}

function mockSendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function mockSendText(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** mock 设备的固定路由表；每个用例按需把配置指向不同路径。 */
function handleMockRequest(request, response, pathname) {
  switch (pathname) {
    case '/status/json':
      return mockSendJson(response, 200, { power: 1, online: true });
    case '/status/nested':
      return mockSendJson(response, 200, { data: { power: 'on', online: 1 } });
    case '/status/text':
      return mockSendText(response, 200, 'power=off\nonline=1');
    case '/status/unparseable':
      return mockSendText(response, 200, 'OK');
    case '/status/html-ambiguous':
      return mockSendText(
        response,
        200,
        '<html><body><h1>开机</h1><button>关机</button><p>开机卡在线</p></body></html>',
        'text/html; charset=utf-8',
      );
    case '/status/cache':
      return mockSendJson(response, 200, { power: 'on', online: true });
    case '/status/500':
      return mockSendText(response, 500, 'mock device error');
    case '/status/slow': {
      const timer = setTimeout(() => mockSendJson(response, 200, { power: 'on', online: true }), 3000);
      request.on('close', () => clearTimeout(timer));
      response.on('close', () => clearTimeout(timer));
      return undefined;
    }
    case '/power/on':
    case '/power/off':
    case '/reboot':
      return mockSendText(response, 200, 'OK');
    case '/power/500':
      return mockSendText(response, 500, 'mock command error');
    default:
      return mockSendText(response, 404, 'not found');
  }
}

/** 启动 mock 开机卡（随机端口），记录请求次数供缓存等断言使用。 */
export async function startMockDevice() {
  const state = { requests: [], hits: new Map() };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://mock');
    const pathname = url.pathname;
    state.requests.push({ method: request.method, pathname, url: request.url });
    state.hits.set(pathname, (state.hits.get(pathname) || 0) + 1);
    handleMockRequest(request, response, pathname);
  });
  const port = await listenOnRandomPort(server);
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    /** 某个路径被请求的次数 */
    hits(pathname) {
      return state.hits.get(pathname) || 0;
    },
    close: () => closeServer(server),
  };
}

/**
 * 请求被测应用并尽量解析 JSON。
 * @param {string} baseUrl
 * @param {string} pathname
 * @param {{method?: string, body?: unknown, headers?: Record<string,string>}} [options]
 */
export async function api(baseUrl, pathname, { method = 'GET', body, headers = {} } = {}) {
  const init = {
    method,
    headers: { accept: 'application/json', ...headers },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}
