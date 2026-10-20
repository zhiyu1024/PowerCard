# QA 验收报告 · 远程电脑控制（浏览器端到端）

- 任务：`task-3` — QA：浏览器端到端验收、视觉截图与缺陷报告
- 验收人：qa-verifier（独立 QA，不参与前端/后端实现）
- 执行时间：2026-10-20 15:48–15:56（Asia/Shanghai）
- 被测路径：`public/index.html` + `public/app.js` + `server/server.js`（本仓库工作目录）
- 验收结论：**PASS** — 18/18 硬性用例通过，退出码 0；**未发现 P0/P1**；记录 1 个 P2 视觉观察项（不阻塞发布）。

> 本报告中的“通过”全部来自真实浏览器（Chromium）+ 真实 HTTP 服务 + mock 设备的硬性断言，截图仅作证据，不用“截图即通过”。与参考图“气质接近”属于人工核对项，已在第 7 节单独声明。

---

## 1. 测试环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | Microsoft Windows 11 专业版 10.0.26300 |
| Node.js | v24.21.0 |
| playwright-core | 1.64.1（`node_modules/playwright-core`） |
| 浏览器 | Chromium `chrome-headless-shell` 156.0.8078.4（`.pw-browsers/chrome-headless-shell/chrome-headless-shell-win64/chrome-headless-shell.exe`） |
| 被测应用启动方式 | `server/server.js` 的 `createServer({ configPath, publicDir })`，监听 `127.0.0.1:0`（随机端口） |
| 配置隔离 | `CONFIG_PATH` = `%TEMP%\powercard-e2e-<随机>\data\config.json`，每个测试进程独立、结束后删除 |
| 静态资源 | 真实 `public/` 目录（未复制、未改动） |
| mock 设备 | ① 复用 `tests/integration/support.js` 的 `startMockDevice()`（连接测试）；② 本测试内置的“有状态 mock”（live 控制：关机后 `/status/json` 返回 `power:0`，并记录请求） |
| 与 8787 的关系 | **未使用 8787、未向其发送任何 PUT /api/config**（详见第 5 节验证） |
| 真实设备 | 全程未使用任何真实设备 URL/token |

### 1.1 写入范围

本任务仅新增/写入：

- `tests/e2e/run.js`
- `qa/artifacts/**`（截图、`results.json`、`repeat-run.log`）
- `docs/qa-report.md`（本文件）

未修改 `public/**`、`server/**`、`package.json`、`README`、`docs/api-contract.md`、`docs/design-spec.md` 及 `data/`（`data/` 仍只有 `.gitkeep`）。

---

## 2. 执行命令与可重复性

```bash
node tests/e2e/run.js
```

- 单次运行约 20–21 秒（18 个用例，含 2.1s 左右的真实关机状态切换与 live 联调）。
- 连续多轮执行结果一致：**用例 18，通过 18，失败 0，退出码 0**。
- 首轮自查时发现 2 处“测试脚本自身”的误报（①上一条成功 toast 按设计显示 3 秒，未等其消失就判定刷新弹了新 toast；②连接测试结果的 `HTTP` 与 `200` 在内联元素中分行，`'HTTP 200'.includes` 匹配方式不适配），已改为“先等上一条 toast 消失再断言无新 toast”“用 `HTTP\s*200` 正则断言”，产品代码未做任何修改，修正后连续 3 轮全绿。
- 机器可读结果：`qa/artifacts/results.json`；另存一轮完整输出：`qa/artifacts/repeat-run.log`（末行 `EXIT_CODE=0`）。
- 关键时延实测：`metrics.offStateSwitchMs = 2152ms`（点击“确认关机”到首屏出现“电脑已关机”，符合契约“演示指令约 600ms + 成功后 1.5s 刷新 ≈ 2–3s”）。

---

## 3. 用例清单（18/18 PASS）

