/**
 * /api 集成测试：真实 HTTP（被测服务 + mock 设备），随机端口 + 临时 CONFIG_PATH。
 *
 * 覆盖：health / config GET+PUT / status 成功·超时·HTTP 错误·解析 / command /
 *      test / logs / demo 模式 / 请求非法（400/404/405/413）。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { api, createTempWorkspace, startAppServer, startMockDevice } from './support.js';

let workspace;
let app;
let mock;

before(async () => {
  workspace = await createTempWorkspace();
  mock = await startMockDevice();
  app = await startAppServer({ configPath: workspace.configPath, publicDir: workspace.publicDir });
});

after(async () => {
  await app?.close();
  await mock?.close();
  await workspace?.cleanup();
});

/** 生成指向 mock 设备的完整配置（默认全部指向成功路由）。 */
function liveConfig(overrides = {}) {
  return {
    statusUrl: `${mock.baseUrl}/status/json`,
    powerOnUrl: `${mock.baseUrl}/power/on`,
    powerOffUrl: `${mock.baseUrl}/power/off`,
    rebootUrl: `${mock.baseUrl}/reboot`,
    ...overrides,
  };
}

/** PUT 配置并断言成功，返回响应 JSON。 */
async function setConfig(overrides = {}) {
  const response = await api(app.baseUrl, '/api/config', { method: 'PUT', body: liveConfig(overrides) });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.ok, true, response.text);
  return response.json;
}

async function getStatus(query = '') {
  return api(app.baseUrl, `/api/status${query}`);
}

test('GET /api/health 返回应用标识与运行时长', async () => {
  const response = await api(app.baseUrl, '/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.json.ok, true);
  assert.equal(response.json.app, 'powercard-remote');
  assert.equal(response.json.version, '1.0.0');
  assert.equal(typeof response.json.uptimeSec, 'number');
  assert.ok(response.json.uptimeSec >= 0);
});

test('GET /api/config 首次启动为默认配置 + demo 模式', async () => {
  const response = await api(app.baseUrl, '/api/config');
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.mode, 'demo');
  assert.equal(response.json.config.statusUrl, '');
  assert.equal(response.json.config.pollIntervalSec, 10);
  assert.equal(response.json.config.requestTimeoutMs, 5000);
  assert.equal(response.json.config.confirmActions, true);
});

test('PUT /api/config 校验失败返回 400 + error.fields，且不改变现有配置', async () => {
  const response = await api(app.baseUrl, '/api/config', {
    method: 'PUT',
    body: { statusUrl: 'ftp://bad', pollIntervalSec: 3, macAddress: 'oops' },
  });

  assert.equal(response.status, 400);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error.code, 'VALIDATION');
  assert.match(response.json.error.message, /有 3 项设置需要检查/);
  assert.match(response.json.error.fields.statusUrl, /http:\/\/ 或 https:\/\//);
  assert.match(response.json.error.fields.pollIntervalSec, /5–300/);
  assert.match(response.json.error.fields.macAddress, /MAC/);

  // 失败请求不应写入任何内容
  const current = await api(app.baseUrl, '/api/config');
  assert.equal(current.json.mode, 'demo');
  assert.equal(current.json.config.statusUrl, '');
});

