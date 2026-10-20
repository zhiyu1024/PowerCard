# Android APK 验收报告

- 交付物：`dist/PowerCard-v1.0.0.apk`
- 包名：`com.powercard.remote`
- 版本：versionName `1.0.0` / versionCode `1`
- 大小：1,697,462 字节
- SHA-256：`cdd4bf7c0f06f9f265ec8207f6a4a0a11f8b0646ca0b743609d592ae13c766ce`
- 构建日期：2026-10-20
- 结论：**PASS（构建 / 签名 / 静态 / JS 原生模拟通过；真机运行未执行）**

> 本机没有 Android 真机或可用模拟器（CPU 虚拟化未开启），因此无法代替用户在手机上点击安装。
> 已尽可能用真实 APK 解包、`apksigner`、`aapt2`、DEX 检查和 Chromium“模拟 WebView 原生桥”覆盖运行时路径。

---

## 1. 交付物与构建

| 项目 | 结果 |
| --- | --- |
| Release APK | `dist/PowerCard-v1.0.0.apk`（1,697,462 B） |
| SHA-256 | `cdd4bf7c0f06f9f265ec8207f6a4a0a11f8b0646ca0b743609d592ae13c766ce` |
| Debug APK | `dist/PowerCard-v1.0.0-debug.apk`（仅调试，非最终交付） |
| 构建命令 | `powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1` |
| 工具链 | JDK 17.0.2 / Gradle 8.9 / AGP 8.7.3 / SDK 35 / build-tools 35.0.0 |
| 构建结果 | `assembleDebug`、`assembleRelease` 均 BUILD SUCCESSFUL |

### 签名

`apksigner verify --verbose --print-certs`：

- `Verifies`
- APK Signature Scheme v2: true
- Signer #1：`CN=PowerCard Remote, OU=PowerCard, O=PowerCard, L=Local, ST=Local, C=CN`
- 证书 SHA-256：`624d265b000a279d721896c691853b00fd77fc1cb25bd252c64dd5822c5f03e8`
- RSA 2048

keystore：`android/keystore/powercard-release.jks`（gitignore，不提交；需备份）。

## 2. Manifest / 权限

`aapt2 dump badging` / `dump xmltree`：

| 项目 | 实际 |
| --- | --- |
| package | `com.powercard.remote` |
| versionName | `1.0.0` |
| versionCode | `1` |
| minSdk | `26`（Android 8.0） |
| targetSdk / compileSdk | `35` / `35` |
| 应用名 | `远程电脑控制` |
| 权限 | `INTERNET`、`ACCESS_NETWORK_STATE` |
| `allowBackup` | `false` |
| `usesCleartextTraffic` | `true`（局域网 http） |
| `enableOnBackInvokedCallback` | `false`（minSdk 26 避免引用 API 33 类型，legacy 返回键） |
| exported Activity | 仅 `MainActivity`（launcher） |
| release debuggable | 否 |

## 3. APK 内容

共 132 个条目。关键内容：

```text
AndroidManifest.xml
classes.dex
resources.arsc
assets/public/index.html
assets/public/app.js
assets/public/styles.css
assets/public/native-bridge.js
assets/public/shared/native-api.js
assets/public/shared/parser.js
assets/public/manifest.webmanifest
assets/public/sw.js
assets/public/favicon.svg
assets/public/icons/*
```

APK 内 14 个前端资源与仓库 `public/` 当前版本逐一 SHA-256 比对：全部 **MATCH**。

DEX 中确认存在：

- `com.powercard.remote.MainActivity`
- `com.powercard.remote.NativeBridge`
- `com.powercard.remote.NativeHttpClient`
- `com.powercard.remote.SecureConfigStore`
- `com.powercard.remote.RootAssetsPathHandler`

DEX 字符串中确认存在桥接方法：`PowerCardNative`、`getConfigJson`、`saveConfigJson`、`httpGet`、`copyText`、`getAppVersion`、`window.__powercardHttpResult`、`AES/GCM/NoPadding`。

## 4. 架构验证

```text
WebView（https://appassets.androidplatform.net/assets/public/index.html）
   │  本地资源由 WebViewAssetLoader 提供
   │  /api/* 被 native-bridge.js 覆盖的 fetch 拦截
   ▼
window.PowerCardNative（Java 注入）
   ├─ getConfigJson / saveConfigJson：Android Keystore AES/GCM
   └─ httpGet：Executor + HttpURLConnection（手机网络）
         → 开机卡状态/开关机/重启 URL
```

