import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeApi, normalizeConfig } from '../../public/shared/native-api.js';

const BASE_CONFIG = {
  statusUrl: 'http://device.local/status',
  powerOnUrl: 'http://device.local/on',
  powerOffUrl: 'http://device.local/off',
  rebootUrl: 'http://device.local/reboot',
  lanAddress: '192.168.1.50',
  wanAddress: 'https://device.example.com',
  subnetMask: '255.255.255.0',
  gateway: '192.168.1.1',
  macAddress: 'aabbccddeeff',
  pollIntervalSec: 10,
  requestTimeoutMs: 5000,
  confirmActions: true,
  powerField: '',
  onlineField: '',
};

function fakeBridge(initial = {}, httpGet = async () => ({
  ok: true,
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ status: 0, msg: 'OK', data: { online: true, power: 'on' } }),
  truncated: false,
  latencyMs: 20,
  error: null,
})) {
  let stored = JSON.stringify(initial);
  const calls = [];
  return {
    calls,
    getConfigJson: () => stored,
    saveConfigJson: (json) => {
      stored = String(json);
      return true;
    },
    httpGet: async (url, timeout) => {
      calls.push({ url, timeout });
      return httpGet(url, timeout);
    },
    readStored: () => JSON.parse(stored || '{}'),
  };
}

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

test('演示模式：无 URL 时返回模拟状态，指令改变内存状态', async () => {
  const bridge = fakeBridge({});
  const api = createNativeApi({ ...bridge, delay: async () => {} });
  const status = await bodyOf(await api.handleApiRequest('/api/status'));
  assert.equal(status.mode, 'demo');
  assert.equal(status.online, true);
  assert.equal(status.power, 'on');
  assert.equal(status.powerLabel, '电脑已开机');

  const off = await bodyOf(await api.handleApiRequest('/api/command', {
    method: 'POST',
    body: JSON.stringify({ action: 'off' }),
  }));
  assert.equal(off.ok, true);
  assert.equal(off.mode, 'demo');
  const next = await bodyOf(await api.handleApiRequest('/api/status'));
  assert.equal(next.power, 'off');
  assert.equal(next.powerLabel, '电脑已关机');
});

test('live 状态：解析设备 API 信封，不把顶层 status:0 当关机', async () => {
  const bridge = fakeBridge(BASE_CONFIG);
  const api = createNativeApi(bridge);
  const status = await bodyOf(await api.handleApiRequest('/api/status'));
  assert.equal(status.ok, true);
  assert.equal(status.mode, 'live');
  assert.equal(status.power, 'on');
  assert.equal(status.mapping.powerField, 'data.power');
  assert.equal(status.raw.truncated, false);
  assert.equal(bridge.calls[0].url, BASE_CONFIG.statusUrl);
});

test('HTTP 非 2xx：返回 ok:false、HTTP 错误码与原始响应', async () => {
  const bridge = fakeBridge(BASE_CONFIG, async () => ({
    ok: false,
    status: 500,
    contentType: 'text/plain',
    body: 'device error',
    truncated: false,
    latencyMs: 12,
    error: { code: 'HTTP', message: '设备返回 HTTP 500' },
  }));
  const api = createNativeApi(bridge);
  const status = await bodyOf(await api.handleApiRequest('/api/status'));
  assert.equal(status.ok, false);
  assert.equal(status.online, false);
  assert.equal(status.httpStatus, 500);
  assert.equal(status.error.code, 'HTTP');
  assert.equal(status.raw.body, 'device error');
});

test('超时：错误码 TIMEOUT，online=false / power=unknown', async () => {
  const bridge = fakeBridge(BASE_CONFIG, async () => ({
    ok: false,
    status: null,
    contentType: '',
    body: '',
    truncated: false,
    latencyMs: 5000,
    error: { code: 'TIMEOUT', message: '请求超时' },
  }));
  const api = createNativeApi(bridge);
  const status = await bodyOf(await api.handleApiRequest('/api/status'));
  assert.equal(status.ok, false);
  assert.equal(status.online, false);
  assert.equal(status.power, 'unknown');
  assert.equal(status.error.code, 'TIMEOUT');
});

