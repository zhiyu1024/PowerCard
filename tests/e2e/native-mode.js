/**
 * Android 原生模式浏览器模拟测试。
 *
 * 不启动 Android，而是在 Chromium 里注入 window.PowerCardNative，
 * 验证 native-bridge.js + native-api.js + 现有 app.js 的完整交互。
 * 该测试覆盖 APK WebView 内会走到的 JS 路径；Java 原生层由 APK 构建/静态检查覆盖。
 *
 * 运行：node tests/e2e/native-mode.js
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync, promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ART_DIR = path.join(ROOT, 'qa', 'artifacts');
const LOCAL_BROWSER = path.join(
  ROOT,
  '.pw-browsers',
  'chrome-headless-shell',
  'chrome-headless-shell-win64',
  'chrome-headless-shell.exe',
);
const BROWSER_EXE = process.env.CHROMIUM_PATH || (existsSync(LOCAL_BROWSER) ? LOCAL_BROWSER : '');
const results = [];
let browser = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 模拟 APK 内的 WebViewAssetLoader：
 * https://appassets.androidplatform.net/assets/public/index.html
 * 在测试里用 http://127.0.0.1:port/assets/public/index.html 等价加载。
 */
function createAssetServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://local');
    const prefix = '/assets/public/';
    if (!url.pathname.startsWith(prefix)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    const relative = decodeURIComponent(url.pathname.slice(prefix.length));
    if (!relative || relative.includes('..') || relative.includes('\\')) {
      response.writeHead(400);
      response.end('bad path');
      return;
    }
    const filePath = path.join(PUBLIC_DIR, relative);
    try {
      const content = await fsp.readFile(filePath);
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(content);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
    }
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve(server.address().port));
    server.listen(0, '127.0.0.1');
  });
}

async function close(server) {
  if (!server || !server.listening) return;
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function screenshot(page, name) {
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  });
  await page.screenshot({ path: path.join(ART_DIR, name), fullPage: false });
}

async function runCase(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, status: 'pass', durationMs: Date.now() - started });
    console.log(`PASS  ${name}  (${Date.now() - started}ms)`);
  } catch (error) {
    results.push({ name, status: 'fail', durationMs: Date.now() - started, error: String(error && error.stack ? error.stack : error) });
    console.log(`FAIL  ${name}  (${Date.now() - started}ms)`);
    console.log(String(error && error.stack ? error.stack : error));
  }
}

/**
 * 在页面脚本执行前注入假的 PowerCardNative。
 * 配置和电源状态用 localStorage 保存，页面 reload 后仍保持一致。
 */
function fakeNativeInit() {
  const httpGet = (id, url) => {
    const online = localStorage.getItem('native-online') !== 'false';
    let power = localStorage.getItem('native-power') || 'on';
    const clean = String(url || '').split('?')[0];
    if (clean.endsWith('/off')) power = 'off';
    if (clean.endsWith('/on')) power = 'on';
    if (clean.endsWith('/reboot')) power = 'on';
    localStorage.setItem('native-power', power);
    const body = JSON.stringify({ status: 0, msg: 'OK', data: { online, power } });
    window.setTimeout(() => {
      window.__powercardHttpResult(id, {
        ok: true,
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body,
        truncated: false,
        latencyMs: 18,
        error: null,
      });
    }, 40);
  };

  window.PowerCardNative = {
    getConfigJson: () => localStorage.getItem('native-config') || '{}',
    saveConfigJson: (json) => {
      localStorage.setItem('native-config', String(json));
      return true;
    },
    httpGet,
    getAppVersion: () => '1.0.0',
  };
}

