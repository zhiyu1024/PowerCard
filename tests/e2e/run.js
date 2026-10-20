#!/usr/bin/env node
/**
 * 远程电脑控制 · 浏览器端到端验收（独立 QA）
 *
 * 设计原则（对齐 task-3）：
 * - 使用 server/server.js 的 createServer({configPath, publicDir}) 在随机端口启动被测应用，
 *   configPath 指向 os.tmpdir() 下的临时目录；绝不触碰 8787 与真实 data/config.json。
 * - mock 设备全部本地随机端口：连接测试复用 tests/integration/support.js 的
 *   startMockDevice()，live 控制场景使用本文件内的“有状态 mock”（关机后状态接口返回 off）。
 * - 真实 Chromium（.pw-browsers/chrome-headless-shell），真实点击、真实断言 DOM/计算样式，
 *   截图只是证据，不作为通过依据。
 * - 任一硬性断言失败 → 进程退出码 1；全部通过 → 0。finally 中关闭 browser / server / mock。
 *
 * 运行：node tests/e2e/run.js
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { existsSync, promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../server/server.js';
import { startMockDevice } from '../integration/support.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ART_DIR = path.join(ROOT, 'qa', 'artifacts');
const LOCAL_BROWSER_EXE = path.join(
  ROOT,
  '.pw-browsers',
  'chrome-headless-shell',
  'chrome-headless-shell-win64',
  'chrome-headless-shell.exe',
);
const BROWSER_EXE =
  process.env.CHROMIUM_PATH || (existsSync(LOCAL_BROWSER_EXE) ? LOCAL_BROWSER_EXE : '');
const EXPECTED_SETTINGS_FIELDS = [
  'statusUrl',
  'powerOnUrl',
  'powerOffUrl',
  'rebootUrl',
  'wanAddress',
  'lanAddress',
  'subnetMask',
  'gateway',
  'macAddress',
  'powerField',
  'onlineField',
  'pollIntervalSec',
  'requestTimeoutSec',
  'confirmActions',
];
const EXPECTED_LABELS = {
  statusUrl: '状态查询 URL',
  powerOnUrl: '开机 URL',
  powerOffUrl: '关机 URL',
  rebootUrl: '重启 URL',
  wanAddress: '公网地址',
  lanAddress: '内网地址',
  subnetMask: '子网掩码',
  gateway: '默认网关',
  macAddress: '物理地址（MAC）',
  powerField: '电源状态字段',
  onlineField: '在线状态字段',
  pollIntervalSec: '轮询间隔',
  requestTimeoutSec: '请求超时',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------------------------------------------------------
   进程/服务工具
   -------------------------------------------------------------------------- */

function listenOnRandomPort(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(address && typeof address === 'object' ? address.port : 0);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** 有状态 mock 设备：/status/json 反映当前 power；指令路由改变状态并记录请求。 */
function startStatefulMockDevice() {
  const state = { powerOn: true, online: true, requests: [], hits: new Map() };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://mock');
    const pathname = url.pathname;
    state.requests.push({ method: request.method, pathname, url: request.url });
    state.hits.set(pathname, (state.hits.get(pathname) || 0) + 1);

    const send = (status, body, contentType = 'application/json; charset=utf-8') => {
      response.writeHead(status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'Content-Length': String(Buffer.byteLength(body)),
      });
      response.end(body);
    };

    switch (pathname) {
      case '/status/json':
        return send(
          200,
          JSON.stringify({ power: state.powerOn ? 1 : 0, online: state.online }),
        );
      case '/power/on':
        state.powerOn = true;
        return send(200, 'OK', 'text/plain; charset=utf-8');
      case '/power/off':
        state.powerOn = false;
        return send(200, 'OK', 'text/plain; charset=utf-8');
      case '/reboot':
        state.powerOn = true;
        return send(200, 'OK', 'text/plain; charset=utf-8');
      default:
        return send(404, 'not found', 'text/plain; charset=utf-8');
    }
  });

  return listenOnRandomPort(server).then((port) => ({
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    hits(pathname) {
      return state.hits.get(pathname) || 0;
    },
    close: () => closeServer(server),
  }));
}