| # | 用例 | 结果 | 关键断言 / 证据 |
| --- | --- | --- | --- |
| 1 | 首屏 390×844（演示模式） | PASS | 标题“电脑已开机”、状态“开机卡在线”、演示徽标可见；无横向滚动；两大两小按钮完整位于 844px 首屏内；无 console error/pageerror；截图 `mobile-home.png` |
| 2 | 首屏 360×800（演示模式） | PASS | 同上；360px 下标题 28px、主/次按钮按两列等宽排布，无裁切/溢出；截图 `qa-360x800.png` |
| 3 | 首屏 765×403（矮屏概念稿尺寸） | PASS | 矮屏媒体查询生效：顶栏 56px、主按钮 78px、次按钮 48px；全部控件底边 ≤ 403px（首屏无裁切）；无横向滚动；截图 `qa-765x403.png` |
| 4 | 桌面 1280×800 | PASS | `.app` 固定 560px 且水平居中；单列；层级/配色同移动端；截图 `desktop-home.png` |
| 5 | 关机确认弹窗 + 2–3s 状态切换 | PASS | 点击“关机”弹 `dialog`，标题“确认关机？”、说明“电脑会立即关机”、`aria-modal=true`、初始焦点在“取消”；确认后 toast“关机指令已发送”，**2152ms** 后标题变“电脑已关机”且“开机卡在线”；toast 节点唯一；截图 `confirm-off.png`、`mobile-off.png` |
| 6 | 开机确认 + 恢复 | PASS | 点击“开机”弹 `dialog`，标题“确认开机？”、说明“电脑会开始启动”、图标绿色成功态、确认按钮为主色；确认后 toast“开机指令已发送”，随后恢复“电脑已开机”；toast 节点唯一；截图 `mobile-on.png`、`confirm-on.png` |
| 7 | 刷新按钮 | PASS | 点击瞬间 `aria-busy="true"`、`is-spinning` 旋转、按钮禁用防重复；完成后 `aria-busy="false"`、旋转停止、恢复可用；服务端 `/api/logs` 新增一条 status 记录（证明真实请求）；成功刷新不弹 toast，`.toast` 节点始终为 1 |
| 8 | 设置抽屉字段齐全 | PASS | `#settingsForm` 内 14 个控件 = 11 输入 + 2 select + 1 switch，id 集合与设计完全一致；13 个 `label[for]` 文案全对；4 个 `GET` 徽标；`role=switch`、`aria-labelledby` 正确；打开后焦点进入抽屉、`aria-expanded=true`；截图 `mobile-settings.png` |
| 9 | 非法 URL 字段级错误 | PASS | 填 `ftp://…` 保存：`#statusUrlError` 显示“URL 必须以 http:// 或 https:// 开头”、`aria-invalid=true`、抽屉**不关闭**、toast“请检查标红的设置项”；**未发出** PUT /api/config（客户端校验拦截） |
| 10 | Esc 关闭设置 + 焦点归还 | PASS | Esc 后 `dialog.open === false`、`aria-expanded=false`、`document.activeElement === #settingsBtn` |
| 11 | 连接测试 `/api/test` | PASS | 填入 mock 状态 URL 后点“测试状态接口”，结果区 `data-tone=ok`、显示“接口可用 / 在线 / 已开机 / 耗时 / HTTP 200”；mock 收到 `/status/json`；测试后 `/api/config` 仍为 demo 且 `statusUrl=""`（未保存） |
| 12 | 切换到真实设备（live） | PASS | 填入四项 mock URL + 设备资料后保存：抽屉关闭、toast“设置已保存并应用”、副标题“局域网直连 · 每 10 秒刷新”、演示徽标隐藏、首屏状态来自 mock；`/api/config` 返回 `mode:"live"` 且四项 URL 精确持久化，MAC 归一化为 `AA:BB:CC:DD:EE:FF`，`pollIntervalSec=10`、`requestTimeoutMs=5000`；临时 `CONFIG_PATH` 文件内容一致；截图 `live-mode.png` |
| 13 | live 关机 | PASS | 二次确认后 mock **收到 GET `/power/off`**（有状态 mock 电源转 off），随后“电脑已关机”；再点刷新（`refresh=1`）命中 mock `/status/json`，仍显示“电脑已关机” |
| 14 | 日志面板 | PASS | 调试信息“当前模式 = 真实设备”、状态接口为 mock 地址、原始响应展示 mock JSON（HTTP 200）；“加载最近请求”后列表含“状态/指令”两类、URL 含 `GET …/status/json` 与 `GET …/power/off`、HTTP 200；Esc 关闭后焦点回调试按钮；截图 `live-settings-logs.png` |
| 15 | 刷新页面后配置持久化 | PASS | `page.reload()` 后仍为 live（“局域网直连 · 每 10 秒刷新”、无演示徽标）、状态仍为“电脑已关机”；`/api/config` 与磁盘上的临时配置文件均保留四项 URL / MAC |
| 16 | 静态资源 / PWA | PASS | `/manifest.webmanifest`（`application/manifest+json`）、`/sw.js`（`text/javascript`）、`/favicon.svg`、`icon-192/512`、`maskable-512`、`apple-touch-icon` 全部 **200** 且 Content-Type 正确；manifest 名称/start_url/standalone/3 图标/maskable 正确；页面 `link[rel=manifest]` href=`/manifest.webmanifest`、`theme-color=#f6f4ef`、`lang=zh-CN` |
| 17 | Service Worker 注册与接管 | PASS | 独立 context 中 `navigator.serviceWorker.getRegistration()` 有 active worker，`scriptURL` 以 `/sw.js` 结尾、scope = 应用根路径 |
| 18 | 全流程诊断汇总 | PASS | console error = 0、pageerror = 0、HTTP ≥ 400 响应 = 0、requestfailed = 0；`PUT /api/config` 仅 1 次（用例 12 的预期保存请求），用例 9 的非法 URL 未发 PUT |

