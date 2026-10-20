# Android 原生桥契约（APK v1）

本契约约束 **Java 原生壳** 与 **Web 前端 `public/native-bridge.js`** 之间的接口。两侧可并行开发，字段改动必须先改本文件。

## 1. 运行形态

- APK 内使用 WebView + `WebViewAssetLoader` 加载本地 UI：
  `https://appassets.androidplatform.net/assets/public/index.html`
- 页面内 `window.PowerCardNative` 由 `addJavascriptInterface` 注入，页面脚本执行前已存在。
- 所有设备 URL 的 HTTP 请求由 **Java 原生 `HttpURLConnection`** 发出（手机网络，无 CORS）。
- 原生模式不启动 Service Worker；`window.__POWERCARD_NATIVE__ === true`。
- 配置由原生加密存储（Android Keystore + AES/GCM），JS 只通过桥读写明文 JSON。
- 不需要电脑、Node 服务或任何外部服务器。

## 2. 原生注入对象

```ts
interface PowerCardNative {
  /** 返回配置 JSON 字符串；从未保存过返回 "{}"。同步方法。 */
  getConfigJson(): string;

  /** 保存配置 JSON 字符串；成功返回 true。同步方法。 */
  saveConfigJson(json: string): boolean;

  /**
   * 异步 GET。立即返回；完成后调用
   * window.__powercardHttpResult(requestId, result)。
   * timeoutMs 会被原生限制在 1000–30000。
   */
  httpGet(requestId: string, url: string, timeoutMs: number): void;

  /** 复制文本到剪贴板（可选能力）。 */
  copyText(text: string): void;

  /** 请求把桌面小组件添加到桌面；启动器支持并已发起返回 true。 */
  requestPinWidget(): boolean;

  /** 请求刷新所有已添加的桌面小组件（配置保存/指令后调用）。 */
  refreshWidgets(): void;

  /** 返回 "1.1.0" 形式的版本号。 */
  getAppVersion(): string;
}
```

`requestId` 由 JS 生成，必须原样回传，用于匹配 Promise。

## 3. 原生 HTTP 回调

```js
window.__powercardHttpResult = (requestId, result) => { /* JS 处理 */ };
```

`result` 对象：

```json
{
  "ok": true,
  "status": 200,
  "contentType": "application/json; charset=utf-8",
  "body": "{\"online\":true,\"power\":\"on\"}",
  "truncated": false,
  "latencyMs": 174,
  "error": null
}
```

- `ok`：HTTP 2xx 且网络层成功。
- `status`：HTTP 状态码；网络/超时错误时为 `null`。
- `body`：UTF-8 文本，最多 8192 字符；超出时 `truncated=true`。
- `latencyMs`：原生实际耗时，整数。
- `error`：失败时 `{ "code": "...", "message": "..." }`，否则 `null`。
  - `INVALID_URL`：不是 http/https 或 URL 非法
  - `TIMEOUT`：连接/读取超时
  - `NETWORK`：DNS/TLS/连接失败等
  - `HTTP`：设备返回非 2xx（此时仍带 `status` 和 `body`）
- 原生不得抛异常给 JS；所有失败都通过 `result.error` 表达。
- 回调必须在主线程通过 `evaluateJavascript` 调用，参数为 JSON 字面量；JS 侧按对象接收。

## 4. 配置 JSON（与 Web 服务端契约一致）

```json
{
  "statusUrl": "",
  "powerOnUrl": "",
  "powerOffUrl": "",
  "rebootUrl": "",
  "lanAddress": "",
  "wanAddress": "",
  "subnetMask": "",
  "gateway": "",
  "macAddress": "",
  "pollIntervalSec": 10,
  "requestTimeoutMs": 5000,
  "confirmActions": true,
  "powerField": "",
  "onlineField": ""
}
```

- 单套 URL；不做内网/公网双配置。
- 地址资料仅展示。
- 原生侧只负责加密存取，不解释字段语义（默认值/校验由 JS 负责）。

## 5. JS 侧 API 兼容层

`public/native-bridge.js` 负责让现有 `public/app.js` 无感知运行：

- 覆盖 `window.fetch`，拦截同源 `/api/*`：
  - `GET /api/health`
  - `GET /api/config`
  - `PUT /api/config`
  - `GET /api/status`（支持 `?refresh=1`）
  - `POST /api/command`（`on` / `off` / `reboot`）
  - `POST /api/test`
  - `GET /api/logs`
