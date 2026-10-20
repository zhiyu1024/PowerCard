# 独立代码审查记录（task-5）

复核对象：`android/app/src/main/java/com/powercard/remote/*.java`（5 个文件）+ `public/native-bridge.js` + `public/shared/native-api.js`。审查方式：逐行阅读源码 + 与 APK DEX/字符串交叉验证，不依赖构建者说明。

## 1. Java（APK 原生层）

| 检查项 | 位置 | 结论 |
| --- | --- | --- |
| 只对设备发 GET | `NativeHttpClient.java:125` `setRequestMethod("GET")`；全部 Java 源码 grep 无 POST/PUT/DELETE/`setDoOutput` | PASS |
| HTTP 超时 | `clampTimeout()` 限制 1000–30000ms（`:220`）；连接/读取超时都取剩余预算（`:129-130`）；Redis 重定向共用 deadline（`:114-122`） | PASS |
| 重定向 | 手动跟随，最多 5 次（`MAX_REDIRECTS`），非 2xx/超限映射错误（`:138-153`） | PASS |
| 8192 截断 | `MAX_BODY_CHARS = 8192`；`readBody()` 多读 1 字符判断截断、去 BOM、`truncated` 回传（`:30,:175-210`） | PASS |
| 错误映射 | `INVALID_URL / TIMEOUT / NETWORK / HTTP`，异常不外抛（`:108-172`、`HttpResult.toJson()`） | PASS |
| 配置加密 | `SecureConfigStore`：AndroidKeyStore + `AES/GCM/NoPadding`、AES-256、随机 IV（长度入包）、Base64 存 SharedPreferences、损坏回 `{}`（`:28-137`） | PASS |
| allowBackup | `AndroidManifest.xml:14` `allowBackup="false"`；APK xmltree 同样为 false | PASS |
| WebView 只加载本地 assets | `WebViewAssetLoader` + 自定义 https 域名；`setAllowFileAccess(false)`/`setAllowContentAccess(false)`/关闭 file URL 跨源；`shouldInterceptRequest` 只处理 `https://appassets.androidplatform.net` | PASS |
| release 关调试 | `WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)`；release 生成 `BuildConfig.DEBUG=false`（构建产物已核对） | PASS |
| 外部导航 | `handleNavigation()` 仅内部域名留在 WebView，其它 http/https/mailto/tel 交给系统（`Intent.ACTION_VIEW`） | PASS |
| 返回键/API 33 | 关闭 `enableOnBackInvokedCallback`；用 legacy `onBackPressed` → `window.__powercardBack()`；DEX 中 `OnBackInvoked*` 字符串 ABSENT（无 API 33 类型直接引用） | PASS |
| 本地资源路径穿越 | `RootAssetsPathHandler.normalize()` 拒绝 `..`、`\`、NUL，空路径映射 index.html | PASS |
| 日志/敏感信息 | 全部 Java 源码无 `Log.*`/`System.out`/`printStackTrace`；配置内容不写日志 | PASS |
| JS 接口 | `@JavascriptInterface` 方法：`getConfigJson/saveConfigJson/httpGet/copyText/getAppVersion`；HTTP 回调经主线程 `evaluateJavascript` 且 requestId 用 `JSONObject.quote` 转义 | PASS |
| 线程/生命周期 | HTTP 走 4 线程 daemon 线程池；`onDestroy` 中 `shutdown()` + 移除接口 + destroy；回调检查 `released` | PASS |
| 兼容性 | `Build.VERSION` 检查后再调用 API 29/33 接口（`setForceDark`、`setAlgorithmicDarkeningAllowed`、inset/contrast）；Java 17 源码由 D8 处理 | PASS |

## 2. JS（原生兼容层）

| 检查项 | 位置 | 结论 |
| --- | --- | --- |
| 原生检测 | `native-bridge.js:10-13`：`PowerCardNative` 且 `getConfigJson/httpGet` 才启用；普通浏览器不覆盖 fetch | PASS |
| fetch 覆盖 | 仅拦截 `raw.startsWith("/api/")`，返回 `native-api.js` 构造的标准 `Response` | PASS |
| 回调匹配 | `requestId = req_<ts>_<seq>` + `pending` Map；`window.__powercardHttpResult` 按 id 匹配；5s+timeout 兜底 | PASS |
| /api 语义 | `native-api.js` 实现 health/config GET+PUT/status/command/test/logs；状态解析复用 `parser.js`；1.5s 短缓存、demo、日志环形缓冲、中文文案与服务端契约一致 | PASS |
| SW 跳过 | `app.js:442` `if (window.__POWERCARD_NATIVE__) return;`；原生模式 E2E 断言无 SW registration | PASS |
| 模块顺序 | `index.html:18-19` `native-bridge.js` 在 `app.js` 之前 | PASS |
| 二次确认 | `app.js:902-935` 统一对 on/off/reboot 弹确认（含 `确认开机？` 文案、success/danger/dark tone）；E2E 断言通过 | PASS |
| 契约保真边缘 | 本地兼容层与 `docs/api-contract.md` 有细小差异：`POST /api/health`、`POST /api/logs` 返回 404 而非 405；`PUT /api/config` 对非法 MAC/`confirmActions` 不做服务端式字段报错（前端 app.js 已先校验，不会触发）。见 P2-4 | 观察项 |

## 3. 源码 ↔ APK 绑定

- DEX 字符串确认源码关键常量进入 APK：`https://appassets.androidplatform.net/assets/public/index.html`、`window.__powercardHttpResult`、`window.__powercardBack`、`PowerCardNative`、`AES/GCM/NoPadding`。
- `assets/public/*` 与仓库 `public/*` 14 个文件逐一 SHA-256 MATCH（见 `05-assets-hash-compare.txt`）。
- `server/parser.js` 当前只是 `export * from '../public/shared/parser.js'` 的兼容再导出（哈希不同属预期），Node 与 APK 共用同一份解析器实现。