### 3.1 硬性断言覆盖的视觉规范（非只截图）

- 底色：`body` 计算样式 = `rgb(246, 244, 239)`（`#f6f4ef` 暖白）；主按钮卡片 = `rgb(255, 254, 250)`（`#fffefa`）。
- 单列：`.app` 宽度 ≤ 560px 且严格水平居中；`scrollWidth ≤ innerWidth`（三档手机 + 桌面均无横向滚动）。
- 层次：标题 30px/650 > 主按钮文字 17px/600 > 次按钮文字 14px；主按钮高 108px（矮屏 78px）> 次按钮 62px（矮屏 48px）；圆角 22/16（矮屏 18/14）。
- 语义色：开机图标绿 `#129c52`、关机图标红 `#cf4b3a`、主文字 `#171b18`、副标题 `#6e746d`、在线文字 `#0b6e3a` + 绿色圆点（状态同时有文字，不只靠颜色）。
- 首屏完整性：三档尺寸下主/次按钮、顶栏、调试按钮（44×44）的 `getBoundingClientRect()` 均在视口内；765×403 下全部控件底边 ≤ 403px。
- 焦点安全：所有截图前均 `blur` 当前焦点并把鼠标移开，避免调试按钮出现绿色 focus 环（截图里无绿环）。

---

## 4. 截图证据

目录：`qa/artifacts/`（移动端 deviceScaleFactor=2，桌面同为 2x）。

| 文件 | 内容 |
| --- | --- |
| [mobile-home.png](../qa/artifacts/mobile-home.png) | 390×844 演示模式首屏（暖白、单列、留白、标题/状态/大按钮/小按钮层次） |
| [mobile-off.png](../qa/artifacts/mobile-off.png) | 演示模式关机后 + “关机指令已发送” toast |
| [confirm-off.png](../qa/artifacts/confirm-off.png) | 关机二次确认弹窗（危险图标、取消/确认关机、遮罩 blur） |
| [confirm-on.png](../qa/artifacts/confirm-on.png) | 开机二次确认弹窗（绿色成功图标、取消/确认开机） |
| [mobile-settings.png](../qa/artifacts/mobile-settings.png) | 390×844 设置抽屉（接口地址 / 设备资料 / sticky 保存条） |
| [desktop-home.png](../qa/artifacts/desktop-home.png) | 1280×800 桌面（560px 单列居中） |
| [live-mode.png](../qa/artifacts/live-mode.png) | 保存后 live 模式首屏（副标题“局域网直连 · 每 10 秒刷新”、无演示徽标） |
| [qa-765x403.png](../qa/artifacts/qa-765x403.png) | 765×403 矮屏（对齐 `docs/reference-mockup.png` 概念稿尺寸） |
| [qa-360x800.png](../qa/artifacts/qa-360x800.png) | 360×800 窄屏（补充证据） |
| [mobile-on.png](../qa/artifacts/mobile-on.png) | 开机恢复（补充证据） |
| [live-settings-logs.png](../qa/artifacts/live-settings-logs.png) | live 模式调试信息 + 接口测试结果 + 最近请求日志（补充证据） |

