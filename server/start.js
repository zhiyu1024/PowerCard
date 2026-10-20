#!/usr/bin/env node
/**
 * 服务启动入口：解析环境变量、监听端口、打印访问地址。
 *
 * 环境变量：
 * - PORT         监听端口，默认 8787
 * - HOST         监听地址，默认 0.0.0.0（手机需要局域网访问）
 * - CONFIG_PATH  配置文件路径，默认 <项目根>/data/config.json
 *
 * 真正的 HTTP 逻辑在 server.js / createServer()，本文件保持“薄入口”。
 */
import os from 'node:os';
import path from 'node:path';
import { createServer } from './server.js';
import { isDemoConfig } from './config.js';
import { DEFAULT_CONFIG_PATH, DEFAULT_PUBLIC_DIR } from './version.js';

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '0.0.0.0';

function resolvePort(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[powercard] PORT 无效：“${raw}”，需为 1–65535 的整数`);
    process.exit(1);
  }
  return port;
}

function resolveHost(raw) {
  const host = typeof raw === 'string' ? raw.trim() : '';
  return host || DEFAULT_HOST;
}

/** 列出本机所有非回环 IPv4 地址，用于打印局域网访问入口。 */
function listLanIPv4() {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

const PORT = resolvePort(process.env.PORT);
const HOST = resolveHost(process.env.HOST);
const CONFIG_PATH = process.env.CONFIG_PATH ? path.resolve(process.env.CONFIG_PATH) : DEFAULT_CONFIG_PATH;

const server = createServer({
  configPath: CONFIG_PATH,
  publicDir: DEFAULT_PUBLIC_DIR,
  warn: (message) => console.warn(`[powercard] ${message}`),
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[powercard] 端口 ${PORT} 已被占用，请关闭占用进程或使用 PORT 环境变量指定其它端口`);
  } else if (error?.code === 'EACCES') {
    console.error(`[powercard] 没有权限监听 ${HOST}:${PORT}，请换用更大端口或检查系统权限`);
  } else {
    console.error(`[powercard] 服务启动失败：${error?.message || error}`);
  }
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : PORT;
  const mode = isDemoConfig(server.app.store.get()) ? 'demo' : 'live';

  console.log('远程电脑控制服务已启动');
  console.log(`  监听地址: ${HOST}:${actualPort}`);
  console.log(`  本机访问: http://127.0.0.1:${actualPort}`);
  for (const ip of listLanIPv4()) {
    console.log(`  局域网访问: http://${ip}:${actualPort}`);
  }
  console.log(`  运行模式: ${mode === 'demo' ? '演示模式（未配置设备接口 URL）' : '连接真实设备'}`);
  console.log(`  配置文件: ${CONFIG_PATH}`);
  if (mode === 'demo') {
    console.log('  提示: 打开页面右上角“调试与设置”填入设备接口 URL 即可切换到真实设备');
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到 ${signal}，正在关闭服务…`);

  // 兜底：3 秒内没有优雅关闭则强制退出，避免长连接导致 Ctrl+C 无效。
  const forceTimer = setTimeout(() => process.exit(0), 3000);
  forceTimer.unref();

  server.close(() => {
    clearTimeout(forceTimer);
    console.log('服务已关闭');
    process.exit(0);
  });
  // 主动断开 keep-alive 连接，让 close 尽快完成。
  server.closeAllConnections?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
