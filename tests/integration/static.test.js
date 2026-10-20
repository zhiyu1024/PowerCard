/**
 * 静态资源与安全响应头集成测试。
 *
 * 使用临时 public 目录，不依赖前端队友产出的真实 public/index.html，
 * 因此后端测试可以先于前端完成运行。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createTempWorkspace, startAppServer, api } from './support.js';

let workspace;
let app;
let baseUrl;

const INDEX_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN"><head><meta charset="utf-8"><title>fixture</title>',
  '<link rel="stylesheet" href="/styles.css"></head>',
  '<body><div id="app">fixture-index</div>',
  '<script type="module" src="/app.js"></script></body></html>',
].join('');

before(async () => {
  workspace = await createTempWorkspace();
  const publicDir = workspace.publicDir;
  await fsp.mkdir(path.join(publicDir, 'icons'), { recursive: true });
  await fsp.writeFile(path.join(publicDir, 'index.html'), INDEX_HTML, 'utf8');
  await fsp.writeFile(path.join(publicDir, 'styles.css'), 'body{background:#f6f4ef}', 'utf8');
  await fsp.writeFile(path.join(publicDir, 'app.js'), 'export const version = 1;', 'utf8');
  await fsp.writeFile(path.join(publicDir, 'manifest.webmanifest'), '{"name":"fixture"}', 'utf8');
  await fsp.writeFile(path.join(publicDir, 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // publicDir 之外的敏感文件，用于验证路径穿越防护
  await fsp.writeFile(path.join(workspace.tmpDir, 'secret.txt'), 'TOP-SECRET', 'utf8');

  app = await startAppServer({ configPath: workspace.configPath, publicDir });
  baseUrl = app.baseUrl;
});

after(async () => {
  await app?.close();
  await workspace?.cleanup();
});

/** 用原始 path 发请求，绕过 fetch 对 URL 的规范化，便于测试路径穿越。 */
function rawRequest(rawPath, method = 'GET') {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: url.hostname, port: url.port, path: rawPath, method },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

test('GET / 返回 index.html，CSP 允许同源脚本/样式/图片且禁止内联', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-cache');

  const csp = response.headers.get('content-security-policy');
  assert.ok(csp);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);

  assert.match(await response.text(), /fixture-index/);
});

test('静态资源 MIME 正确（js/css/webmanifest/png）', async () => {
  const cases = [
    ['/app.js', /^text\/javascript/],
    ['/styles.css', /^text\/css/],
    ['/manifest.webmanifest', /^application\/manifest\+json/],
    ['/icons/icon-192.png', /^image\/png/],
  ];
  for (const [pathname, expected] of cases) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers.get('content-type'), expected, pathname);
  }
});

test('前端路由回退到 index.html（SPA fallback）', async () => {
  const response = await fetch(`${baseUrl}/settings`, { headers: { accept: 'text/html' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(await response.text(), /fixture-index/);
});

test('缺失的静态资源不会回退成 HTML', async () => {
  const response = await fetch(`${baseUrl}/missing.js`);
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.headers.get('content-type'), /text\/html/);
});

test('路径穿越防护：编码的 ../ 与反斜杠均无法读取 public 外文件', async () => {
  const attempts = ['/..%2f..%2fsecret.txt', '/%2e%2e%2f%2e%2e%2fsecret.txt', '/..%5c..%5csecret.txt'];
  for (const attempt of attempts) {
    const response = await rawRequest(attempt);
    assert.ok([400, 404].includes(response.status), `${attempt} -> ${response.status}`);
    assert.doesNotMatch(response.body, /TOP-SECRET/, attempt);
  }
});

test('HEAD / 返回头部且无响应体', async () => {
  const response = await fetch(`${baseUrl}/`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.ok(Number(response.headers.get('content-length')) > 0);
  assert.equal(await response.text(), '');
});

test('静态资源只允许 GET/HEAD，其它方法 405 且带 Allow 头', async () => {
  const response = await fetch(`${baseUrl}/`, { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});

test('未知 /api 返回 JSON 404；API 响应带安全头与 no-store', async () => {
  const notFound = await api(baseUrl, '/api/not-exist');
  assert.equal(notFound.status, 404);
  assert.match(notFound.headers.get('content-type'), /^application\/json/);
  assert.equal(notFound.json.ok, false);
  assert.equal(notFound.json.error.code, 'NOT_FOUND');

  const health = await api(baseUrl, '/api/health');
  assert.ok(health.headers.get('content-security-policy'));
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('cache-control'), 'no-store');
});