async function main() {
  await fsp.mkdir(ART_DIR, { recursive: true });
  const assetServer = createAssetServer();
  const port = await listen(assetServer);
  const baseUrl = `http://127.0.0.1:${port}/assets/public/index.html`;
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-breakpad', '--disable-dev-shm-usage'],
  };
  if (BROWSER_EXE) launchOptions.executablePath = BROWSER_EXE;
  else launchOptions.channel = process.env.PW_CHANNEL || 'msedge';

  const diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [] };

  try {
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-CN' });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => diagnostics.pageErrors.push(String(error)));
    page.on('requestfailed', (request) => diagnostics.failedRequests.push(`${request.method()} ${request.url()}`));
    await page.addInitScript(fakeNativeInit);

    await runCase('原生模式：注入原生桥，首屏进入演示模式', async () => {
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      assertEqual(await page.evaluate(() => window.__POWERCARD_NATIVE__), true, '应识别原生模式');
      assertEqual(await page.locator('#heroTitle').innerText(), '电脑已开机', '演示模式状态');
      assertEqual(await page.locator('#heroStatusText').innerText(), '开机卡在线', '在线状态');
      assert((await page.locator('#demoBadge').innerText()).includes('演示模式'), '应显示演示徽标');
      await screenshot(page, 'native-home-demo.png');
    });

    await runCase('原生模式：设置保存 4 个 URL 后切换 live', async () => {
      await page.locator('#settingsBtn').click();
      await page.waitForTimeout(250);
      await page.locator('#statusUrl').fill('http://device.local/status');
      await page.locator('#powerOnUrl').fill('http://device.local/on');
      await page.locator('#powerOffUrl').fill('http://device.local/off');
      await page.locator('#rebootUrl').fill('http://device.local/reboot');
      await page.locator('#wanAddress').fill('https://device.example.com');
      await page.locator('#lanAddress').fill('192.168.1.50');
      await page.locator('#subnetMask').fill('255.255.255.0');
      await page.locator('#gateway').fill('192.168.1.1');
      await page.locator('#macAddress').fill('aabbccddeeff');
      await page.locator('#settingsSave').click();
      await page.waitForFunction(() => !document.getElementById('settingsDialog').open, null, { timeout: 5000 });
      await page.waitForTimeout(1200);
      assertEqual(await page.locator('#demoBadge').isVisible(), false, 'live 模式不应有演示徽标');
      assert((await page.locator('#subtitle').innerText()).includes('局域网直连'), '副标题应显示局域网直连');
      assertEqual(await page.locator('#heroTitle').innerText(), '电脑已开机', 'live 状态应来自原生桥');
      const cfg = await page.evaluate(() => JSON.parse(localStorage.getItem('native-config') || '{}'));
      assertEqual(cfg.statusUrl, 'http://device.local/status', '配置应写入原生存储');
      assertEqual(cfg.macAddress, 'AA:BB:CC:DD:EE:FF', 'MAC 应归一化');
      await screenshot(page, 'native-live.png');
    });

    await runCase('原生模式：关机/开机都需要二次确认', async () => {
      await page.locator('#powerOffBtn').click();
      await page.waitForFunction(() => document.getElementById('confirmDialog').open, null, { timeout: 3000 });
      assertEqual(await page.locator('#confirmTitle').innerText(), '确认关机？', '关机确认标题');
      await page.locator('#confirmOk').click();
      await page.waitForTimeout(2300);
      assertEqual(await page.locator('#heroTitle').innerText(), '电脑已关机', '关机后状态');

      await page.locator('#powerOnBtn').click();
      await page.waitForFunction(() => document.getElementById('confirmDialog').open, null, { timeout: 3000 });
      assertEqual(await page.locator('#confirmTitle').innerText(), '确认开机？', '开机确认标题');
      assertEqual(await page.locator('#confirmIcon').getAttribute('data-tone'), 'success', '开机确认图标 tone');
      await page.locator('#confirmOk').click();
      await page.waitForTimeout(2300);
      assertEqual(await page.locator('#heroTitle').innerText(), '电脑已开机', '开机后状态');
      await screenshot(page, 'native-on.png');
    });

    await runCase('原生模式：日志面板包含 native status/command，且不注册 SW', async () => {
      await page.locator('#settingsBtn').click();
      await page.waitForTimeout(250);
      await page.locator('#loadLogsBtn').click();
      await page.waitForTimeout(300);
      const logText = await page.locator('#logsBox').innerText();
      assert(logText.includes('状态'), '日志应包含状态记录');
      assert(logText.includes('指令'), '日志应包含指令记录');
      await screenshot(page, 'native-settings.png');
      const sw = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return null;
        const reg = await navigator.serviceWorker.getRegistration();
        return reg ? reg.scope : null;
      });
      assertEqual(sw, null, '原生模式不应注册 Service Worker');
    });

    await runCase('原生模式：刷新后配置保持 live', async () => {
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(900);
      assertEqual(await page.locator('#heroTitle').innerText(), '电脑已开机', '刷新后状态');
      assertEqual(await page.locator('#demoBadge').isVisible(), false, '刷新后仍是 live');
    });

    await runCase('原生模式：无 console error / pageerror / 失败请求', async () => {
      assertEqual(diagnostics.consoleErrors.length, 0, `console error: ${diagnostics.consoleErrors.join(' | ')}`);
      assertEqual(diagnostics.pageErrors.length, 0, `pageerror: ${diagnostics.pageErrors.join(' | ')}`);
      assertEqual(diagnostics.failedRequests.length, 0, `失败请求: ${diagnostics.failedRequests.join(' | ')}`);
    });
  } finally {
    if (browser) await browser.close();
    await close(assetServer);
  }

  const passed = results.filter((item) => item.status === 'pass').length;
  const failed = results.length - passed;
  console.log('\n' + '='.repeat(60));
  console.log(`原生模式用例：${results.length}  通过：${passed}  失败：${failed}`);
  console.log('='.repeat(60));
  await fsp.writeFile(
    path.join(ART_DIR, 'native-results.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), results, diagnostics }, null, 2),
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