- 无 Node、无外部服务器、无 CORS。
- `usesCleartextTraffic=true` 支持局域网 `http://`。
- release 关闭 WebView 调试；仅加载 appassets 本地页面；外部 http/https 用系统浏览器打开。
- 配置不打印 token/URL 日志；`allowBackup=false`。

## 5. 自动化测试结果

| 测试 | 结果 | 说明 |
| --- | --- | --- |
| Node 单元 + 集成 | **79/79 PASS** | 解析器、配置、设备请求、API、静态资源 |
| Native bridge API 单测 | **11/11 PASS** | demo/live/HTTP 错误/超时/config/缓存/test/logs |
| Chromium 原生模式 E2E | **6/6 PASS** | 精确加载 `/assets/public/index.html`；注入 PowerCardNative；配置保存、live 切换、开关机确认、日志、刷新保持、无 console error |
| Web E2E（回归） | **18/18 PASS** | 确认开机/关机/重启、设置、PWA、响应式 |
| APK 签名 | PASS | v2 true；证书正确 |
| APK 静态检查 | PASS | 包名/版本/权限/assets/DEX |
| 真机安装运行 | **未执行** | 无真机/模拟器；需用户安装后反馈 |

测试命令：

```powershell
$env:NODE_OPTIONS='--test-isolation=none'; npm test
npm run test:native
npm run test:e2e
```

## 6. 需求对照

| 用户要求 | 实现 | 验证 |
| --- | --- | --- |
| 安卓 APK，不是 PWA | `PowerCard-v1.0.0.apk`，Java 原生壳 | 签名/包名/静态检查 |
| 不需要电脑或服务器 | 原生 HttpURLConnection 直连；APK 不启动 Node | 架构 + Java 代码审查 |
| 手机网络访问 URL | 原生层使用手机 Wi-Fi/移动数据；无 CORS | 原生 HTTP 实现 + JS 模拟 |
| 首页显示卡在线/电脑状态 | 首页 hero 状态区 | E2E |
| 大按钮开关机 / 小按钮重启刷新 | 2 大 + 2 小 | E2E + 计算样式 |
| 右上角调试按钮设置 URL | 设置抽屉 14 项 | E2E |
| 开机也二次确认 | 开机/关机/重启统一确认 | E2E 6/6 + 18/18 |
| 网址全部 GET | Java `setRequestMethod("GET")` | 代码审查 |
| 配置保存 | 加密 SharedPreferences | Java 代码审查 + 原生模拟 |
| 公网/内网地址等资料 | 设置页记录展示 | E2E |

## 7. 未执行项与风险

1. **真机安装/运行**：本机无虚拟化，无法启动 Android 模拟器；未在真实手机验证 WebView 渲染、Keystore、网络权限弹窗、厂商后台限制。
2. **真实开机卡**：未使用真实 URL/token；全部使用 mock/浏览器原生模拟。用户首次真机联调时需确认开机卡返回结构和 HTTP/HTTPS。
3. **自签名 HTTPS**：默认系统证书；自签证书会被拒绝，需要额外信任配置。
4. **品牌 ROM**：Android 8–15、WebView 版本差异可能导致极少数样式差异；页面本身已在 Chromium 多尺寸验收。
5. **签名升级**：必须保留 `android/keystore/`；丢失后无法覆盖升级。
6. **应用商店**：当前 release 签名适合自用/侧载；上架需按商店要求补充隐私声明、审核和签名策略。

## 8. 复现校验

```powershell
$bt = ".android-toolchain\android-sdk\build-tools\35.0.0"
$env:JAVA_HOME = (Resolve-Path ".android-toolchain\jdk").Path

& "$bt\apksigner.bat" verify --verbose --print-certs dist\PowerCard-v1.0.0.apk
& "$bt\aapt2.exe" dump badging dist\PowerCard-v1.0.0.apk
& "$bt\aapt2.exe" dump xmltree --file AndroidManifest.xml dist\PowerCard-v1.0.0.apk
Get-FileHash -Algorithm SHA256 dist\PowerCard-v1.0.0.apk
```

期望 SHA-256：`cdd4bf7c0f06f9f265ec8207f6a4a0a11f8b0646ca0b743609d592ae13c766ce`

