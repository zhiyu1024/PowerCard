/**
 * 内存环形日志单元测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestLog } from '../../server/logs.js';

test('最新在前，id 单调且带时间戳', () => {
  const log = new RequestLog(5);
  log.add({ kind: 'status', url: 'http://a/status', ok: true, latencyMs: 12, raw: { body: '{"power":1}' } });
  log.add({ kind: 'command', url: 'http://a/on', ok: true, latencyMs: 30, raw: { body: 'OK' } });

  const entries = log.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'command');
  assert.equal(entries[1].kind, 'status');
  for (const entry of entries) {
    assert.match(entry.id, /^l_\d+_\d+$/);
    assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(entry.method, 'GET');
  }
});

test('容量上限为 30，超出丢弃最旧记录', () => {
  const log = new RequestLog();
  for (let index = 0; index < 35; index += 1) {
    log.add({ kind: 'status', url: `http://a/status/${index}`, ok: true, latencyMs: index });
  }
  const entries = log.list();
  assert.equal(entries.length, 30);
  assert.equal(entries[0].url, 'http://a/status/34');
  assert.equal(entries.at(-1).url, 'http://a/status/5');
});

test('rawPreview 截断到 300 字符以内，错误对象原样保留', () => {
  const log = new RequestLog();
  const body = 'x'.repeat(500);
  const error = { code: 'TIMEOUT', message: '请求超时（1000 ms）' };
  log.add({ kind: 'status', url: null, ok: false, latencyMs: 1000, error, raw: { body } });

  const [entry] = log.list();
  assert.equal(entry.rawPreview.length, 301); // 300 + 省略号
  assert.ok(entry.rawPreview.endsWith('…'));
  assert.deepEqual(entry.error, error);
  assert.equal(entry.url, null);
  assert.equal(entry.httpStatus, null);
});

test('list 返回副本，外部修改不影响内部状态', () => {
  const log = new RequestLog();
  log.add({ kind: 'status', url: 'http://a', ok: true, latencyMs: 1 });
  const entries = log.list();
  entries[0].kind = 'hacked';
  entries.length = 0;
  assert.equal(log.list().length, 1);
  assert.equal(log.list()[0].kind, 'status');
});