/** 轮询等待 Node 侧条件成立。 */
async function waitFor(predicate, { timeout = 5000, interval = 50, label = '条件' } = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeout) {
    try {
      if (await predicate()) return Date.now() - startedAt;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(
    `等待超时：${label}（${timeout}ms）${lastError ? `；最后错误：${lastError.message}` : ''}`,
  );
}

async function getJson(baseUrl, pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

/* --------------------------------------------------------------------------
   断言 / 用例框架
   -------------------------------------------------------------------------- */

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

function assert(condition, message) {
  if (!condition) throw new AssertionError(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new AssertionError(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

const cases = [];
const screenshots = [];
const metrics = {};
const diagnostics = {
  consoleErrors: [],
  pageErrors: [],
  badResponses: [],
  requestFailures: [],
  putRequests: [],
};

function attachDiagnostics(page, label) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    diagnostics.consoleErrors.push(`[${label}] ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    diagnostics.pageErrors.push(`[${label}] ${error && (error.message || String(error))}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      diagnostics.badResponses.push(`[${label}] HTTP ${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure();
    diagnostics.requestFailures.push(
      `[${label}] ${request.method()} ${request.url()} ${failure ? failure.errorText : ''}`.trim(),
    );
  });
  page.on('request', (request) => {
    if (request.method() === 'PUT') {
      diagnostics.putRequests.push(`[${label}] PUT ${request.url()}`);
    }
  });
}

function assertNoDiagnostics(label) {
  if (diagnostics.consoleErrors.length > 0) {
    throw new AssertionError(`console error：\n${diagnostics.consoleErrors.join('\n')}`);
  }
  if (diagnostics.pageErrors.length > 0) {
    throw new AssertionError(`pageerror：\n${diagnostics.pageErrors.join('\n')}`);
  }
  if (diagnostics.badResponses.length > 0) {
    throw new AssertionError(`HTTP >= 400 响应：\n${diagnostics.badResponses.join('\n')}`);
  }
  if (diagnostics.requestFailures.length > 0) {
    throw new AssertionError(`请求失败：\n${diagnostics.requestFailures.join('\n')}`);
  }
  // 每次检查后清空，让失败归因到具体用例；汇总里仍保留全局记录。
  diagnostics.lastCheckedAt = label;
}

async function runCase(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    const durationMs = Date.now() - startedAt;
    cases.push({ name, status: 'pass', durationMs });
    console.log(`PASS  ${name}  (${durationMs}ms)`);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error && error.stack ? error.stack : String(error);
    cases.push({ name, status: 'fail', durationMs, error: String(message) });
    console.error(`FAIL  ${name}  (${durationMs}ms)`);
    console.error(String(message).split('\n').slice(0, 6).map((line) => `      ${line}`).join('\n'));
  }
}

/* --------------------------------------------------------------------------
   浏览器侧工具
   -------------------------------------------------------------------------- */

async function waitHeroTitle(page, expected, timeout = 8000) {
  await page.waitForFunction(
    (text) => {
      const node = document.getElementById('heroTitle');
      return Boolean(node) && node.textContent.trim() === text;
    },
    expected,
    { timeout },
  );
}

async function waitStatusText(page, expected, timeout = 8000) {
  await page.waitForFunction(
    (text) => {
      const node = document.getElementById('heroStatusText');
      return Boolean(node) && node.textContent.trim() === text;
    },
    expected,
    { timeout },
  );
}

async function waitToast(page, expectedText, timeout = 5000) {
  await page.waitForFunction(
    (text) => {
      const toast = document.getElementById('toast');
      const toastText = document.getElementById('toastText');
      return (
        Boolean(toast) &&
        toast.classList.contains('is-visible') &&
        Boolean(toastText) &&
        toastText.textContent.includes(text)
      );
    },
    expectedText,
    { timeout },
  );
}

async function toastSnapshot(page) {
  return page.evaluate(() => {
    const toast = document.getElementById('toast');
    return {
      count: document.querySelectorAll('.toast').length,
      visible: Boolean(toast && toast.classList.contains('is-visible')),
      text: document.getElementById('toastText')?.textContent.trim() || '',
      tone: toast?.dataset.tone || '',
    };
  });
}

async function screenshot(page, name) {
  await page.mouse.move(2, 2);
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && typeof active.blur === 'function') active.blur();
  });
  await page.waitForTimeout(280);
  const filePath = path.join(ART_DIR, name);
  await page.screenshot({ path: filePath });
  screenshots.push(name);
  return filePath;
}

/* --------------------------------------------------------------------------
   布局 / 视觉测量与断言
   -------------------------------------------------------------------------- */

async function measureLayout(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const css = (selector, property) => {
      const node = document.querySelector(selector);
      return node ? getComputedStyle(node)[property] : null;
    };
    const app = document.querySelector('.app').getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      bodyBg: getComputedStyle(document.body).backgroundColor,
      app: { x: app.x, width: app.width, height: app.height },
      topbar: rect('.topbar'),
      hero: {
        ...rect('#hero'),
        paddingTop: parseFloat(css('#hero', 'paddingTop') || '0'),
        paddingBottom: parseFloat(css('#hero', 'paddingBottom') || '0'),
      },
      title: {
        ...rect('#heroTitle'),
        fontSize: parseFloat(css('#heroTitle', 'fontSize')),
        fontWeight: css('#heroTitle', 'fontWeight'),
        color: css('#heroTitle', 'color'),
        text: document.getElementById('heroTitle').textContent.trim(),
      },
      heroStatus: {
        ...rect('#heroStatus'),
        text: document.getElementById('heroStatusText').textContent.trim(),
        color: css('#heroStatusText', 'color'),
        dotColor: css('#heroStatus .status-dot', 'backgroundColor'),
      },
      heroMeta: { text: document.getElementById('heroMeta').textContent.trim() },
      subtitle: {
        fontSize: parseFloat(css('#subtitle', 'fontSize')),
        color: css('#subtitle', 'color'),
        text: document.getElementById('subtitle').textContent.trim(),
      },
      demoBadge: {
        hidden: document.getElementById('demoBadge').hidden,
        text: document.getElementById('demoBadge').textContent.trim(),
      },
      powerOn: {
        ...rect('#powerOnBtn'),
        radius: css('#powerOnBtn', 'borderRadius'),
        bg: css('#powerOnBtn', 'backgroundColor'),
        labelSize: parseFloat(css('#powerOnLabel', 'fontSize')),
        weight: css('#powerOnLabel', 'fontWeight'),
        iconColor: css('#powerOnBtn .action-icon', 'color'),
      },
      powerOff: {
        ...rect('#powerOffBtn'),
        bg: css('#powerOffBtn', 'backgroundColor'),
        iconColor: css('#powerOffBtn .action-icon', 'color'),
      },
      reboot: {
        ...rect('#rebootBtn'),
        radius: css('#rebootBtn', 'borderRadius'),
        labelSize: parseFloat(css('#rebootLabel', 'fontSize')),
      },
      refresh: {
        ...rect('#refreshBtn'),
        labelSize: parseFloat(css('#refreshBtn .action-label', 'fontSize')),
        ariaLabel: document.getElementById('refreshBtn').getAttribute('aria-label'),
      },
      settingsBtn: rect('#settingsBtn'),
      heroState: document.getElementById('hero').dataset.state,
      settingsBtnLabel: document.getElementById('settingsBtn').getAttribute('aria-label'),
    };
  });
}

function assertFirstScreen(m, { width, height }) {
  const short = height <= 560;
  const expectedTitleSize = width <= 380 ? 28 : short ? 26 : 30;
  const expectedPrimaryHeight = short ? 78 : 108;
  const expectedGhostHeight = short ? 48 : 62;

  // 1) 单列、暖白、无横向滚动、居中
  assertEqual(m.viewport.width, width, '视口宽度');
  assertEqual(m.viewport.height, height, '视口高度');
  assert(m.scroll.width <= m.viewport.width + 1, `出现横向滚动：scrollWidth=${m.scroll.width} > innerWidth=${m.viewport.width}`);
  assert(m.app.width <= 561, `.app 超过 560px：${m.app.width}`);
  assert(Math.abs(m.app.x - (m.viewport.width - m.app.width) / 2) <= 1.5, `单列未居中：app.x=${m.app.x}`);
  assertEqual(m.bodyBg, 'rgb(246, 244, 239)', '页面底色应为暖白 #f6f4ef');
  assertEqual(m.settingsBtnLabel, '调试与设置', '右上调试按钮 aria-label');
  assert(Math.abs(m.settingsBtn.width - 44) <= 0.5 && Math.abs(m.settingsBtn.height - 44) <= 0.5, '调试按钮应为 44×44 点击目标');

  // 2) 视觉层次：标题 > 主按钮 > 小按钮，主操作卡片明显大于次操作
  assert(Math.abs(m.title.fontSize - expectedTitleSize) < 0.6, `标题字号 ${m.title.fontSize}，期望 ${expectedTitleSize}`);
  assert(Number(m.title.fontWeight) >= 600, `标题应为 semibold，实际 ${m.title.fontWeight}`);
  assert(Math.abs(m.subtitle.fontSize - 11.5) < 0.3, `副标题字号 ${m.subtitle.fontSize}，期望 11.5`);
  assert(m.title.fontSize > m.powerOn.labelSize, '标题应大于主按钮文字');
  assert(m.powerOn.labelSize > m.refresh.labelSize, '主按钮文字应大于小按钮文字');
  assert(Math.abs(m.powerOn.height - expectedPrimaryHeight) <= 1.5, `主按钮高度 ${m.powerOn.height}，期望 ${expectedPrimaryHeight}`);
  assert(Math.abs(m.reboot.height - expectedGhostHeight) <= 1.5, `小按钮高度 ${m.reboot.height}，期望 ${expectedGhostHeight}`);
  assert(m.powerOn.height > m.reboot.height + 20, '主/次按钮应有明显大小层次');
  assert(Math.abs(m.powerOn.width - m.powerOff.width) <= 1, '两个主按钮应等宽');
  assert(Math.abs(m.reboot.width - m.refresh.width) <= 1, '两个次按钮应等宽');
  assertEqual(m.powerOn.radius, short ? '18px' : '22px', '主按钮圆角');
  assertEqual(m.reboot.radius, short ? '14px' : '16px', '次按钮圆角');

  // 3) 同一行排布 & 层次顺序
  assert(Math.abs(m.powerOn.y - m.powerOff.y) <= 1, '开机/关机应同一行');
  assert(Math.abs(m.reboot.y - m.refresh.y) <= 1, '重启/刷新应同一行');
  assert(m.reboot.y >= m.powerOn.bottom - 1, '次操作应在主操作下方');
  assert(m.hero.y + m.hero.height <= m.powerOn.y + 1, '状态区应在控制区上方');

  // 4) 颜色语义：暖白卡片、绿色开机、红色关机、主文字深色
  assertEqual(m.powerOn.bg, 'rgb(255, 254, 250)', '主按钮卡片底色应为 #fffefa');
  assertEqual(m.powerOn.iconColor, 'rgb(18, 156, 82)', '开机图标应为绿色 #129c52');
  assertEqual(m.powerOff.iconColor, 'rgb(207, 75, 58)', '关机图标应为红色 #cf4b3a');
  assertEqual(m.title.color, 'rgb(23, 27, 24)', '标题文字应为 --ink #171b18');
  assertEqual(m.subtitle.color, 'rgb(110, 116, 109)', '副标题应为 --muted #6e746d');

  // 5) 状态区：文字 + 绿色圆点（不能只靠颜色）
  assertEqual(m.heroStatus.text, '开机卡在线', '在线状态文案');
  assertEqual(m.heroStatus.color, 'rgb(11, 110, 58)', '在线文字应为 --green-deep');
  assertEqual(m.heroStatus.dotColor, 'rgb(18, 156, 82)', '在线圆点应为绿色');
  assert(m.title.text === '电脑已开机', `首屏标题应为“电脑已开机”，实际“${m.title.text}”`);
  assertEqual(m.heroState, 'on', 'hero data-state 应为 on');

  // 6) 演示模式标识
  assertEqual(m.demoBadge.hidden, false, '演示模式徽标应可见');
  assertEqual(m.demoBadge.text, '演示模式', '演示模式徽标文案');
  assertEqual(m.subtitle.text, '界面演示 · 尚未连接设备', '演示模式副标题');

  // 7) 留白 & 首屏完整：主要控件均在视口内
  assert(m.hero.paddingBottom >= 10, `hero 底部留白不足：${m.hero.paddingBottom}px`);
  for (const key of ['powerOn', 'powerOff', 'reboot', 'refresh']) {
    const rect = m[key];
    assert(rect.y >= -0.5, `${key} 顶部超出首屏：y=${rect.y}`);
    assert(rect.bottom <= m.viewport.height + 0.5, `${key} 底部被首屏裁切：bottom=${rect.bottom} > ${m.viewport.height}`);
  }
  assert(m.settingsBtn.y >= 0 && m.settingsBtn.bottom <= m.viewport.height, '调试按钮应在首屏内');
  assertEqual(m.refresh.ariaLabel, '刷新状态', '刷新按钮 aria-label');
}

/* --------------------------------------------------------------------------
   主流程
   -------------------------------------------------------------------------- */

async function main() {
  await fsp.mkdir(ART_DIR, { recursive: true });

  // 临时配置目录：绝不与真实 data/config.json 发生关系
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'powercard-e2e-'));
  const configPath = path.join(tempDir, 'data', 'config.json');

  const appServer = createServer({
    configPath,
    publicDir: PUBLIC_DIR,
    warn: () => {},
  });
  const appPort = await listenOnRandomPort(appServer);
  const baseUrl = `http://127.0.0.1:${appPort}`;

  const integrationMock = await startMockDevice();
  const statefulMock = await startStatefulMockDevice();

  let browser = null;
  let context = null;
  let page = null;

  try {
    const launchOptions = {
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-breakpad', '--disable-dev-shm-usage'],
    };
    if (BROWSER_EXE) {
      launchOptions.executablePath = BROWSER_EXE;
    } else {
      // 没下载 Chromium 时退回到系统浏览器（Windows 默认 Edge，其它平台可用 PW_CHANNEL 指定）。
      launchOptions.channel = process.env.PW_CHANNEL || 'msedge';
    }
    browser = await chromium.launch(launchOptions).catch((error) => {
      throw new Error(
        [
          '无法启动 Chromium。请任选一种方式：',
          '  1) 设置 CHROMIUM_PATH 指向 chrome/chromium 可执行文件；',
          '  2) 安装系统 Edge/Chrome，并用 PW_CHANNEL=msedge 或 PW_CHANNEL=chrome 指定；',
          '  3) 执行 npx playwright install chromium（playwright-core 不自带浏览器）。',
          `原始错误：${error.message}`,
        ].join('\n'),
      );
    });
    const browserVersion = browser.version();

    // 主流程 context 屏蔽 Service Worker：让 /api 请求完全由 page 网络层处理，
    // 保证刷新按钮 aria-busy 这类瞬时状态可被稳定断言；SW 注册单列用例单独验证。
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      locale: 'zh-CN',
      serviceWorkers: 'block',
    });
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    attachDiagnostics(page, 'main');

    /* ---------------- 1. 演示模式首屏：三档尺寸 ---------------- */
    const viewports = [
      { width: 390, height: 844, shot: 'mobile-home.png' },
      { width: 360, height: 800, shot: 'qa-360x800.png' },
      { width: 765, height: 403, shot: 'qa-765x403.png' },
    ];

    for (const spec of viewports) {
      await runCase(`首屏 ${spec.width}×${spec.height}（演示模式）`, async () => {
        await page.setViewportSize({ width: spec.width, height: spec.height });
        const response = await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 20000 });
        assert(response && response.ok(), `首页 HTTP 状态 ${response && response.status()}`);
        await waitHeroTitle(page, '电脑已开机', 12000);
        await waitStatusText(page, '开机卡在线', 8000);
        await page.waitForTimeout(300);
        const layout = await measureLayout(page);
        assertFirstScreen(layout, spec);
        await screenshot(page, spec.shot);
        assertNoDiagnostics(`首屏 ${spec.width}×${spec.height}`);
      });
    }

    /* ---------------- 2. 桌面 1280×800 视觉 ---------------- */
    await runCase('桌面 1280×800（单列居中 / 视觉层次）', async () => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 20000 });
      await waitHeroTitle(page, '电脑已开机', 12000);
      await waitStatusText(page, '开机卡在线', 8000);
      await page.waitForTimeout(300);
      const layout = await measureLayout(page);
      assertFirstScreen(layout, { width: 1280, height: 800 });
      assert(Math.abs(layout.app.width - 560) <= 1, `.app 在桌面应固定 560px，实际 ${layout.app.width}`);
      await screenshot(page, 'desktop-home.png');
      assertNoDiagnostics('桌面 1280×800');
    });

    /* ---------------- 3. 关机：确认弹窗 + 2–3s 状态切换 ---------------- */
    await runCase('关机：确认弹窗（焦点在取消）→ 2–3s 内变为“电脑已关机”', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 20000 });
      await waitHeroTitle(page, '电脑已开机', 12000);
      await waitStatusText(page, '开机卡在线', 8000);

      await page.locator('#powerOffBtn').click();
      await page.waitForFunction(() => document.getElementById('confirmDialog').open, null, { timeout: 3000 });
      const dialogState = await page.evaluate(() => ({
        title: document.getElementById('confirmTitle').textContent.trim(),
        desc: document.getElementById('confirmDesc').textContent.trim(),
        ariaModal: document.getElementById('confirmDialog').getAttribute('aria-modal'),
        labelledBy: document.getElementById('confirmDialog').getAttribute('aria-labelledby'),
        activeId: document.activeElement && document.activeElement.id,
        inDialog: Boolean(document.getElementById('confirmDialog').contains(document.activeElement)),
      }));
      assertEqual(dialogState.title, '确认关机？', '确认弹窗标题');
      assert(dialogState.desc.includes('电脑会立即关机'), '确认弹窗说明文案');
      assertEqual(dialogState.ariaModal, 'true', '确认弹窗 aria-modal');
      assertEqual(dialogState.labelledBy, 'confirmTitle', '确认弹窗 aria-labelledby');
      assert(dialogState.inDialog, '弹窗打开后焦点应进入弹窗');
      assertEqual(dialogState.activeId, 'confirmCancel', '初始焦点应落在“取消”按钮');
      await screenshot(page, 'confirm-off.png');

      const clickAt = Date.now();
      await page.locator('#confirmOk').click();
      await waitToast(page, '关机指令已发送', 5000);
      await waitHeroTitle(page, '电脑已关机', 5000);
      const elapsedMs = Date.now() - clickAt;
      // 契约：演示指令约 600ms + 成功后 1.5s 刷新状态 → 约 2.1s
      assert(elapsedMs >= 1600 && elapsedMs <= 3800, `状态切换耗时 ${elapsedMs}ms，期望约 2–3s`);
      await waitStatusText(page, '开机卡在线', 3000);
      const toast = await toastSnapshot(page);
      assertEqual(toast.count, 1, '页面应只有一个 toast 节点（不重复）');
      assertEqual(toast.visible, true, '关机成功 toast 应可见');
      assert(page.url() === `${baseUrl}/`, '不应发生页面跳转');
      await screenshot(page, 'mobile-off.png');
      assertNoDiagnostics('关机流程');
      metrics.offStateSwitchMs = elapsedMs;
    });

    /* ---------------- 4. 开机恢复（同样二次确认） ---------------- */
    await runCase('开机：确认后恢复“电脑已开机”', async () => {
      await page.locator('#powerOnBtn').click();
      await page.waitForFunction(() => document.getElementById('confirmDialog').open, null, { timeout: 3000 });
      const state = await page.evaluate(() => ({
        title: document.getElementById('confirmTitle').textContent.trim(),
        desc: document.getElementById('confirmDesc').textContent.trim(),
        tone: document.getElementById('confirmIcon').dataset.tone,
        okClass: document.getElementById('confirmOk').className,
      }));
      assertEqual(state.title, '确认开机？', '开机确认弹窗标题');
      assert(state.desc.includes('电脑会开始启动'), '开机确认弹窗说明文案');
      assertEqual(state.tone, 'success', '开机确认图标应采用绿色成功态');
      assert(state.okClass.includes('btn-primary'), '开机确认按钮应为主色按钮');
      await page.locator('#confirmOk').click();
      await waitToast(page, '开机指令已发送', 5000);
      await waitHeroTitle(page, '电脑已开机', 5000);
      await waitStatusText(page, '开机卡在线', 3000);
      const confirmOpen = await page.evaluate(() => document.getElementById('confirmDialog').open);
      assertEqual(confirmOpen, false, '确认后弹窗应关闭');
      assertEqual((await toastSnapshot(page)).count, 1, 'toast 节点不应重复');
      await screenshot(page, 'mobile-on.png');
      assertNoDiagnostics('开机流程');
    });

    /* ---------------- 5. 刷新按钮：可用 / aria-busy / 无重复 toast ---------------- */
    await runCase('刷新按钮：立即进入 aria-busy/旋转，完成后恢复且不弹重复 toast', async () => {
      await waitHeroTitle(page, '电脑已开机', 8000);
      // 上一条“开机成功”toast 按设计会显示 3 秒；先等它自动消失，避免误判刷新弹了新 toast。
      await page.waitForFunction(
        () => !document.getElementById('toast').classList.contains('is-visible'),
        null,
        { timeout: 4000 },
      );
      const logsBefore = (await getJson(baseUrl, '/api/logs')).json.logs.length;
      const immediate = await page.evaluate(() => {
        const button = document.getElementById('refreshBtn');
        button.click();
        return {
          busy: button.getAttribute('aria-busy'),
          spinning: button.classList.contains('is-spinning'),
          disabled: button.disabled,
          toastCount: document.querySelectorAll('.toast').length,
        };
      });
      assertEqual(immediate.busy, 'true', '刷新请求进行中 aria-busy 应为 true');
      assertEqual(immediate.spinning, true, '刷新请求进行中应有旋转状态');
      assertEqual(immediate.disabled, true, '刷新请求进行中应禁用按钮（防重复提交）');
      assertEqual(immediate.toastCount, 1, 'toast 节点应唯一');

      await page.waitForFunction(
        () => {
          const button = document.getElementById('refreshBtn');
          return (
            button.getAttribute('aria-busy') === 'false' &&
            !button.classList.contains('is-spinning') &&
            !button.disabled
          );
        },
        null,
        { timeout: 4000 },
      );
      await waitFor(async () => (await getJson(baseUrl, '/api/logs')).json.logs.length > logsBefore, {
        timeout: 3000,
        label: '刷新应产生一次真实状态请求日志',
      });
      const after = await toastSnapshot(page);
      assertEqual(after.visible, false, '刷新成功不应弹出 toast');
      assertEqual(after.count, 1, 'toast 节点应唯一');

      // 真实指针点击也应可用，且不产生重复 toast
      await page.locator('#refreshBtn').click();
      await page.waitForFunction(
        () => document.getElementById('refreshBtn').getAttribute('aria-busy') === 'false',
        null,
        { timeout: 4000 },
      );
      await waitHeroTitle(page, '电脑已开机', 5000);
      const finalToast = await toastSnapshot(page);
      assertEqual(finalToast.count, 1, '真实点击后 toast 节点应唯一');
      assertEqual(finalToast.visible, false, '刷新成功不应弹出 toast');
      assertNoDiagnostics('刷新按钮');
    });

    /* ---------------- 6. 设置抽屉：14 个字段/选择器 ---------------- */
    await runCase('设置抽屉：14 个字段/选择器齐全，打开后焦点进入、可滚动', async () => {
      await page.locator('#settingsBtn').click();
      await page.waitForFunction(() => document.getElementById('settingsDialog').open, null, { timeout: 3000 });
      await page.waitForTimeout(350);
      const drawer = await page.evaluate(() => {
        const dialog = document.getElementById('settingsDialog');
        return {
          open: dialog.open,
          ariaModal: dialog.getAttribute('aria-modal'),
          labelledBy: dialog.getAttribute('aria-labelledby'),
          expanded: document.getElementById('settingsBtn').getAttribute('aria-expanded'),
          focusInDialog: dialog.contains(document.activeElement),
          role: dialog.getAttribute('role'),
        };
      });
      assertEqual(drawer.open, true, '设置抽屉应打开');
      assertEqual(drawer.ariaModal, 'true', '设置抽屉 aria-modal');
      assertEqual(drawer.labelledBy, 'settingsTitle', '设置抽屉 aria-labelledby');
      assertEqual(drawer.expanded, 'true', '调试按钮 aria-expanded 应为 true');
      assert(drawer.focusInDialog, '打开设置后焦点应进入抽屉');

      const fields = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#settingsForm input, #settingsForm select')).map((el) => ({
          id: el.id,
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
        })),
      );
      assertEqual(fields.length, 14, '设置表单控件数量');
      const fieldIds = fields.map((field) => field.id).sort();
      assertEqual(JSON.stringify(fieldIds), JSON.stringify([...EXPECTED_SETTINGS_FIELDS].sort()), '设置字段 id 集合');
      assertEqual(fields.filter((field) => field.tag === 'select').length, 2, '选择器数量');
      assertEqual(fields.filter((field) => field.type === 'checkbox').length, 1, '开关数量');

      const labels = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#settingsForm label[for]')).map((label) => ({
          target: label.htmlFor,
          text: label.textContent.replace(/\s+/g, ' ').replace(/GET/g, '').trim(),
        })),
      );
      assertEqual(labels.length, 13, 'label 数量（11 输入 + 2 选择器）');
      for (const [id, expected] of Object.entries(EXPECTED_LABELS)) {
        const found = labels.find((label) => label.target === id);
        assert(found, `缺少字段 ${id} 的 label`);
        assertEqual(found.text, expected, `字段 ${id} 的 label 文案`);
      }
      const getBadges = await page.evaluate(
        () => document.querySelectorAll('#settingsForm .get-badge').length,
      );
      assertEqual(getBadges, 4, '四个接口 URL 应各有 GET 徽标');
      const switchInfo = await page.evaluate(() => ({
        role: document.getElementById('confirmActions').getAttribute('role'),
        labelledBy: document.getElementById('confirmActions').getAttribute('aria-labelledby'),
        labelText: document.getElementById('confirmActionsLabel').textContent.trim(),
        checked: document.getElementById('confirmActions').checked,
      }));
      assertEqual(switchInfo.role, 'switch', '二次确认控件 role');
      assertEqual(switchInfo.labelledBy, 'confirmActionsLabel', '二次确认控件 aria-labelledby');
      assertEqual(switchInfo.labelText, '操作二次确认', '二次确认标签文案');
      assertEqual(switchInfo.checked, true, '演示模式默认开启二次确认');

      await screenshot(page, 'mobile-settings.png');
      assertNoDiagnostics('设置抽屉字段');
    });

    /* ---------------- 7. 非法 URL：字段级错误、不关闭 ---------------- */
    await runCase('非法 URL：字段级错误且抽屉不关闭，不发送 PUT', async () => {
      const putBefore = diagnostics.putRequests.length;
      await page.fill('#statusUrl', 'ftp://example.com/status');
      await page.locator('#settingsSave').click();
      await page.waitForFunction(
        () => {
          const error = document.getElementById('statusUrlError');
          return Boolean(error) && !error.hidden && error.textContent.trim().length > 0;
        },
        null,
        { timeout: 3000 },
      );
      const state = await page.evaluate(() => ({
        errorText: document.getElementById('statusUrlError').textContent.trim(),
        ariaInvalid: document.getElementById('statusUrl').getAttribute('aria-invalid'),
        dialogOpen: document.getElementById('settingsDialog').open,
      }));
      assert(state.errorText.includes('http'), `字段错误文案应提示 http/https，实际：“${state.errorText}”`);
      assertEqual(state.ariaInvalid, 'true', '非法字段应标记 aria-invalid');
      assertEqual(state.dialogOpen, true, '校验失败时设置抽屉不应关闭');
      assertEqual(diagnostics.putRequests.length, putBefore, '客户端校验失败不应发送 PUT /api/config');
      await waitToast(page, '请检查标红的设置项', 3000);
      assertEqual((await toastSnapshot(page)).count, 1, 'toast 节点应唯一');
      assertNoDiagnostics('非法 URL 校验');
    });

    /* ---------------- 8. Esc 关闭设置、焦点归还调试按钮 ---------------- */
    await runCase('Esc 关闭设置抽屉，焦点回到调试按钮', async () => {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('settingsDialog').open, null, { timeout: 4000 });
      await page.waitForFunction(
        () => document.activeElement === document.getElementById('settingsBtn'),
        null,
        { timeout: 4000 },
      );
      const state = await page.evaluate(() => ({
        expanded: document.getElementById('settingsBtn').getAttribute('aria-expanded'),
        activeId: document.activeElement.id,
      }));
      assertEqual(state.expanded, 'false', '关闭后 aria-expanded 应为 false');
      assertEqual(state.activeId, 'settingsBtn', '关闭后焦点应回到调试按钮');
      assertNoDiagnostics('Esc 关闭设置');
    });

    /* ---------------- 9. 连接测试 /api/test（复用 integration mock） ---------------- */
    await runCase('连接测试：填 mock 状态 URL 后显示接口可用/在线/已开机，且不保存', async () => {
      await page.locator('#settingsBtn').click();
      await page.waitForFunction(() => document.getElementById('settingsDialog').open, null, { timeout: 3000 });
      await page.waitForTimeout(300);
      await page.fill('#statusUrl', `${integrationMock.baseUrl}/status/json`);
      await page.locator('#testBtn').click();
      await page.waitForFunction(
        () => {
          const result = document.getElementById('testResult');
          return (
            Boolean(result) &&
            !result.hidden &&
            result.dataset.tone === 'ok' &&
            result.textContent.includes('接口可用')
          );
        },
        null,
        { timeout: 10000 },
      );
      const result = await page.evaluate(() => ({
        text: document.getElementById('testResult').innerText,
        tone: document.getElementById('testResult').dataset.tone,
      }));
      assert(result.text.includes('接口可用'), `测试结果应显示接口可用，实际：${result.text}`);
      assert(result.text.includes('在线') && result.text.includes('已开机'), `测试结果应显示在线/已开机，实际：${result.text}`);
      assert(/HTTP\s*200/.test(result.text), `测试结果应显示 HTTP 200，实际：${JSON.stringify(result.text)}`);
      assert(integrationMock.hits('/status/json') >= 1, 'mock 设备应收到状态测试请求');

      const config = (await getJson(baseUrl, '/api/config')).json;
      assertEqual(config.mode, 'demo', '连接测试不应保存配置（仍为 demo）');
      assertEqual(config.config.statusUrl, '', '连接测试不应写入 statusUrl');
      assertNoDiagnostics('连接测试');
    });

    /* ---------------- 10. 保存切换到真实设备（live） ---------------- */
    await runCase('保存四项 mock URL → 模式变 live，状态来自 mock 设备', async () => {
      const mockUrls = {
        statusUrl: `${statefulMock.baseUrl}/status/json`,
        powerOnUrl: `${statefulMock.baseUrl}/power/on`,
        powerOffUrl: `${statefulMock.baseUrl}/power/off`,
        rebootUrl: `${statefulMock.baseUrl}/reboot`,
      };
      await page.fill('#statusUrl', mockUrls.statusUrl);
      await page.fill('#powerOnUrl', mockUrls.powerOnUrl);
      await page.fill('#powerOffUrl', mockUrls.powerOffUrl);
      await page.fill('#rebootUrl', mockUrls.rebootUrl);
      await page.fill('#lanAddress', '192.168.1.50');
      await page.fill('#wanAddress', 'https://example.com:8443');
      await page.fill('#subnetMask', '255.255.255.0');
      await page.fill('#gateway', '192.168.1.1');
      await page.fill('#macAddress', 'aa-bb-cc-dd-ee-ff');
      await page.selectOption('#pollIntervalSec', '10');
      await page.selectOption('#requestTimeoutSec', '5');
      await page.locator('#settingsSave').click();

      await page.waitForFunction(() => !document.getElementById('settingsDialog').open, null, { timeout: 8000 });
      await waitToast(page, '设置已保存并应用', 5000);
      await waitHeroTitle(page, '电脑已开机', 10000);
      await waitStatusText(page, '开机卡在线', 5000);
      await page.waitForFunction(
        () => /局域网直连 · 每 10 秒刷新/.test(document.getElementById('subtitle').textContent),
        null,
        { timeout: 5000 },
      );

      const ui = await page.evaluate(() => ({
        demoBadgeHidden: document.getElementById('demoBadge').hidden,
        subtitle: document.getElementById('subtitle').textContent.trim(),
        heroMeta: document.getElementById('heroMeta').textContent.trim(),
      }));
      assertEqual(ui.demoBadgeHidden, true, 'live 模式不应显示演示徽标');
      assertEqual(ui.subtitle, '局域网直连 · 每 10 秒刷新', 'live 模式副标题');

      const config = (await getJson(baseUrl, '/api/config')).json;
      assertEqual(config.mode, 'live', '保存后模式应为 live');
      for (const [key, value] of Object.entries(mockUrls)) {
        assertEqual(config.config[key], value, `配置 ${key} 持久化值`);
      }
      assertEqual(config.config.macAddress, 'AA:BB:CC:DD:EE:FF', 'MAC 应归一化为大写冒号格式');
      assertEqual(config.config.pollIntervalSec, 10, 'pollIntervalSec');
      assertEqual(config.config.requestTimeoutMs, 5000, 'requestTimeoutMs');
      assertEqual(config.config.confirmActions, true, 'confirmActions');

      const onDisk = JSON.parse(await fsp.readFile(configPath, 'utf8'));
      assertEqual(onDisk.statusUrl, mockUrls.statusUrl, '临时 CONFIG_PATH 文件应写入 statusUrl');
      assertEqual(onDisk.powerOffUrl, mockUrls.powerOffUrl, '临时 CONFIG_PATH 文件应写入 powerOffUrl');
      assert(statefulMock.hits('/status/json') >= 1, 'live 状态应来自 mock 设备');
      await screenshot(page, 'live-mode.png');
      assertNoDiagnostics('保存切换 live');
    });

    /* ---------------- 11. live 关机：mock 收到 /power/off，刷新显示 off ---------------- */
    await runCase('live 关机：mock 收到 GET /power/off，刷新后状态为“电脑已关机”', async () => {
      const offHitsBefore = statefulMock.hits('/power/off');
      await page.locator('#powerOffBtn').click();
      await page.waitForFunction(() => document.getElementById('confirmDialog').open, null, { timeout: 3000 });
      assertEqual(
        await page.evaluate(() => document.getElementById('confirmTitle').textContent.trim()),
        '确认关机？',
        'live 模式同样需要二次确认',
      );
      await page.locator('#confirmOk').click();
      await waitToast(page, '关机指令已发送', 6000);
      await waitFor(() => statefulMock.hits('/power/off') === offHitsBefore + 1, {
        timeout: 4000,
        label: 'mock 收到一次 /power/off',
      });
      assertEqual(statefulMock.state.powerOn, false, 'mock 设备电源状态应变为 off');
      await waitHeroTitle(page, '电脑已关机', 8000);
      await waitStatusText(page, '开机卡在线', 4000);

      const statusHitsBefore = statefulMock.hits('/status/json');
      await page.locator('#refreshBtn').click();
      await waitFor(() => statefulMock.hits('/status/json') > statusHitsBefore, {
        timeout: 5000,
        label: '手动刷新应带 refresh=1 命中 mock 状态接口',
      });
      await page.waitForTimeout(150);
      assertEqual(
        await page.evaluate(() => document.getElementById('heroTitle').textContent.trim()),
        '电脑已关机',
        '刷新后应仍显示电脑已关机（来自 mock 的 off 状态）',
      );
      assertNoDiagnostics('live 关机');
    });

    /* ---------------- 12. live 日志面板 ---------------- */
    await runCase('日志面板：能看到 status / command 记录与当前模式', async () => {
      await page.locator('#settingsBtn').click();
      await page.waitForFunction(() => document.getElementById('settingsDialog').open, null, { timeout: 3000 });
      await page.waitForTimeout(300);
      const debug = await page.evaluate(() => ({
        mode: document.getElementById('debugMode').textContent.trim(),
        source: document.getElementById('debugSource').textContent.trim(),
        rawBody: document.getElementById('rawBody').textContent.trim(),
        rawMeta: document.getElementById('rawMeta').textContent.trim(),
      }));
      assertEqual(debug.mode, '真实设备', '调试信息当前模式应为“真实设备”');
      assert(debug.source.includes(statefulMock.baseUrl), `调试信息状态接口应显示 mock 地址，实际：${debug.source}`);
      assert(debug.rawBody.includes('"power"'), `原始响应应展示 mock JSON，实际：${debug.rawBody.slice(0, 120)}`);
      assert(debug.rawMeta.includes('HTTP 200'), `原始响应元信息应含 HTTP 200，实际：${debug.rawMeta}`);

      await page.locator('#loadLogsBtn').click();
      await page.waitForFunction(
        () => document.querySelectorAll('#logsBox .log-item').length >= 2,
        null,
        { timeout: 6000 },
      );
      const logs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#logsBox .log-item')).map((item) => ({
          kind: item.querySelector('.log-kind')?.textContent.trim() || '',
          url: item.querySelector('.log-url')?.textContent.trim() || '',
          http: item.querySelector('.log-http')?.textContent.trim() || '',
        })),
      );
      const kinds = new Set(logs.map((log) => log.kind));
      assert(kinds.has('状态'), `日志应包含“状态”记录，实际：${[...kinds].join('/')}`);
      assert(kinds.has('指令'), `日志应包含“指令”记录，实际：${[...kinds].join('/')}`);
      assert(
        logs.some((log) => log.url.includes('/status/json') && log.url.startsWith('GET ')),
        `日志应包含 GET /status/json，实际：${logs.map((log) => log.url).join(' | ')}`,
      );
      assert(
        logs.some((log) => log.url.includes('/power/off') && log.url.startsWith('GET ')),
        '日志应包含 GET /power/off',
      );
      assert(logs.some((log) => log.http === 'HTTP 200'), '日志应包含 HTTP 200 记录');
      await screenshot(page, 'live-settings-logs.png');
      assertNoDiagnostics('日志面板');

      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('settingsDialog').open, null, { timeout: 4000 });
      await page.waitForFunction(
        () => document.activeElement === document.getElementById('settingsBtn'),
        null,
        { timeout: 4000 },
      );
    });

    /* ---------------- 13. 刷新页面后持久化 ---------------- */
    await runCase('刷新页面后临时 CONFIG_PATH 配置仍在，且仍是 live', async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      await waitHeroTitle(page, '电脑已关机', 12000);
      await waitStatusText(page, '开机卡在线', 8000);
      const ui = await page.evaluate(() => ({
        subtitle: document.getElementById('subtitle').textContent.trim(),
        demoBadgeHidden: document.getElementById('demoBadge').hidden,
        heroState: document.getElementById('hero').dataset.state,
      }));
      assert(ui.subtitle.startsWith('局域网直连 · 每 10 秒刷新'), `刷新后仍应为 live，副标题：${ui.subtitle}`);
      assertEqual(ui.demoBadgeHidden, true, '刷新后不应回到演示模式');
      assertEqual(ui.heroState, 'off', 'mock 关机状态应在刷新后保持');

      const config = (await getJson(baseUrl, '/api/config')).json;
      assertEqual(config.mode, 'live', '刷新页面后服务端模式仍应为 live');
      const onDisk = JSON.parse(await fsp.readFile(configPath, 'utf8'));
      assertEqual(onDisk.statusUrl, `${statefulMock.baseUrl}/status/json`, '配置文件应持久化');
      assertEqual(onDisk.macAddress, 'AA:BB:CC:DD:EE:FF', '配置文件 MAC 持久化');
      assertNoDiagnostics('刷新页面持久化');
    });

    /* ---------------- 14. 静态资源 / PWA ---------------- */
    await runCase('静态 / PWA：manifest、sw.js、图标 200，页面 link[rel=manifest] 存在', async () => {
      const assets = [
        { pathname: '/manifest.webmanifest', type: 'application/manifest+json' },
        { pathname: '/sw.js', type: 'text/javascript' },
        { pathname: '/favicon.svg', type: 'image/svg+xml' },
        { pathname: '/icons/icon-192.png', type: 'image/png' },
        { pathname: '/icons/icon-512.png', type: 'image/png' },
        { pathname: '/icons/maskable-512.png', type: 'image/png' },
        { pathname: '/icons/apple-touch-icon.png', type: 'image/png' },
      ];
      for (const asset of assets) {
        const response = await fetch(`${baseUrl}${asset.pathname}`);
        assertEqual(response.status, 200, `${asset.pathname} HTTP 状态`);
        const contentType = response.headers.get('content-type') || '';
        assert(contentType.includes(asset.type), `${asset.pathname} Content-Type=${contentType}，期望含 ${asset.type}`);
        await response.arrayBuffer();
      }
      const manifest = await (await fetch(`${baseUrl}/manifest.webmanifest`)).json();
      assertEqual(manifest.name, '远程电脑控制', 'manifest name');
      assertEqual(manifest.start_url, '/', 'manifest start_url');
      assertEqual(manifest.display, 'standalone', 'manifest display');
      assertEqual(manifest.icons.length, 3, 'manifest 图标数量');
      assert(manifest.icons.some((icon) => icon.purpose === 'maskable'), 'manifest 应有 maskable 图标');

      const pageInfo = await page.evaluate(() => {
        const link = document.querySelector('link[rel="manifest"]');
        return {
          href: link ? link.getAttribute('href') : null,
          themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
          viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content'),
          lang: document.documentElement.lang,
        };
      });
      assert(/manifest\.webmanifest$/.test(pageInfo.href || ''), '页面 link[rel=manifest] 应指向 manifest');
      assertEqual(pageInfo.themeColor, '#f6f4ef', 'theme-color 应与暖白底色一致');
      assert(pageInfo.viewport.includes('width=device-width'), 'viewport meta 应含 width=device-width');
      assertEqual(pageInfo.lang, 'zh-CN', 'html lang');
      assertNoDiagnostics('静态 / PWA');
    });

    /* ---------------- 15. Service Worker 注册（独立 context） ---------------- */
    await runCase('Service Worker 成功注册并接管（独立 context）', async () => {
      const swContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        locale: 'zh-CN',
      });
      try {
        const swPage = await swContext.newPage();
        attachDiagnostics(swPage, 'sw');
        await swPage.goto(baseUrl, { waitUntil: 'networkidle', timeout: 20000 });
        await swPage.waitForFunction(
          async () => {
            const registration = await navigator.serviceWorker.getRegistration();
            return Boolean(registration && registration.active);
          },
          null,
          { timeout: 15000 },
        );
        const scope = await swPage.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return {
            scope: registration?.scope || '',
            scriptUrl: registration?.active?.scriptURL || '',
          };
        });
        assert(scope.scriptUrl.endsWith('/sw.js'), `SW scriptURL 应为 /sw.js，实际 ${scope.scriptUrl}`);
        assert(scope.scope === `${baseUrl}/`, `SW scope 应为 ${baseUrl}/，实际 ${scope.scope}`);
        assertNoDiagnostics('Service Worker');
      } finally {
        await swContext.close();
      }
    });

    /* ---------------- 16. 汇总诊断 ---------------- */
    await runCase('全流程无 console error / pageerror / 失败请求', async () => {
      assertEqual(diagnostics.consoleErrors.length, 0, `console errors：${diagnostics.consoleErrors.join(' | ')}`);
      assertEqual(diagnostics.pageErrors.length, 0, `pageerrors：${diagnostics.pageErrors.join(' | ')}`);
      assertEqual(diagnostics.badResponses.length, 0, `HTTP >= 400：${diagnostics.badResponses.join(' | ')}`);
      assertEqual(diagnostics.requestFailures.length, 0, `失败请求：${diagnostics.requestFailures.join(' | ')}`);
    });

    const failed = cases.filter((item) => item.status === 'fail').length;
    const passed = cases.length - failed;

    const results = {
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        playwrightCore: await readPlaywrightVersion(),
        browser: browserVersion,
        browserExecutable: path.relative(ROOT, BROWSER_EXE),
        appBaseUrl: baseUrl,
        configPath,
        note: '临时 CONFIG_PATH + 随机端口 + 本地 mock 设备；未使用 8787，未写入真实 data/config.json。',
      },
      summary: { total: cases.length, passed, failed },
      metrics,
      cases,
      screenshots,
      diagnostics,
    };
    await fsp.writeFile(path.join(ART_DIR, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');

    console.log('');
    console.log('='.repeat(72));
    console.log(`用例：${cases.length}  通过：${passed}  失败：${failed}`);
    console.log(`截图：${screenshots.map((name) => `qa/artifacts/${name}`).join(', ')}`);
    console.log(`结果：${path.relative(ROOT, path.join(ART_DIR, 'results.json'))}`);
    if (failed > 0) {
      console.error('');
      console.error('失败用例：');
      for (const item of cases.filter((entry) => entry.status === 'fail')) {
        console.error(`- ${item.name}`);
        console.error(String(item.error || '').split('\n').slice(0, 8).map((line) => `  ${line}`).join('\n'));
      }
    }
    console.log('='.repeat(72));
    if (failed > 0) process.exitCode = 1;
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await statefulMock.close();
    await integrationMock.close();
    await closeServer(appServer);
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readPlaywrightVersion() {
  try {
    const pkg = JSON.parse(
      await fsp.readFile(path.join(ROOT, 'node_modules', 'playwright-core', 'package.json'), 'utf8'),
    );
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

main().catch((error) => {
  console.error('E2E 运行失败：');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