与 `docs/reference-mockup.png` 人工比对：单列居中、大面积暖白留白、顶部品牌 + 右上调试按钮、中部“图标-标题-在线状态-模式说明”、下部“开机/关机（大）”与“重启/刷新（小）”的层次与参考稿一致；参考稿是无卡片线框概念稿，实现按 `docs/design-spec.md` 使用白底细边框卡片，属于规范要求，不视为偏差。

---

## 5. 控制台 / 网络 / 隔离验证

- **console error：0**；**pageerror：0**；**HTTP ≥ 400 响应：0**；**requestfailed：0**（18 个用例全程，含三次首屏重载、刷新、设置、live 联调、SW 注册）。
- 网络请求中唯一的写请求是 `PUT /api/config` 1 次（用例 12“保存并应用”，预期）。用例 9 的非法 URL 由客户端字段校验拦截，**未发送** PUT。
- **没有对 `http://127.0.0.1:8787` 发起任何写请求**：验收前/后只读检查 `GET /api/config` 均为 `mode:"demo"`、四项 URL 全空；`data/` 目录仍只有 `.gitkeep`，真实 `data/config.json` 未被创建/修改。
- 测试服务使用随机端口（`listen(0)`），mock 设备同样随机端口；进程结束后 temp 配置目录已清理（复查 `%TEMP%\powercard-e2e-*` 数量为 0），无残留 Chromium 进程。

---

## 6. 问题清单（按优先级）

### P0（阻断）：无

### P1（严重）：无

### P2（次要 / 不阻塞）：1 项

**P2-1 390px 宽度下设置抽屉“公网地址”placeholder 被输入框截断**

- 复现：390×844 → 点击右上“调试与设置” → “设备网络信息” → 观察“公网地址”输入框。
- 期望：placeholder 可完整显示（`https://example.com:8443`），或窄屏改为单列布局。
- 实际：两列网格下输入框宽约 160px，placeholder 显示为 `https://example.com:8`（视觉上像被截断；输入与保存功能不受影响，输入后内容可横向滚动）。
- 影响：纯视觉细节，不影响功能与可用性。属于 `docs/design-spec.md` 4.5 节“两列网格”在 390–520px 区间的固有结果，非功能缺陷。
- 建议（不要求本次修复）：缩短示例 placeholder，或在 `max-width: 420px` 时让网络信息改单列。
- 证据：[mobile-settings.png](../qa/artifacts/mobile-settings.png)。

> 除上述 1 项外，未发现其他可复现缺陷；未发现重复 toast、焦点丢失、抽屉/弹窗不关闭、状态不同步、PWA 资源 404 等问题。

---

## 7. 未执行 / 人工核对项（明确声明）

以下内容**未纳入自动断言**，以保证报告不“假装通过”：

1. **“与参考图接近”的整体主观判断**：自动化只断言了可量化的布局/字号/颜色/层级/首屏无裁切；气质是否接近参考稿由 QA 人工比对截图（第 4 节），结论为一致。
2. **真机验收未执行**：未在 iOS Safari / Android Chrome 真机、真实安全区（刘海/手势条）、真实触屏上执行；仅桌面 Chromium headless 模拟视口。
3. **真实开机卡设备 / 真实网络未执行**：按要求全部使用本地 mock，未验证真实设备的鉴权、超时与厂商字段差异（这些属于集成/单元测试与用户实机范畴）。
4. **PWA 安装到桌面/独立窗口未执行**：仅验证 manifest、图标、SW 注册与接管；未做 `beforeinstallprompt`/独立窗口启动的人工安装验证。
5. **文字对比度未做量化工具测量**：按设计令牌与目视核对，未跑 axe/contrast 计算器；`prefers-color-scheme: dark` 未实现（design-spec 标注为可选，不算缺陷）。
6. **主流程 context 主动屏蔽 Service Worker**（`serviceWorkers: 'block'`）：目的是让“点击刷新后立即断言 `aria-busy=true`”这一瞬时状态稳定可测（SW 的 network-only 策略不影响 API，但会干扰 Playwright 网络时序）；SW 的真实注册与接管由独立 context 的用例 17 单独验证，主流程未因此绕过任何产品逻辑。
7. **截图分辨率为 deviceScaleFactor=2**（移动 780×1688、矮屏 1530×806、桌面 2560×1600），非 1:1 像素。