test('PUT /api/config 成功：响应、模式切换、原子落盘', async () => {
  const response = await api(app.baseUrl, '/api/config', {
    method: 'PUT',
    body: {
      ...liveConfig(),
      lanAddress: '192.168.1.50',
      wanAddress: 'https://example.com:8443',
      macAddress: 'aabb.ccdd.eeff',
      pollIntervalSec: 15,
      requestTimeoutMs: 3000,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.mode, 'live');
  assert.equal(response.json.config.macAddress, 'AA:BB:CC:DD:EE:FF');
  assert.equal(response.json.config.pollIntervalSec, 15);

  // 配置文件真实写入临时目录
  const onDisk = JSON.parse(await fsp.readFile(workspace.configPath, 'utf8'));
  assert.equal(onDisk.statusUrl, liveConfig().statusUrl);
  assert.equal(onDisk.macAddress, 'AA:BB:CC:DD:EE:FF');

  const reloaded = await api(app.baseUrl, '/api/config');
  assert.equal(reloaded.json.mode, 'live');
  assert.equal(reloaded.json.config.statusUrl, liveConfig().statusUrl);
});

test('GET /api/status：JSON 成功响应字段完整', async () => {
  await setConfig();
  const response = await getStatus();
  const body = response.json;

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'live');
  assert.equal(body.online, true);
  assert.equal(body.onlineInferred, false);
  assert.equal(body.power, 'on');
  assert.equal(body.powerLabel, '电脑已开机');
  assert.equal(typeof body.latencyMs, 'number');
  assert.ok(body.latencyMs >= 0);
  assert.match(body.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(body.sourceUrl, liveConfig().statusUrl);
  assert.equal(body.httpStatus, 200);
  assert.equal(body.raw.truncated, false);
  assert.match(body.raw.contentType, /application\/json/);
  assert.match(body.raw.body, /"power":1/);
  assert.deepEqual(body.mapping, { powerField: 'power', onlineField: 'online' });
  assert.equal(body.warning, null);
  assert.equal(body.error, null);
});

test('GET /api/status：纯文本响应按 key=value 解析', async () => {
  await setConfig({ statusUrl: `${mock.baseUrl}/status/text` });
  const body = (await getStatus()).json;

  assert.equal(body.ok, true);
  assert.equal(body.power, 'off');
  assert.equal(body.powerLabel, '电脑已关机');
  assert.equal(body.online, true);
  assert.equal(body.mapping.powerField, 'power');
});

test('GET /api/status：手动字段路径生效，可覆盖自动识别', async () => {
  await setConfig({ statusUrl: `${mock.baseUrl}/status/nested`, powerField: 'data.power', onlineField: 'data.online' });
  const body = (await getStatus()).json;

  assert.equal(body.ok, true);
  assert.equal(body.power, 'on');
  assert.deepEqual(body.mapping, { powerField: 'data.power', onlineField: 'data.online' });

  // 手动路径写错时回退自动识别
  await setConfig({ statusUrl: `${mock.baseUrl}/status/nested`, powerField: 'wrong.path' });
  const fallback = (await getStatus()).json;
  assert.equal(fallback.power, 'on');
  assert.equal(fallback.mapping.powerField, 'data.power');
});

test('GET /api/status：HTML 同时含开机/关机关机不猜测，warning 非空', async () => {
  await setConfig({ statusUrl: `${mock.baseUrl}/status/html-ambiguous` });
  const body = (await getStatus()).json;

  assert.equal(body.ok, true); // 请求本身成功
  assert.equal(body.online, true);
  assert.equal(body.power, 'unknown');
  assert.equal(body.powerLabel, '状态未知');
  assert.equal(typeof body.warning, 'string');
  assert.match(body.warning, /无法识别电源状态/);
  assert.equal(body.error, null);
});

test('GET /api/status：设备返回 500 → ok:false / HTTP 错误', async () => {
  await setConfig({ statusUrl: `${mock.baseUrl}/status/500` });
  const body = (await getStatus()).json;

  assert.equal(body.ok, false);
  assert.equal(body.online, false);
  assert.equal(body.onlineInferred, false);
  assert.equal(body.power, 'unknown');
  assert.equal(body.httpStatus, 500);
  assert.equal(body.error.code, 'HTTP');
  assert.equal(body.error.message, '设备返回 HTTP 500');
  assert.equal(body.raw.body, 'mock device error');
  assert.equal(body.warning, null);
});

test('GET /api/status：超时映射为 TIMEOUT，且不泄漏原始响应', async () => {
  await setConfig({ statusUrl: `${mock.baseUrl}/status/slow`, requestTimeoutMs: 1000 });

  const startedAt = Date.now();
  const body = (await getStatus()).json;
  const elapsed = Date.now() - startedAt;

  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'TIMEOUT');
  assert.match(body.error.message, /请求超时（1000 ms）/);
  assert.equal(body.httpStatus, null);
  assert.equal(body.raw, null);
  assert.ok(body.latencyMs >= 900, `latencyMs=${body.latencyMs}`);
  assert.ok(elapsed >= 900, `elapsed=${elapsed}`);
});

test('GET /api/status：1.5s 短缓存命中，refresh=1 绕过', async () => {
  await setConfig({ statusUrl: `${mock.baseUrl}/status/cache` });
  const baseline = mock.hits('/status/cache');

  const first = (await getStatus()).json;
  assert.equal(mock.hits('/status/cache'), baseline + 1);

  const second = (await getStatus()).json;
  assert.equal(mock.hits('/status/cache'), baseline + 1, '1.5s 内应命中服务端缓存');
  assert.equal(second.fetchedAt, first.fetchedAt, '缓存响应应复用同一份数据');

  const refreshed = (await getStatus('?refresh=1')).json;
  assert.equal(mock.hits('/status/cache'), baseline + 2, 'refresh=1 应绕过缓存');
  assert.equal(refreshed.ok, true);
});

test('GET /api/status：只配置开机 URL 时返回 CONFIG 错误', async () => {
  await api(app.baseUrl, '/api/config', {
    method: 'PUT',
    body: { powerOnUrl: `${mock.baseUrl}/power/on` },
  });

  const body = (await getStatus()).json;
  assert.equal(body.ok, false);
  assert.equal(body.mode, 'live');
  assert.equal(body.error.code, 'CONFIG');
  assert.match(body.error.message, /尚未配置状态接口 URL/);
  assert.equal(body.sourceUrl, null);
});

test('POST /api/command：成功发送 GET 请求并返回中文文案', async () => {
  await setConfig();
  const baseline = mock.hits('/power/on');

  const response = await api(app.baseUrl, '/api/command', { method: 'POST', body: { action: 'on' } });
  const body = response.json;

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'live');
  assert.equal(body.action, 'on');
  assert.equal(body.message, '开机指令已发送');
  assert.equal(body.httpStatus, 200);
  assert.equal(body.sourceUrl, `${mock.baseUrl}/power/on`);
  assert.equal(body.raw.body, 'OK');
  assert.equal(body.error, null);
  assert.equal(mock.hits('/power/on'), baseline + 1);

  // 只允许 GET
  assert.equal(mock.state.requests.at(-1).method, 'GET');
});

