/**
 * 配置校验 / MAC 归一化 / 原子持久化单元测试。
 * 持久化测试只写系统临时目录，绝不触碰真实 data/config.json。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG_DEFAULTS,
  ConfigStore,
  isDemoConfig,
  normalizeMac,
  validateConfig,
  validateHttpUrl,
} from '../../server/config.js';

/** 创建临时工作目录，注册自动清理。 */
async function makeTempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'powercard-config-test-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('空对象得到全部默认值（缺失字段取默认值）', () => {
  const result = validateConfig({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.config, { ...CONFIG_DEFAULTS });
});

test('未知字段被忽略，null 按缺失处理', () => {
  const result = validateConfig({ unknownField: 'x', statusUrl: null, pollIntervalSec: null });
  assert.equal(result.ok, true);
  assert.equal('unknownField' in result.config, false);
  assert.equal(result.config.statusUrl, '');
  assert.equal(result.config.pollIntervalSec, 10);
});

test('合法 URL 保留查询串，http/https 均可用', () => {
  const result = validateConfig({
    statusUrl: ' http://192.168.1.50/api/status?token=a%20b ',
    rebootUrl: 'https://example.com:8443/reboot?x=1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.config.statusUrl, 'http://192.168.1.50/api/status?token=a%20b');
  assert.equal(result.config.rebootUrl, 'https://example.com:8443/reboot?x=1');
});

test('非法 URL 返回字段级中文错误', () => {
  const cases = [
    ['ftp://example.com/x', /http:\/\/ 或 https:\/\//],
    ['not a url', /格式不正确/],
    ['http://example.com/x#frag', /# 片段/],
    [`http://example.com/${'a'.repeat(2048)}`, /长度不能超过 2048/],
    [12345, /必须是字符串/],
  ];

  for (const [value, expected] of cases) {
    const result = validateConfig({ statusUrl: value });
    assert.equal(result.ok, false, `应拒绝 ${String(value).slice(0, 40)}`);
    assert.match(result.fields.statusUrl, expected);
  }
});

test('validateHttpUrl 单独行为', () => {
  assert.deepEqual(validateHttpUrl(''), { ok: true, value: '' });
  assert.equal(validateHttpUrl('https://a.com').ok, true);
  assert.equal(validateHttpUrl('mailto:x@y.com').ok, false);
});

test('设备资料字段：trim 与 255 长度限制', () => {
  const ok = validateConfig({ lanAddress: '  192.168.1.50  ', gateway: '192.168.1.1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.lanAddress, '192.168.1.50');
  assert.equal(ok.config.gateway, '192.168.1.1');

  const tooLong = validateConfig({ wanAddress: 'a'.repeat(256) });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.fields.wanAddress, /255/);
});

test('MAC 支持四种格式并统一成大写冒号格式', () => {
  const formats = ['aa:bb:cc:dd:ee:ff', 'AA-BB-CC-DD-EE-FF', 'aabb.ccdd.eeff', 'AABBCCDDEEFF'];
  for (const mac of formats) {
    assert.equal(normalizeMac(mac), 'AA:BB:CC:DD:EE:FF', mac);
  }
  assert.equal(normalizeMac(''), '');
  assert.equal(normalizeMac('   '), '');
  assert.equal(normalizeMac('not-a-mac'), null);
  assert.equal(normalizeMac('AA:BB:CC:DD:EE'), null);

  const result = validateConfig({ macAddress: 'aabb.ccdd.eeff' });
  assert.equal(result.ok, true);
  assert.equal(result.config.macAddress, 'AA:BB:CC:DD:EE:FF');

  const invalid = validateConfig({ macAddress: 'zz:bb:cc:dd:ee:ff' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.fields.macAddress, /MAC 地址格式不正确/);
});

test('轮询间隔：5–300 整数，允许数字字符串', () => {
  for (const value of [5, 300, '15']) {
    const result = validateConfig({ pollIntervalSec: value });
    assert.equal(result.ok, true, String(value));
    assert.equal(result.config.pollIntervalSec, Number(value));
  }
  for (const value of [4, 301, 10.5, 'abc', true]) {
    const result = validateConfig({ pollIntervalSec: value });
    assert.equal(result.ok, false, String(value));
    assert.match(result.fields.pollIntervalSec, /5–300/);
  }
});

test('请求超时：1000–30000 整数', () => {
  assert.equal(validateConfig({ requestTimeoutMs: 1000 }).ok, true);
  assert.equal(validateConfig({ requestTimeoutMs: '30000' }).config.requestTimeoutMs, 30000);
  for (const value of [999, 30001, 1.5]) {
    const result = validateConfig({ requestTimeoutMs: value });
    assert.equal(result.ok, false);
    assert.match(result.fields.requestTimeoutMs, /1000–30000/);
  }
});

test('confirmActions 校验', () => {
  assert.equal(validateConfig({ confirmActions: false }).config.confirmActions, false);
  assert.equal(validateConfig({ confirmActions: 'false' }).config.confirmActions, false);
  const invalid = validateConfig({ confirmActions: 'yes' });
  assert.equal(invalid.ok, false);
  assert.match(invalid.fields.confirmActions, /布尔值/);
});

test('状态字段路径：trim，类型错误返回字段错误', () => {
  assert.equal(validateConfig({ powerField: '  data.power  ' }).config.powerField, 'data.power');
  const invalid = validateConfig({ onlineField: 42 });
  assert.equal(invalid.ok, false);
  assert.match(invalid.fields.onlineField, /字符串/);
});

test('多项错误时汇总数量并给出全部字段', () => {
  const result = validateConfig({ statusUrl: 'ftp://x', pollIntervalSec: 1, macAddress: 'bad' });
  assert.equal(result.ok, false);
  assert.equal(result.message, '有 3 项设置需要检查');
  assert.deepEqual(Object.keys(result.fields).sort(), ['macAddress', 'pollIntervalSec', 'statusUrl']);
});

test('请求体不是对象时给出明确错误', () => {
  for (const value of [null, [], 'x', 42]) {
    const result = validateConfig(value);
    assert.equal(result.ok, false);
    assert.equal(result.message, '请求体必须为 JSON 对象');
  }
});

test('演示模式判定：四项 URL 全空', () => {
  assert.equal(isDemoConfig(CONFIG_DEFAULTS), true);
  assert.equal(isDemoConfig({ ...CONFIG_DEFAULTS, lanAddress: '192.168.1.2' }), true);
  assert.equal(isDemoConfig({ ...CONFIG_DEFAULTS, powerOnUrl: 'http://x/on' }), false);
  assert.equal(isDemoConfig({ ...CONFIG_DEFAULTS, statusUrl: 'http://x/status' }), false);
});

test('ConfigStore：配置文件不存在时使用默认值且不抛错', async (t) => {
  const dir = await makeTempDir(t);
  const store = new ConfigStore(path.join(dir, 'data', 'config.json'));
  const config = store.load();
  assert.deepEqual(config, { ...CONFIG_DEFAULTS });
});

test('ConfigStore：保存后可重新加载（原子写入往返）', async (t) => {
  const dir = await makeTempDir(t);
  const configPath = path.join(dir, 'data', 'config.json');
  const store = new ConfigStore(configPath);
  store.load();

  const validated = validateConfig({
    statusUrl: 'http://192.168.1.50/status',
    macAddress: 'aabb.ccdd.eeff',
    pollIntervalSec: 30,
  });
  assert.equal(validated.ok, true);
  await store.save(validated.config);

  const onDisk = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  assert.equal(onDisk.statusUrl, 'http://192.168.1.50/status');
  assert.equal(onDisk.macAddress, 'AA:BB:CC:DD:EE:FF');

  const reloaded = new ConfigStore(configPath);
  assert.deepEqual(reloaded.load(), validated.config);
});

test('ConfigStore：配置文件损坏时降级为默认配置并给出警告', async (t) => {
  const dir = await makeTempDir(t);
  const configPath = path.join(dir, 'data', 'config.json');
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, '{ not json', 'utf8');

  const warnings = [];
  const store = new ConfigStore(configPath, { warn: (message) => warnings.push(message) });
  assert.deepEqual(store.load(), { ...CONFIG_DEFAULTS });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /JSON/);
});

test('ConfigStore：磁盘配置字段非法时降级为默认配置', async (t) => {
  const dir = await makeTempDir(t);
  const configPath = path.join(dir, 'data', 'config.json');
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify({ statusUrl: 'ftp://bad', pollIntervalSec: 999 }), 'utf8');

  const warnings = [];
  const store = new ConfigStore(configPath, { warn: (message) => warnings.push(message) });
  assert.deepEqual(store.load(), { ...CONFIG_DEFAULTS });
  assert.equal(warnings.length, 1);
});
