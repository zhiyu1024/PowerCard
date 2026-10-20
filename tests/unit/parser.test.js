/**
 * 状态解析器单元测试（docs/api-contract.md 第 5 节）。
 * 解析器不涉及网络，直接用响应文本驱动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapOnlineValue,
  mapPowerValue,
  normalizeKey,
  parseStatusResponse,
  powerLabel,
  resolveFieldPath,
} from '../../server/parser.js';

test('JSON 自动识别电源与在线字段（power:1 / online:true）', () => {
  const result = parseStatusResponse({
    text: JSON.stringify({ power: 1, online: true }),
    contentType: 'application/json; charset=utf-8',
  });

  assert.equal(result.power, 'on');
  assert.equal(result.online, true);
  assert.equal(result.onlineInferred, false);
  assert.deepEqual(result.mapping, { powerField: 'power', onlineField: 'online' });
  assert.equal(result.warning, null);
});

test('JSON 嵌套字段：data.power / data.online', () => {
  const result = parseStatusResponse({
    text: JSON.stringify({ data: { power: 'off', online: 0 } }),
    contentType: 'application/json',
  });

  assert.equal(result.power, 'off');
  assert.equal(result.online, false);
  assert.equal(result.onlineInferred, false);
  assert.deepEqual(result.mapping, { powerField: 'data.power', onlineField: 'data.online' });
});

test('手动字段优先于自动识别', () => {
  const result = parseStatusResponse({
    text: JSON.stringify({ status: 'off', data: { power: 'on' } }),
    contentType: 'application/json',
    powerField: 'data.power',
  });

  assert.equal(result.power, 'on');
  assert.equal(result.mapping.powerField, 'data.power');
});

test('手动字段支持数组下标 items.0.state', () => {
  const result = parseStatusResponse({
    text: JSON.stringify({ items: [{ state: 'on' }] }),
    contentType: 'application/json',
    powerField: 'items.0.state',
  });

  assert.equal(result.power, 'on');
  assert.equal(result.mapping.powerField, 'items.0.state');
});

test('手动手段未命中时回退自动识别', () => {
  const result = parseStatusResponse({
    text: JSON.stringify({ data: { power: 'on' } }),
    contentType: 'application/json',
    powerField: 'does.not.exist',
  });

  assert.equal(result.power, 'on');
  assert.equal(result.mapping.powerField, 'data.power');
});

test('JSON 递归深度上限为 5：第 5 层可见，第 6 层忽略', () => {
  const visible = parseStatusResponse({
    text: JSON.stringify({ a: { b: { c: { d: { power: 'on' } } } } }),
    contentType: 'application/json',
  });
  assert.equal(visible.power, 'on');
  assert.equal(visible.mapping.powerField, 'a.b.c.d.power');

  const tooDeep = parseStatusResponse({
    text: JSON.stringify({ a: { b: { c: { d: { e: { power: 'on' } } } } } }),
    contentType: 'application/json',
  });
  assert.equal(tooDeep.power, 'unknown');
  assert.notEqual(tooDeep.warning, null);
});

test('泛化键名 status 只有值明确映射时才采用', () => {
  const clear = parseStatusResponse({
    text: JSON.stringify({ status: 'running' }),
    contentType: 'application/json',
  });
  assert.equal(clear.power, 'on');
  assert.equal(clear.mapping.powerField, 'status');

  const ambiguous = parseStatusResponse({
    text: JSON.stringify({ status: 'online' }),
    contentType: 'application/json',
  });
  assert.equal(ambiguous.power, 'unknown');
  assert.equal(ambiguous.online, true);
  assert.equal(ambiguous.onlineInferred, true);
});

test('API 信封里的 status:0 是接口状态码，不能被当成关机', () => {
  // 真实开机卡返回：{"status":0,"msg":"OK","data":{"online":true,"power":"on"}}
  const result = parseStatusResponse({
    text: JSON.stringify({ status: 0, msg: 'OK', data: { online: true, power: 'on' } }),
    contentType: 'application/json; charset=utf-8',
  });

  assert.equal(result.power, 'on');
  assert.equal(result.online, true);
  assert.equal(result.onlineInferred, false);
  assert.deepEqual(result.mapping, { powerField: 'data.power', onlineField: 'data.online' });
  assert.equal(result.warning, null);
});

test('API 信封缺少 data.power 时保持 unknown，而不是把 status:0 读成关机', () => {
  const result = parseStatusResponse({
    text: JSON.stringify({ status: 0, msg: 'OK', data: { online: false } }),
    contentType: 'application/json',
  });

  assert.equal(result.power, 'unknown');
  assert.equal(result.online, false);
  assert.equal(result.onlineInferred, false);
  assert.notEqual(result.warning, null);
});

test('语义更具体的字段优先于泛化字段', () => {
  const result = parseStatusResponse({
    text: JSON.stringify({ status: 'off', power: 'on' }),
    contentType: 'application/json',
  });
  assert.equal(result.power, 'on');
  assert.equal(result.mapping.powerField, 'power');
});

test('纯文本 key=value 行解析', () => {
  const result = parseStatusResponse({
    text: 'power=off\nonline=1',
    contentType: 'text/plain; charset=utf-8',
  });

  assert.equal(result.power, 'off');
  assert.equal(result.online, true);
  assert.equal(result.mapping.powerField, 'power');
  assert.equal(result.mapping.onlineField, 'online');
});

test('纯文本整体词元解析（已开机）', () => {
  const result = parseStatusResponse({ text: '  已开机  ', contentType: 'text/plain' });
  assert.equal(result.power, 'on');
  assert.equal(result.online, true);
  assert.equal(result.onlineInferred, true);
});

test('HTML 同时包含“开机”“关机”时不得猜测电源状态', () => {
  const result = parseStatusResponse({
    text: '<html><body><h1>开机</h1><button>关机</button><p>开机卡在线</p></body></html>',
    contentType: 'text/html; charset=utf-8',
  });

  assert.equal(result.power, 'unknown');
  assert.equal(result.warning, '已连接，但无法识别电源状态；请在调试中指定字段或查看原始响应');
  // “开机卡在线”只说明设备在线，不参与电源判断
  assert.equal(result.online, true);
  assert.equal(result.onlineInferred, false);
});

test('“开机卡在线”这类设备名文案不会被误判为开机', () => {
  const result = parseStatusResponse({
    text: '<div>开机卡在线</div>',
    contentType: 'text/html',
  });

  assert.equal(result.power, 'unknown');
  assert.notEqual(result.warning, null);
  assert.equal(result.online, true);
});

test('HTML 只出现一种明确的电源描述时可识别', () => {
  const result = parseStatusResponse({
    text: '<html><body><p>电脑已开机</p><p>开机卡在线</p></body></html>',
    contentType: 'text/html',
  });

  assert.equal(result.power, 'on');
  assert.equal(result.online, true);
  assert.equal(result.warning, null);
});

test('HTML 含“离线”时可判断为离线', () => {
  const result = parseStatusResponse({
    text: '<div>设备状态：离线</div>',
    contentType: 'text/html',
  });

  assert.equal(result.online, false);
  assert.equal(result.onlineInferred, false);
  assert.equal(result.power, 'unknown');
});

test('请求成功但完全无法识别时：online=true / onlineInferred=true / warning 非空', () => {
  const result = parseStatusResponse({ text: '无法识别的响应内容', contentType: 'text/plain' });

  assert.equal(result.power, 'unknown');
  assert.equal(result.online, true);
  assert.equal(result.onlineInferred, true);
  assert.equal(result.mapping, null);
  assert.match(result.warning, /无法识别电源状态/);
});

test('纯文本 "OK" 按在线词元 "ok" 识别为在线（不推断）', () => {
  const result = parseStatusResponse({ text: 'OK', contentType: 'text/plain' });

  assert.equal(result.power, 'unknown');
  assert.equal(result.online, true);
  assert.equal(result.onlineInferred, false);
  assert.equal(result.mapping, null);
  assert.notEqual(result.warning, null);
});

test('content-type 声称 JSON 但内容不是 JSON 时回退文本解析', () => {
  const result = parseStatusResponse({
    text: 'power: off',
    contentType: 'application/json',
  });

  assert.equal(result.power, 'off');
});

test('在线字段显式为 false 时不会被“能访问即在线”覆盖', () => {
  const result = parseStatusResponse({
    text: JSON.stringify({ power: 'on', online: false }),
    contentType: 'application/json',
  });

  assert.equal(result.online, false);
  assert.equal(result.onlineInferred, false);
  assert.equal(result.power, 'on');
});

test('值映射：布尔、数字、字符串与非法值', () => {
  assert.equal(mapPowerValue(true), 'on');
  assert.equal(mapPowerValue(false), 'off');
  assert.equal(mapPowerValue(1), 'on');
  assert.equal(mapPowerValue(0), 'off');
  assert.equal(mapPowerValue('ON'), 'on');
  assert.equal(mapPowerValue(' 已开机 '), 'on');
  assert.equal(mapPowerValue('off'), 'off');
  assert.equal(mapPowerValue('关机'), 'off');
  assert.equal(mapPowerValue(2), null);
  assert.equal(mapPowerValue('unknown'), null);
  assert.equal(mapPowerValue(null), null);

  assert.equal(mapOnlineValue(true), true);
  assert.equal(mapOnlineValue(false), false);
  assert.equal(mapOnlineValue(1), true);
  assert.equal(mapOnlineValue(0), false);
  assert.equal(mapOnlineValue('在线'), true);
  assert.equal(mapOnlineValue('离线'), false);
  assert.equal(mapOnlineValue('maybe'), null);
});

test('键名归一化：大小写、下划线、连字符、空格', () => {
  assert.equal(normalizeKey('Power_State'), 'powerstate');
  assert.equal(normalizeKey('power-status'), 'powerstatus');
  assert.equal(normalizeKey('is online'), 'isonline');
  assert.equal(normalizeKey('ONLINE'), 'online');
});

test('字段路径解析支持数组下标', () => {
  const root = { items: [{ state: 'on' }] };
  assert.equal(resolveFieldPath(root, 'items.0.state'), 'on');
  assert.equal(resolveFieldPath(root, 'items.1.state'), undefined);
  assert.equal(resolveFieldPath(root, 'items.0.state.x'), undefined);
});

test('电源文案映射', () => {
  assert.equal(powerLabel('on'), '电脑已开机');
  assert.equal(powerLabel('off'), '电脑已关机');
  assert.equal(powerLabel('unknown'), '状态未知');
});