test('POST /api/command：非法 action 返回 400', async () => {
  const response = await api(app.baseUrl, '/api/command', { method: 'POST', body: { action: 'explode' } });
  assert.equal(response.status, 400);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error.code, 'VALIDATION');
  assert.ok(response.json.error.fields.action);
});

test('POST /api/command：设备非 2xx → ok:false / HTTP 错误', async () => {
  await setConfig({ powerOnUrl: `${mock.baseUrl}/power/500` });
  const body = (await api(app.baseUrl, '/api/command', { method: 'POST', body: { action: 'on' } })).json;

  assert.equal(body.ok, false);
  assert.equal(body.message, '开机指令发送失败');
  assert.equal(body.httpStatus, 500);
  assert.equal(body.error.code, 'HTTP');
  assert.equal(body.error.message, '设备返回 HTTP 500');
});

test('POST /api/command：未配置对应 URL → CONFIG 错误（HTTP 200）', async () => {
  await api(app.baseUrl, '/api/config', {
    method: 'PUT',
    body: { statusUrl: `${mock.baseUrl}/status/json` },
  });

  const body = (await api(app.baseUrl, '/api/command', { method: 'POST', body: { action: 'off' } })).json;
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'CONFIG');
  assert.equal(body.error.message, '尚未配置关机接口 URL');
  assert.equal(body.sourceUrl, null);
});

test('POST /api/test：使用临时配置测试且不保存', async () => {
  await api(app.baseUrl, '/api/config', { method: 'PUT', body: {} });
  const url = `${mock.baseUrl}/status/nested`;

  const response = await api(app.baseUrl, '/api/test', {
    method: 'POST',
    body: { statusUrl: url, powerField: 'data.power', onlineField: 'data.online', requestTimeoutMs: 3000 },
  });
  const body = response.json;

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode, 'test');
  assert.equal(body.power, 'on');
  assert.equal(body.online, true);
  assert.equal(body.sourceUrl, url);
  assert.equal(body.httpStatus, 200);

  // 配置未被修改
  const config = await api(app.baseUrl, '/api/config');
  assert.equal(config.json.mode, 'demo');
  assert.equal(config.json.config.statusUrl, '');
});

test('POST /api/test：未提供 URL → CONFIG；非法 URL → INVALID_URL', async () => {
  const missing = await api(app.baseUrl, '/api/test', { method: 'POST', body: {} });
  assert.equal(missing.status, 200);
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.mode, 'test');
  assert.equal(missing.json.error.code, 'CONFIG');

  const invalid = await api(app.baseUrl, '/api/test', { method: 'POST', body: { statusUrl: 'ftp://bad' } });
  assert.equal(invalid.json.ok, false);
  assert.equal(invalid.json.error.code, 'INVALID_URL');
});