---

## 9. 独立复核（独立 QA 复验，2026-10-20）

> 复核人：qa-verifier（未参与 APK/前端实现，独立复算，不采信原报告结论）。
> 复核方式：重新计算哈希、`apksigner`/`aapt2` 解包核对、DEX 类与字符串检查、Java/JS 源码逐行审查、
> 三套测试独立复跑、README/docs 一致性核对、安全扫描。原报告第 1–8 节内容保持原样，仅追加本章。
> 证据目录：`qa/apk-verify/`（逐项清单 `00-INDEPENDENT-CHECKLIST.md`，命令原始输出 `01`–`16`、代码审查记录 `09-js-review.md`）。

### 9.1 复核结论

- **独立复核：PASS**。P0 = 0，P1 = 0；P2 = 4（2 项文档/说明类 + 2 项兼容性/契约说明，均不阻塞安装与使用）。
- 原报告的关键结论均被独立复现：大小 1,697,462 B、SHA-256、v2 签名与证书、包名/版本/minSdk/targetSdk、
  132 个 APK 条目、14 个 `assets/public` 文件与仓库 `public/` 全 MATCH、测试 90/90 + 18/18 + 6/6。
- **未做真机/模拟器安装运行验证**，本章不含“真机通过”结论（见 9.4）。

### 9.2 逐项复核结果