---

## 8. 复现方式

```bash
# 在仓库根目录（本工作目录）
node tests/e2e/run.js
# 期望：18 个用例全部 PASS，末行汇总“通过：18 失败：0”，退出码 0
```

测试脚本自包含：临时 `CONFIG_PATH` + 随机端口被测服务 + 两个本地 mock 设备；不依赖 8787、不依赖外网、不需要真实设备。任何用例失败都会打印失败断言与堆栈，并让进程以退出码 1 结束。

产物：

- 测试脚本：[tests/e2e/run.js](../tests/e2e/run.js)
- 机器可读结果：[qa/artifacts/results.json](../qa/artifacts/results.json)（含环境、逐用例状态、截图列表、诊断计数、`offStateSwitchMs`）
- 重复运行日志：[qa/artifacts/repeat-run.log](../qa/artifacts/repeat-run.log)
- 截图：见第 4 节

---

## 9. 结论

`task-3` 验收通过：演示模式、关机/开机、确认弹窗与焦点、刷新态、设置抽屉 14 项与校验、连接测试、live 切换与真实指令联调、日志、配置持久化、PWA 静态资源与 SW 注册均按 `docs/api-contract.md` / `docs/design-spec.md` 工作，**0 个 P0、0 个 P1**，1 个不阻塞的 P2 视觉观察项已记录。测试可重复执行且退出码 0，建议 Lead 接受本任务并标记 `task-3` completed。

---

## 10. 验收后修复（Lead）

- **P2-1 已修复**：`public/index.html` 中“公网地址”的 placeholder 从 `https://example.com:8443` 缩短为 `https://example.com`。390×844 下复测输入框宽 167px，placeholder 完整显示；修复前截图 [`mobile-settings-before.png`](../qa/artifacts/mobile-settings-before.png)，修复后截图 [`mobile-settings-fixed.png`](../qa/artifacts/mobile-settings-fixed.png)（E2E 重新生成的 [`mobile-settings.png`](../qa/artifacts/mobile-settings.png) 同为修复后状态）。README 展示图已替换为修复后版本。
- 同时做了一处不涉及产品行为的发布整理：`public/manifest.webmanifest` 的 `orientation` 改为 `any`，Service Worker 缓存版本升到 `v2`，E2E runner 增加系统浏览器回退（`CHROMIUM_PATH` / `PW_CHANNEL`）。
- 上述改动后重新执行 `node tests/e2e/run.js`，仍为 **18/18 PASS**。

---

## 11. 需求追加：开机二次确认（2026-10-20 晚）

- 用户追加要求：开机也必须二次确认。
- 已修改 `public/app.js`、`public/styles.css`、`public/index.html`：
  - `confirmActions` 现在统一控制 **开机 / 关机 / 重启**；
  - 开机弹窗标题 `确认开机？`，说明 `指令将发送到开机卡，电脑会开始启动。`，绿色成功图标 + 主色按钮；
  - 设置页说明改为「开机、关机与重启前弹出确认框」。
- E2E 用例 6 已从「开机无需确认」改为「开机确认后恢复」，并新增标题/说明/图标 tone/按钮样式断言。
- 重新执行 `node tests/e2e/run.js`：**18/18 PASS**；重新执行原生模式模拟：**6/6 PASS**。
- 新增截图：`confirm-on.png`（开机确认），`mobile-on.png` 已为确认后的状态。