test('GET /api/logs：最新在前，记录 kind/url/latency/rawPreview', async () => {
  await setConfig();
  await api(app.baseUrl, '/api/command', { method: 'POST', body: { action: 'on' } });

  const response = await api(app.baseUrl, '/api/logs');
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.ok(Array.isArray(response.json.logs));
  assert.ok(response.json.logs.length > 0);
  assert.ok(response.json.logs.length <= 30);

  const latest = response.json.logs[0];
  assert.equal(latest.kind, 'command');
  assert.equal(latest.method, 'GET');
  assert.equal(latest.url, `${mock.baseUrl}/power/on`);
  assert.equal(latest.httpStatus, 200);
  assert.equal(latest.ok, true);
  assert.equal(typeof latest.latencyMs, 'number');
  assert.equal(latest.error, null);
  assert.equal(typeof latest.rawPreview, 'string');
  assert.match(latest.id, /^l_\d+_\d+$/);
  assert.match(latest.at, /^\d{4}-\d{2}-\d{2}T/);

  // 日志按时间倒序（最新在前）
  if (response.json.logs.length >= 2) {
    assert.ok(new Date(response.json.logs[0].at).getTime() >= new Date(response.json.logs[1].at).getTime());
  }
});

test('演示模式：状态立即返回模拟数据，指令约 600ms 后改变状态', async () => {
  const put = await api(app.baseUrl, '/api/config', { method: 'PUT', body: {} });
  assert.equal(put.json.mode, 'demo');

  const initial = (await getStatus()).json;
  assert.equal(initial.mode, 'demo');
  assert.equal(initial.ok, true);
  assert.equal(initial.online, true);
  assert.equal(initial.onlineInferred, false);
  assert.equal(initial.power, 'on');
  assert.equal(initial.powerLabel, '电脑已开机');
  assert.equal(initial.latencyMs, 0);
  assert.equal(initial.sourceUrl, null);
  assert.equal(initial.httpStatus, null);
  assert.equal(initial.raw.body, '{"demo":true,"online":true,"power":"on"}');
  assert.equal(initial.error, null);

  // 关机指令：约 600ms
  const offStartedAt = Date.now();
  const off = (await api(app.baseUrl, '/api/command', { method: 'POST', body: { action: 'off' } })).json;
  const offElapsed = Date.now() - offStartedAt;
  assert.equal(off.ok, true);
  assert.equal(off.mode, 'demo');
  assert.equal(off.sourceUrl, null);
  assert.equal(off.message, '关机指令已发送');
  assert.ok(offElapsed >= 500, `demo 指令应有约 600ms 延迟，实际 ${offElapsed}ms`);
  assert.equal((await getStatus()).json.power, 'off');

  // 重启指令：结束后回到开机
  const reboot = (await api(app.baseUrl, '/api/command', { method: 'POST', body: { action: 'reboot' } })).json;
  assert.equal(reboot.ok, true);
  assert.equal(reboot.message, '重启指令已发送');
  assert.equal((await getStatus()).json.power, 'on');
});

test('未知 /api 路径 404；方法不允许 405 且带 Allow 头', async () => {
  const notFound = await api(app.baseUrl, '/api/nope');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.json.error.code, 'NOT_FOUND');

  const wrongMethod = await api(app.baseUrl, '/api/health', { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.error.code, 'METHOD_NOT_ALLOWED');
  assert.equal(wrongMethod.headers.get('allow'), 'GET');

  const deleteConfig = await api(app.baseUrl, '/api/config', { method: 'DELETE' });
  assert.equal(deleteConfig.status, 405);
  assert.equal(deleteConfig.headers.get('allow'), 'GET, PUT');
});

test('非法 JSON 请求体 400；超大请求体 413', async () => {
  const invalidJson = await api(app.baseUrl, '/api/config', { method: 'PUT', body: '{"statusUrl":' });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.json.error.code, 'VALIDATION');
  assert.match(invalidJson.json.error.message, /JSON/);

  const tooLarge = await api(app.baseUrl, '/api/config', {
    method: 'PUT',
    body: { statusUrl: 'http://192.168.1.50/status', filler: 'x'.repeat(70000) },
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.json.error.code, 'PAYLOAD_TOO_LARGE');
});