| # | 复核项 | 结果 | 独立证据 |
| --- | --- | --- | --- |
| 1 | SHA-256 与 `.sha256` 一致；apksigner v2；证书信息 | **PASS** | 实测 `CDD4BF7C0F06F9F265EC8207F6A4A0A11F8B0646CA0B743609D592AE13C766CE`，与 `dist/PowerCard-v1.0.0.apk.sha256` 一致；`Verifies`，v2=true（v1/v3=false，minSdk 26 可接受）；DN `CN=PowerCard Remote, OU=PowerCard, O=PowerCard, L=Local, ST=Local, C=CN`；证书 SHA-256 `624d265b000a279d721896c691853b00fd77fc1cb25bd252c64dd5822c5f03e8`；RSA 2048；有效期 2026-10-20 → 2054-03-07（约 10000 天）。debug APK：2,185,012 B / `E0CDEA17…950736` |
| 2 | badging 包名/版本/min/target/权限/应用名/无 debuggable | **PASS** | `com.powercard.remote`、versionCode 1、versionName 1.0.0、minSdk 26、targetSdk 35、compileSdk 35、`INTERNET`（另 `ACCESS_NETWORK_STATE` 与 AndroidX 自动生成的 `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`）、`远程电脑控制`；release 无 `application-debuggable`，debug 包有 `debuggable=true`（符合预期） |
| 3 | xmltree：allowBackup / cleartext / back callback / exported | **PASS（附注）** | `allowBackup=false`、`usesCleartextTraffic=true`、`enableOnBackInvokedCallback=false`；exported **Activity** 仅 `MainActivity`（launcher）。合并清单另含 `androidx.profileinstaller.ProfileInstallReceiver` exported=true（受 `android.permission.DUMP` 保护，普通第三方应用无法触发），见 P2-2 |
| 4 | APK 内容与 assets 源码一致性 | **PASS** | 132 个 zip 条目；`classes.dex`、`AndroidManifest.xml`、`resources.arsc` 及 9 个必查路径均存在；`assets/public` 共 14 个文件；与仓库 `public/` 逐一 SHA-256 **14/14 MATCH**（含 `index.html`/`app.js`/`styles.css`/`native-bridge.js`/`sw.js`/`shared/native-api.js`/`shared/parser.js`） |
| 5 | DEX 类与桥字符串 | **PASS** | 5 个类描述符全部 FOUND；`PowerCardNative`、`getConfigJson`、`saveConfigJson`、`httpGet`、`window.__powercardHttpResult`、`AES/GCM/NoPadding`、`copyText`、`getAppVersion` 全部 FOUND；`OnBackInvoked*` 字符串 ABSENT；另确认 `START_URL`、`window.__powercardBack` 等源码字符串进入 DEX |
| 6 | Java 代码审查 | **PASS** | 逐行审查 5 个 Java 文件：只发 GET；超时 1000–30000ms + 跨重定向 deadline；重定向 ≤5；8192 字符截断（含 `truncated`）；`INVALID_URL/TIMEOUT/NETWORK/HTTP` 错误映射；Keystore AES/GCM 加密配置；无任何 `Log.*`/`System.out`；WebView 只加载本地 assets、file/content 关闭、release 关调试（`BuildConfig.DEBUG=false` 已核对构建产物）、外部链接交系统浏览器；本地资源路径穿越拒绝；无 API 33 `OnBackInvoked*` 直接引用 |
| 7 | JS 原生模式 | **PASS** | `native-bridge.js` 仅原生环境覆盖 `/api/` fetch；requestId + `pending` Map 回调匹配 + 超时兜底；`app.js` 原生模式跳过 Service Worker；`index.html` 中 `native-bridge.js` 位于 `app.js` 之前；`native-api.js` 复现 `/api` 语义并复用 `shared/parser.js`；`app.js` 开机/关机/重启统一二次确认（`确认开机？` 文案与 tone 正确） |
| 8 | 测试独立复跑 | **PASS** | `$env:NODE_OPTIONS='--test-isolation=none'; npm test` → **90/90 pass，0 fail**，exit 0；`node tests/e2e/run.js` → **18/18 pass**，exit 0；`node tests/e2e/native-mode.js` → **6/6 pass**，exit 0 |
| 9 | README/docs 一致性 | **PASS（附注）** | README、`docs/android-build.md`、本报告中的 APK 大小与 SHA-256 与实测一致；README 三处“开机/关机/重启均二次确认”描述与代码/E2E 一致；全仓库 README+docs 仅出现 2 个唯一 64-hex（APK SHA 与证书指纹），**无旧 hash**；`npm test` / `npm run test:e2e` / `npm run test:native` 命令均存在。发现 README 校验命令路径缺 `.android-toolchain\` 前缀（P2-1） |
| 10 | 安全检查 | **PASS** | `git check-ignore` 确认 `android/keystore/`（含 `.jks`/`keystore.properties`）与 `.android-toolchain/` 均被忽略；`git status --untracked-files=all` 无 keystore/口令路径；APK 内无 keystore/jks/口令文件（唯一 `META-INF/.../app-metadata.properties` 仅含 AGP 版本，无敏感信息）；203 个可扫描文件 57 处命中全部为文档示例、UI 占位符（`192.168.1.50` 等）与构建脚本变量名，**无 Bearer token、`token=` 实值、私钥块、真实厂商域名** |
| 11 | 已知限制声明 | **PASS** | README 与报告均明确写“未做真机安装后的运行验证 / 未执行”，本复核同样不写“真机通过” |

### 9.3 发现的问题（P0/P1 无；P2 汇总）

**P2-1（文档，不阻塞）README 的 APK 校验命令路径不正确**

- 复现：仓库根执行 `Test-Path android-sdk/build-tools/35.0.0/apksigner.bat` → `False`。
- 期望：README「APK 校验」与 `docs/android-build.md`、本报告第 8 节一致，使用 `.android-toolchain\android-sdk\build-tools\35.0.0\...`。
- 实际：README 第 233–234 行写作 `android-sdk/build-tools/35.0.0/...`（缺少 `.android-toolchain\` 前缀），直接复制执行会找不到文件。
- 说明：本任务写作用域不含 README，未改动；建议 owner 一行修正。

**P2-2（文档表述，不阻塞）“仅 MainActivity exported”不完整**

- 复现：`aapt2 dump xmltree` 可见 exported 组件为 `MainActivity`（Activity）与 `androidx.profileinstaller.ProfileInstallReceiver`（receiver，`exported=true`，`android.permission.DUMP`）。
- 来源：manifest merger 报告显示来自传递依赖 `androidx.profileinstaller:1.3.0`（AGP 用于安装 baseline profile）。
- 影响：该 receiver 受系统级 `DUMP` 权限保护（`signature|privileged|development`），普通第三方应用无法向其发送广播；**不构成可利用安全漏洞**，但 `docs/android-build.md` 第 152 行“仅 … MainActivity 为 exported”表述不严谨。
- 建议（不阻塞）：文档改为“exported Activity 仅 MainActivity；另有 AndroidX ProfileInstallReceiver（DUMP 保护）”，或后续评估移除 profileinstaller。本报告 §2 的“exported Activity 仅 MainActivity”表述本身准确，无需改动。

**P2-3（兼容性说明，不阻塞，未真机验证）最低 WebView 版本未声明**

- 静态检查：`public/shared/parser.js` 使用 `??`（约需 Chrome/WebView 80+），`public/app.js` 使用 `Element.replaceChildren`（约需 86+），CSS 使用 `:where()`（约需 88+）；ES Modules 本身需 61+。
- 风险：`minSdk 26` 只约束 Android 系统版本，不约束系统 WebView 版本。若设备 WebView 很旧（如 Android 8 出厂未更新），页面脚本可能解析失败（白屏），而 README 仅写“Android 8.0 及以上”。
- 建议：README/构建文档补充“需要可更新的 Android System WebView（建议 100+）”，或在构建前做语法降级（Babel/esbuild 目标 Chrome 61 不能覆盖 `??`/`replaceChildren`，需相应 polyfill/改写）。需真机/多 WebView 版本验证。
- 说明：非本次 APK 构建缺陷，属兼容性声明缺失；Android System WebView 通常随 Play 商店更新，主流设备风险低。

**P2-4（契约保真，不阻塞）本地 `/api` 兼容层与服务端契约的细小边缘差异**

- `public/shared/native-api.js` 中 `POST /api/health`、`POST /api/logs` 返回 404 而非 `docs/api-contract.md` 规定的 405；
  `PUT /api/config` 对非法 MAC / 非布尔 `confirmActions` 不做服务端式字段报错（前端 `app.js` 的客户端校验会先拦截，正常 UI 路径不会触发）。
- 影响：`app.js` 不调用这些错误方法，实际功能与界面行为不受影响；`docs/android-bridge-contract.md` 声称“响应体结构与 api-contract 完全一致”，严格说存在边界差异。
- 建议：后续补 1–2 个 `native-api` 单测对齐，或在该文档标注“错误方法与非法字段为端上兜底，不保证 405/字段错误同构”。

### 9.4 未验证项与限制（如实声明）

1. **未执行真机或模拟器安装/运行**：本机无真机、CPU 虚拟化不可用无法启动模拟器；未验证实际安装、首次启动、WebView 渲染、Android Keystore 真机加解密、网络权限、后台/省电策略、厂商 ROM 差异、系统字体缩放与深色模式。**不得表述为“真机通过”**。
2. 未使用真实开机卡/TLStoken；仅 mock 与浏览器原生模拟。自签名 HTTPS 证书仍会遇到系统证书校验失败（README 已列为已知限制）。
3. 环境为 Windows + 本机工具链（JDK 17.0.2 / Gradle 8.9 / AGP 8.7.3 / SDK 35 / build-tools 35.0.0），与 `docs/android-build.md` 记录一致。
4. 包内容核对时，Windows 大小写不敏感解压得到 131 个文件而 zip 有 132 条目，原因是 `res/zR.png` 与 `res/zr.png` 仅大小写不同（Android 文件系统区分大小写，属两个合法资源；`zipalign` 校验通过），**不是 APK 缺陷**。

### 9.5 复核结论

独立复核**通过**：APK 的哈希/签名/manifest/资源/DEX 与仓库源码一致，构建与自动化测试可重复，README/docs 关键数据与命令基本一致，未见 P0/P1 问题，未见 keystore/token 泄漏。建议 Lead 接受交付；交付前可顺手修复 **P2-1（README 命令路径）** 与 **P2-2（exported 表述）**，并在 README 已知限制补充 **P2-3（WebView 版本）**；P2-4 可选。首次真机安装仍需用户按 README 步骤人工验证。

### 9.6 Lead 收尾修复（2026-10-20）

- **P2-1 已修复**：README「APK 校验」命令改为 `.android-toolchain\android-sdk\build-tools\35.0.0\...`。
- **P2-2 已修复**：`docs/android-build.md` 改为“exported Activity 仅 MainActivity；另有 AndroidX ProfileInstallReceiver（DUMP 权限保护）”。
- **P2-3 已修复**：README 与 `docs/android-build.md` 增加“建议 Android System WebView 100+”的已知限制。
- **P2-4 已记录**：`docs/android-bridge-contract.md` 第 8 节补充端上 `/api` 兜底的已知边缘差异（错误方法 404、非法字段校验较宽松）。
- 上述仅文档修改，APK 文件与 SHA-256 不变：`cdd4bf7c0f06f9f265ec8207f6a4a0a11f8b0646ca0b743609d592ae13c766ce`。

