/**
 * 设备访问层单元测试：raw 截断、URL 校验、网络错误映射。
 * 超时行为由集成测试覆盖（真实 mock 设备 + AbortSignal）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RAW_CHARS, fetchDevice, makeRaw } from '../../server/device.js';

test('raw 最长为 8192 字符，超出标记 truncated', () => {
  const exact = makeRaw('text/plain', 'a'.repeat(MAX_RAW_CHARS));
  assert.equal(exact.truncated, false);
  assert.equal(exact.body.length, MAX_RAW_CHARS);

  const overflow = makeRaw('text/plain', 'a'.repeat(MAX_RAW_CHARS + 1));
  assert.equal(overflow.truncated, true);
  assert.equal(overflow.body.length, MAX_RAW_CHARS);

  assert.deepEqual(makeRaw('', ''), { contentType: '', body: '', truncated: false });
});

test('空 / 非法 URL 不发请求，映射为 INVALID_URL', async () => {
  for (const url of ['', '   ', 'ftp://device/status', 'not a url', 'http://device/status#frag']) {
    const result = await fetchDevice(url, { timeoutMs: 1000 });
    assert.equal(result.ok, false, String(url));
    assert.equal(result.error.code, 'INVALID_URL', String(url));
    assert.equal(result.raw, null);
    assert.equal(result.httpStatus, null);
  }
});

test('连接失败映射为 NETWORK 错误（不抛异常）', async () => {
  // 端口 1 基本不会监听；连接应被立即拒绝
  const result = await fetchDevice('http://127.0.0.1:1/status', { timeoutMs: 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NETWORK');
  assert.match(result.error.message, /无法连接设备/);
  assert.equal(result.httpStatus, null);
});