test('指令：按 action 选择 URL，并记录日志（最新在前）', async () => {
  const bridge = fakeBridge(BASE_CONFIG);
  const api = createNativeApi(bridge);
  const command = await bodyOf(await api.handleApiRequest('/api/command', {
    method: 'POST',
    body: JSON.stringify({ action: 'off' }),
  }));
  assert.equal(command.ok, true);
  assert.equal(command.action, 'off');
  assert.equal(bridge.calls.at(-1).url, BASE_CONFIG.powerOffUrl);
  const logs = await bodyOf(await api.handleApiRequest('/api/logs'));
  assert.equal(logs.logs[0].kind, 'command');
  assert.equal(logs.logs[0].url, BASE_CONFIG.powerOffUrl);
  assert.ok(logs.logs.length >= 1);
});

test('配置：PUT 保存并归一化 MAC，GET 返回同一配置与 live 模式', async () => {
  const bridge = fakeBridge({});
  const api = createNativeApi(bridge);
  const saved = await bodyOf(await api.handleApiRequest('/api/config', {
    method: 'PUT',
    body: JSON.stringify(BASE_CONFIG),
  }));
  assert.equal(saved.ok, true);
  assert.equal(saved.mode, 'live');
  assert.equal(saved.config.macAddress, 'AA:BB:CC:DD:EE:FF');
  const loaded = await bodyOf(await api.handleApiRequest('/api/config'));
  assert.equal(loaded.config.statusUrl, BASE_CONFIG.statusUrl);
  assert.equal(loaded.mode, 'live');
});

test('配置校验：非法 URL / 数字范围返回字段级 400', async () => {
  const bridge = fakeBridge({});
  const api = createNativeApi(bridge);
  const response = await api.handleApiRequest('/api/config', {
    method: 'PUT',
    body: JSON.stringify({ ...BASE_CONFIG, statusUrl: 'ftp://bad', pollIntervalSec: 1 }),
  });
  assert.equal(response.status, 400);
  const body = await bodyOf(response);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'VALIDATION');
  assert.ok(body.error.fields.statusUrl);
  assert.ok(body.error.fields.pollIntervalSec);
});

test('状态缓存：1.5 秒内复用，refresh=1 绕过', async () => {
  let now = 1000;
  let calls = 0;
  const bridge = fakeBridge(BASE_CONFIG, async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ power: 'on', online: true }),
      truncated: false,
      latencyMs: 3,
      error: null,
    };
  });
  const api = createNativeApi({ ...bridge, now: () => now });
  await api.handleApiRequest('/api/status');
  await api.handleApiRequest('/api/status');
  assert.equal(calls, 1);
  now += 2000;
  await api.handleApiRequest('/api/status');
  assert.equal(calls, 2);
  await api.handleApiRequest('/api/status?refresh=1');
  assert.equal(calls, 3);
});

test('/api/test：使用临时 URL 且不保存配置', async () => {
  const bridge = fakeBridge({});
  const api = createNativeApi(bridge);
  const testUrl = 'http://other.local/status';
  const response = await bodyOf(await api.handleApiRequest('/api/test', {
    method: 'POST',
    body: JSON.stringify({ statusUrl: testUrl, requestTimeoutMs: 3000 }),
  }));
  assert.equal(response.ok, true);
  assert.equal(response.mode, 'test');
  assert.equal(bridge.calls.at(-1).url, testUrl);
  assert.equal(bridge.calls.at(-1).timeout, 3000);
  assert.deepEqual(bridge.readStored(), {});
});

test('/api/test：非法 URL 返回 INVALID_URL', async () => {
  const api = createNativeApi(fakeBridge({}));
  const response = await bodyOf(await api.handleApiRequest('/api/test', {
    method: 'POST',
    body: JSON.stringify({ statusUrl: 'ftp://bad' }),
  }));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'INVALID_URL');
});

test('normalizeConfig：限制轮询/超时范围，规范 MAC', () => {
  const config = normalizeConfig({
    pollIntervalSec: 1,
    requestTimeoutMs: 99999,
    macAddress: 'aa-bb-cc-dd-ee-ff',
    statusUrl: '  http://a/status  ',
  });
  assert.equal(config.pollIntervalSec, 5);
  assert.equal(config.requestTimeoutMs, 30000);
  assert.equal(config.macAddress, 'AA:BB:CC:DD:EE:FF');
  assert.equal(config.statusUrl, 'http://a/status');
});

