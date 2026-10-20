#!/usr/bin/env node
/**
 * 开发用模拟开机卡 HTTP 服务（可选工具，不参与运行时）。
 *
 * 用法：
 *   node scripts/dev-mock-device.js            # 默认监听 127.0.0.1:8788
 *   node scripts/dev-mock-device.js 8890
 *
 * 然后把设置里的四个 URL 填成：
 *   状态查询 URL: http://127.0.0.1:8788/status
 *   开机 URL:     http://127.0.0.1:8788/power/on
 *   关机 URL:     http://127.0.0.1:8788/power/off
 *   重启 URL:     http://127.0.0.1:8788/reboot
 *
 * 另外提供几个用于验证解析器的状态地址：
 *   /status/text       纯文本 power=on
 *   /status/nested     嵌套 JSON data.power
 *   /status/ambiguous  HTML 同时包含“开机/关机”（应解析为状态未知）
 *   /status/slow       3 秒后才返回（用于验证超时）
 *   /status/error      HTTP 500
 */
import http from 'node:http';

const port = Number(process.env.MOCK_PORT || process.argv[2] || 8788);
const HOST = '127.0.0.1';

let power = 'on';
let online = true;

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendText(response, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', `http://${HOST}:${port}`);
  const pathname = url.pathname;
  console.log(`${request.method} ${pathname}`);

  if (pathname === '/status') return sendJson(response, 200, { demo: true, online, power });
  if (pathname === '/status/nested') return sendJson(response, 200, { data: { power: power === 'on' ? 1 : 0, online: online ? 1 : 0 } });
  if (pathname === '/status/text') return sendText(response, 200, `power=${power}\nonline=${online ? 1 : 0}`);
  if (pathname === '/status/ambiguous') {
    return sendText(response, 200, '<html><body><h1>开机</h1><button>关机</button><p>开机卡在线</p></body></html>', 'text/html; charset=utf-8');
  }
  if (pathname === '/status/slow') {
    setTimeout(() => sendJson(response, 200, { online, power }), 3000);
    return;
  }
  if (pathname === '/status/error') return sendText(response, 500, '模拟设备错误');
  if (pathname === '/power/on') {
    power = 'on';
    return sendText(response, 200, 'OK');
  }
  if (pathname === '/power/off') {
    power = 'off';
    return sendText(response, 200, 'OK');
  }
  if (pathname === '/reboot') {
    online = true;
    power = 'on';
    return sendText(response, 200, 'OK');
  }
  sendText(response, 404, 'not found');
});

server.listen(port, HOST, () => {
  console.log(`模拟开机卡已启动: http://${HOST}:${port}`);
  console.log(`  状态查询 URL: http://${HOST}:${port}/status`);
  console.log(`  开机 URL:     http://${HOST}:${port}/power/on`);
  console.log(`  关机 URL:     http://${HOST}:${port}/power/off`);
  console.log(`  重启 URL:     http://${HOST}:${port}/reboot`);
});

process.on('SIGINT', () => {
  console.log('\n正在关闭模拟设备…');
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
});