- 返回值必须是标准 `Response`，响应体结构与 `docs/api-contract.md` 完全一致。
- 状态解析复用 `public/shared/parser.js`（与 Node 服务同一份源码）。
- 演示模式、1.5s 短缓存、日志环形缓冲、错误码、中文文案全部与 Web 服务端一致。
- 原生模式跳过 Service Worker 注册。
- 非原生环境（普通浏览器）下 `native-bridge.js` 不覆盖 fetch，不影响现有 Web/PWA。

## 6. 原生壳要求

- 包名：`com.powercard.remote`；应用名：`远程电脑控制`；版本 `1.1.0`，versionCode 2。
- minSdk 26，targetSdk/compileSdk 35。
- 权限：仅 `android.permission.INTERNET`（可加 `ACCESS_NETWORK_STATE`）。
- `android:usesCleartextTraffic="true"`（局域网 HTTP 必需）。
- `android:allowBackup="false"`（避免 token 进云备份）。
- 关闭 WebView 调试（release），禁止 file/content 访问，禁止外部导航；外部链接用系统浏览器打开。
- 状态栏/导航栏与页面同色系（`#f6f4ef`，深色图标），处理 Android 15 edge-to-edge 安全区。
- 返回键：优先让网页关闭设置抽屉/确认框（`window.__powercardBack()`），否则退出 App。
- 图标沿用 `public/icons/icon-512.png` 的绿色显示器风格。

### 6.1 桌面小组件（v1.1.0）

- 小组件用 `RemoteViews` + `AppWidgetProvider`，标准 4×2 / 紧凑 2×2 两套布局，不引入 Compose/Glance/WorkManager。
- 显示电脑开关机、开机卡在线/离线、最后更新时间；按钮：开机、关机、刷新。无重启按钮。
- 二次确认在小组件内完成：第一次点击进入“确认开机？/确认关机？”+ 取消/确认；第二次确认才发 GET；取消或 30 秒过期恢复。每个 appWidgetId 独立 pending。
- 状态由 `NativeHttpClient` + Java 版 `WidgetStateParser` 读取/解析（小组件无 WebView）；行为对齐 `public/shared/parser.js`，并用同一批用例测试。
- 无配置时显示“未配置 · 打开 App 设置”，不显示假数据；网络失败保留上次成功状态与时间。
- 刷新：onUpdate、手动刷新、App 保存配置/指令后触发；`updatePeriodMillis` 约 30 分钟。
- App 内设置页 `widgetSection` 仅原生模式显示，调用 `PowerCardNative.requestPinWidget()`；不支持的启动器给出长按桌面指引。
- Provider receiver 在 manifest 中 `exported=false`，meta-data 指向 `res/xml/widget_info.xml`；无新增危险权限。

## 7. 构建

- 工程目录：`android/`。
- Gradle 8.9 + AGP 8.7.3 + JDK 17 + Android SDK 35。
- 依赖：`androidx.webkit:webkit`（WebViewAssetLoader）、`androidx.core:core`（insets，可传递）。
- 构建前 Gradle 任务把仓库根 `public/` 复制到 `android/app/src/main/assets/public/`，`public/shared/parser.js` 随之一并进入 APK。
- 产出：`dist/PowerCard-v1.1.0.apk`，release 签名，附 SHA-256。

## 8. 端上兜底的已知边缘差异

APK 内的 `/api` 兼容层以 `docs/api-contract.md` 的业务路径为准，但以下错误路径属于端上兜底，不保证与服务端逐字节同构：

- `POST /api/health`、`POST /api/logs` 可能返回 404（服务端为 405）；前端不会这样调用。
- `PUT /api/config` 对非法 MAC、非布尔 `confirmActions` 的字段级报错不如服务端严格；前端 `app.js` 会在提交前做客户端校验，正常 UI 路径不会触发。
- 设备请求的 `sourceUrl`、`raw`、错误码与正常业务路径保持一致；`mode` 为 `demo`/`live`/`test`。

这些差异不影响正常使用，已记录为后续单测/对齐项。

## 9. 兼容性说明

- `minSdk 26` 只约束 Android 系统版本，不约束系统 WebView 版本。
- 页面使用 ES Modules、`??`、`Element.replaceChildren`、CSS `:where()`，建议 Android System WebView 100+；极旧且未更新的 WebView 可能白屏，需更新 WebView。
- 未在真机/模拟器运行验证（本机构建环境无虚拟化）；APK 的构建、签名与静态内容已验收，WebView 实际渲染需用户安装后确认。
