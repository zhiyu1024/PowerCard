# v1.1.0 桌面小组件 APK · 独立验收报告

- 任务：`task-7` — 独立 QA：v1.1.0 桌面小组件 APK 与两段式确认/静态/测试复核
- 验收人：qa-verifier（独立 QA，未参与 v1.1.0 实现；本报告不采信构建者结论，逐项独立复算）
- 验收时间：2026-10-20（Asia/Shanghai）
- 交付物：`dist/PowerCard-v1.1.0.apk`（1,722,546 B，SHA-256 `5af3560855f5707ae0718f86daedd1bc69b72eeda71f32ec0dacc39d7fb22599`）
- 对照版本：`dist/PowerCard-v1.0.0*` 三件套保留
- **结论：PASS（静态 / 签名 / 内容 / 代码审查 / 自动化测试复跑均通过；真机与模拟器未执行）**
- 问题：**P0 = 0，P1 = 0，P2 = 4**（2 项文档漂移、1 项待真机核对的视觉风险、1 项说明缺失；均不阻塞交付）

> 本报告全文不包含“真机通过”结论。v1.1.0 的桌面小组件 Runtime（RemoteViews 渲染、两段式点击、pin 弹窗、AlarmManager 延迟刷新）**未在真机/模拟器上验证**，详见第 5 节。
> 本任务仅新增本报告与 `qa/widget-verify/**` 证据，未修改产品代码、README 或其它 docs。

---

## 1. 环境与工具链

| 项目 | 值 |
| --- | --- |
| OS | Microsoft Windows 11 专业版 10.0.26300 |
| Node.js / npm | v24.21.0 / 11.19.0 |
| JDK / Gradle / AGP | OpenJDK 17.0.2 / Gradle 8.9 / AGP 8.7.3 |
| Android SDK | SDK 35 / build-tools 35.0.0（仓库内 `.android-toolchain/`） |
| playwright-core / Chromium | 1.64.1 / chrome-headless-shell 156.0.8078.4 |
| 验收范围 | `dist/PowerCard-v1.1.0.apk` + `.sha256` + debug APK；`v1.0.0` 三件套保留；README、`docs/android-build.md`、`docs/android-bridge-contract.md`、`docs/android-qa-report.md` |
| 证据目录 | `qa/widget-verify/`（逐项清单 `00-INDEPENDENT-CHECKLIST.md`，命令原始输出 `01`–`23`，Java 单测 XML 在 `test-results-xml/`） |

---

## 2. 逐项核验结果（10/10 PASS）

| # | 核验项 | 结果 | 关键实测 / 证据 |
| --- | --- | --- | --- |
| 1 | SHA-256 与 `.sha256` 一致；apksigner v2；证书 SHA-256 与 v1.0.0 同一 keystore | **PASS** | 实测 `5AF3560855F5707AE0718F86DAEDD1BC69B72EEDA71F32EC0DACC39D7FB22599`（与文件一致）、1,722,546 B；`Verifies`、v2=true；证书 `CN=PowerCard Remote,…` / SHA-256 `624d265b000a279d721896c691853b00fd77fc1cb25bd252c64dd5822c5f03e8`，与 v1.0.0 APK 证书完全一致；debug APK 2,248,938 B / `CE19…506B`（`01-hash-signature.txt`） |
| 2 | badging：versionCode 2 / versionName 1.1.0 / package / minSdk 26 / targetSdk 35 / INTERNET / 应用名 / release 无 debuggable | **PASS** | `com.powercard.remote`、versionCode 2、versionName 1.1.0、minSdk 26、targetSdk/compileSdk 35、`INTERNET`（另有 `ACCESS_NETWORK_STATE`）、`远程电脑控制`、`provides-component:'app-widget'`；`application-debuggable` ABSENT（`02-badging.txt`） |
| 3 | xmltree：widget receiver exported=false、APPWIDGET_UPDATE intent-filter、`android.appwidget.provider` meta-data；无新增危险权限 | **PASS** | `PowerCardWidgetProvider` receiver `exported=false`、label=`@string/widget_label`、7 个 action（`APPWIDGET_UPDATE` + `REFRESH_ALL/WIDGET_REFRESH/POWER_ON/POWER_OFF/CONFIRM/CANCEL/DELAYED_REFRESH`）、meta-data resource `@0x7f0c0000`；权限与 v1.0.0 逐条一致（无新增）（`03-manifest-xmltree.txt`、`17-manifest-widget-receiver.txt`、`22-security-git.txt`） |
| 4 | 4 个 widget layout / xml/widget_info / widget strings；widget_info 关键属性 | **PASS** | `layout/widget_powercard_{4x2,2x2,4x2_confirm,2x2_confirm}`、`xml/widget_info`、`string/widget_*` 全部存在（`04-resources.txt`、`18-widget-resources.txt`）；widget_info：minWidth 250dp、minHeight 110dp、minResize 110dp、targetCellWidth/Height 4/2、updatePeriodMillis 1800000、previewLayout/initialLayout=4×2 普通布局、description 已配（`08-widget-info-values.txt`，debug 原文名 `15-widget-info-debug.txt`）；APK 内字符串值实测：`电脑开关机`、`未配置 · 打开 App 设置`、`确认开机？`、`已发送，正在刷新…` 等（`20-widget-string-values.txt`） |
| 5 | assets/public 14 文件与仓库 `public/` 逐一 SHA-256 MATCH（含 native-bridge widget 区块） | **PASS** | **14/14 MATCH**，含变更后的 `index.html`（widgetSection）、`native-bridge.js`（widget API 区块）与未变的 `app.js`（`07-assets-hash-compare.txt`、`19-native-bridge-widget.txt`） |
| 6 | DEX 含 8 个 widget 类 + 桥方法 requestPinWidget/refreshWidgets | **PASS** | `PowerCardWidgetProvider`、`WidgetRenderer`、`WidgetRefresher`、`WidgetStateParser`、`WidgetStore`、`WidgetConfig`、`WidgetContract`、`WidgetPin` 均存在；`NativeBridge.requestPinWidget()/refreshWidgets()`、`isRequestPinAppWidgetSupported`、4 个布局资源名、7 个 action 字符串均在 DEX（`10-dex-widgets.txt`、内联 DEX 检查输出） |
| 7 | 代码审查：两段式确认 / 未配置 / 错误保留 / 刷新 / 超时 clamp / 只 GET / 安全 / 设置入口 / 尺寸说明 | **PASS（Runtime 未验证）** | 逐行审查 8 个 widget 类 + `NativeBridge`/`NativeHttpClient`：第一次点击只写 pending + 渲染确认态、**不发请求**；第二次点击才 GET；pending 按 appWidgetId、30s TTL、取消/过期恢复、`onDeleted` 清理；未配置 `hasStatusUrl()` 分支不请求、不显示 demo/假数据；错误保留上次成功状态与时间；状态 URL 来自 `SecureConfigStore`（Keystore AES/GCM）；超时 clamp `[1000,5000]ms`；仅 `NativeHttpClient.get`（GET）；无 `Log.*`；receiver exported=false + `FLAG_IMMUTABLE`；`#widgetSection` 仅原生模式显示并调用 `requestPinWidget`；JS 在 config/command 后调用 `refreshWidgets`（`23-widget-code-grep.txt`） |
| 8 | 测试复跑：90/90、18/18、7/7、Gradle 29/29 | **PASS** | `npm test` → 90/90（exit 0，`11-npm-test.txt`）；`node tests/e2e/run.js` → 18/18（exit 0，`12-e2e-web.txt`）；`node tests/e2e/native-mode.js` → 7/7（exit 0，`13-e2e-native.txt`）；`gradle :app:testDebugUnitTest --rerun-tasks` → BUILD SUCCESSFUL（exit 0，`14-gradle-unit-tests.txt`），XML 实测 `WidgetStateParserTest` 24/24、`WidgetConfigTest` 5/5，failures/errors/skipped 均为 0（`test-results-xml/`） |
| 9 | 文档/安全：v1.1.0 大小/SHA/命令一致；无旧 v1.1 hash；2×2 需 resize、未真机；git 无 keystore/token；APK 无真实 token/厂商 URL | **PASS（附 P2-1/P2-2 文档瑕疵）** | README 与 `docs/android-build.md` 的 1,722,546 B、`5af356…`、构建/校验命令与实测一致；README 明示“2×2 需长按 resize”“未真机验证”；全 README/docs 只有 3 个唯一 64-hex 值（v1.1.0 hash 2 处、v1.0.0 hash 7 处、证书指纹 4 处），**无旧 v1.1 hash**；`git check-ignore` 命中 `android/keystore/`、`.android-toolchain/`，git 未跟踪列表无 keystore/口令；231 个文件（APK 解包 + 源码 + docs + scripts）扫描无 Bearer token、`token=` 实值、私钥、真实厂商域名（只有 UI 占位符 `192.168.x`）（`21-docs-claims.txt`、`22-security-git.txt`、`16-security-scan.txt`） |
| 10 | 未真机/模拟器，不得写“真机通过” | **PASS** | README 第 334/341 行、`docs/android-build.md` §9/§10 均写“未验证/不能声明真机通过”；本报告 §5 再次如实声明 |

---

## 3. 详细核验记录

### 3.1 签名与版本

- `dist/PowerCard-v1.1.0.apk`：1,722,546 B；实测 SHA-256 `5af3560855f5707ae0718f86daedd1bc69b72eeda71f32ec0dacc39d7fb22599`，与 `dist/PowerCard-v1.1.0.apk.sha256` 一致。
- `apksigner verify --verbose --print-certs`：`Verifies`；APK Signature Scheme v2=true（v1/v3=false，minSdk 26 可接受）；证书 DN `CN=PowerCard Remote, OU=PowerCard, O=PowerCard, L=Local, ST=Local, C=CN`；证书 SHA-256 `624d265b000a279d721896c691853b00fd77fc1cb25bd252c64dd5822c5f03e8`；RSA 2048。
- 与 v1.0.0 **同一 keystore/证书**（`dist/PowerCard-v1.0.0.apk` 证书 SHA-256 完全相同），因此可直接覆盖升级；`versionCode=2` > 1，升级路径成立。
- debug APK：2,248,938 B / `CE1911CBECC43584BAF0395608EF280F9AF2C338FD93365CBCB089CDC36B506B`，`application-debuggable` 存在（debug 预期）；release 无 debuggable。
- 构建脚本默认值已核对：`scripts/build-android.ps1` 默认 `-Version 1.1.0 -VersionCode 2`，与产物/文档一致；脚本在 release 前执行 `:app:testDebugUnitTest` 并以 XML 计数校验。

### 3.2 Manifest / Widget 声明

- package `com.powercard.remote`；versionCode 2 / versionName 1.1.0；minSdk 26 / targetSdk 35 / compileSdk 35。
- 权限与 v1.0.0 一致：`INTERNET`、`ACCESS_NETWORK_STATE`、AndroidX 自动生成的 `com.powercard.remote.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`；**无新增危险权限**（无 `RECEIVE_BOOT_COMPLETED`、无精确闹钟权限等）。
- `PowerCardWidgetProvider` receiver：`android:exported="false"`、`label="@string/widget_label"`、intent-filter 含 `android.appwidget.action.APPWIDGET_UPDATE` 与 6 个自定义 action（`REFRESH_ALL`、`WIDGET_REFRESH`、`POWER_ON`、`POWER_OFF`、`CONFIRM`、`CANCEL`、`DELAYED_REFRESH`）、meta-data `android.appwidget.provider` → `@xml/widget_info`。
- 既有属性保持：`allowBackup=false`、`usesCleartextTraffic=true`、`enableOnBackInvokedCallback=false`；exported Activity 仍仅 `MainActivity`；AndroidX `ProfileInstallReceiver`（DUMP 保护）为 v1.0.0 已存在的第三方组件，非新增。

### 3.3 WidgetProviderInfo / 布局 / 字符串

- `widget_info`：minWidth 250dp、minHeight 110dp（默认 4×2）；targetCellWidth/Height=4/2；minResizeWidth/Height=110dp；maxResizeWidth/Height=380/240dp；resizeMode=`horizontal|vertical`（0x3）；updatePeriodMillis=1800000；initialLayout=previewLayout=`@layout/widget_powercard_4x2`；description=`@string/widget_description`。以上与 `docs/android-build.md` §6.5、任务要求一致。
- 4 个布局文件均在 APK resources 中：`widget_powercard_4x2`、`widget_powercard_4x2_confirm`、`widget_powercard_2x2`、`widget_powercard_2x2_confirm`；布局使用 RemoteViews 支持的 `LinearLayout/TextView`，按钮均为 `TextView + PendingIntent`，无动态 addView。
- `2×2` 通过 resize 进入：初始/预览均为 4×2，`minResizeWidth/Height=110dp` 允许缩小；`WidgetRenderer.isCompact()` 以 `OPTION_APPWIDGET_MIN_WIDTH < 200` 或 `minHeight < 90` 选择紧凑布局。README 第 90/340 行、`docs/android-build.md` §5/§6.5/§10 均明确“2×2 需长按调整尺寸”，满足“事实需文档说明”的要求。
- APK 内字符串值实测（`apkanalyzer resources value`）：`widget_label=电脑开关机`、`widget_unconfigured_full=未配置 · 打开 App 设置`、`widget_confirm_on_title=确认开机？`、`widget_action_sent=已发送，正在刷新…` 等，与 `res/values/strings.xml` 一致。
- 配色/圆角：`widget_bg` 暖白 `#F6F4EF`、22dp 圆角、1dp 线条；`widget_green=#129C52`、`widget_red=#CF4B3A`、`widget_ink=#171B18`、`widget_muted=#6E746D`，对齐 App 设计令牌。

### 3.4 APK 内容与 assets 一致性

- zip 条目：141 个；`classes.dex`、`AndroidManifest.xml`、`resources.arsc`、4 个布局、`res/xml/widget_info`、widget strings/drawables 均在。
- `assets/public` 14 个文件与仓库 `public/` 当前版本逐一 SHA-256 **14/14 MATCH**；其中 `index.html`（新增 `#widgetSection`）、`native-bridge.js`（widget API/刷新通知区块）与 APK 内一致；`app.js` 未变（哈希与 v1.0.0 assets 相同）。
- 说明：Windows 大小写不敏感解压得到 140 个文件而 zip 有 141 条目，原因是 `res/zR.png` 与 `res/zr.png` 仅大小写不同（Android 文件系统区分大小写，属两个合法资源；`zipalign -c 4` 校验通过），不是 APK 缺陷。

### 3.5 DEX 内容

- 8 个 widget 类全部存在（见第 2 节表格），`NativeBridge.requestPinWidget()/refreshWidgets()`、`WidgetPin.requestPin()`（内部调用 `isRequestPinAppWidgetSupported`）、7 个自定义 action 字符串、4 个 layout 资源名、`widget_*` 字符串均可在 DEX/资源中定位。
- **未引入** `androidx.work` / `androidx.compose` / `androidx.glance` / `androidx.room` / Material 组件（DEX 包列表与 Gradle 依赖双重确认），符合“RemoteViews 实现、不引 WorkManager/Compose/Glance”的要求。
- DEX/Java 源码中无 `Log.*` / `System.out` / `printStackTrace`；小组件侧无 demo 逻辑（`Widget*` 源码无 demo 引用）。

### 3.6 代码审查（重点）

1. **两段式确认（每个 appWidgetId 独立）**
   - 第一次点击 `POWER_ON/POWER_OFF` → `WidgetRefresher.enterConfirm()`：只 `WidgetStore.setPending(appWidgetId, action, now)`（写入 30s 过期时间）并调用 `WidgetRenderer.render()` 渲染确认态，**不调用任何 HTTP**。未配置时清 pending 并渲染未配置，不进入确认态。
   - 第二次点击 `CONFIRM` → `handleConfirmAsync()`：`getPendingAction()`（读取时校验 30s TTL，过期/非法自动 `clearPending` 并恢复普通态）→ `clearPending` → `executeCommandAsync()` → `NativeHttpClient.get(powerOnUrl/powerOffUrl)`；失败/成功分别写“发送失败/已发送”提示；成功后 `AlarmManager.set` 安排 2.5s 非精确延迟刷新。
   - `CANCEL`/`onDeleted`：清除 pending/该实例 action 数据并取消延迟刷新闹钟；`onAppWidgetOptionsChanged` 仅按新尺寸重绘、不发请求。
2. **未配置不显示假数据**：`WidgetConfig.hasStatusUrl()`（仅 http/https 且 host 非空）是唯一“已配置”判定；未配置时 `refreshBlocking` 直接 render“未配置 · 打开 App 设置”、隐藏操作按钮、根布局点击打开 App；`WidgetStore` 初始无成功记录时显示“状态未知 / 正在获取状态…”，不存在 demo 模拟状态。
3. **错误保留上次成功状态与时间**：`WidgetStore` 分开记录 `updatedAt` 与 `errorAt/errorMessage`；`WidgetRenderer` 在 `isErrorLatest()` 时仍用上次成功 power 文案，副文案显示“连接失败 · 上次 HH:mm”；从未成功才显示“状态未知 + 错误原因”。
4. **配置来源**：`WidgetConfig.fromJson(new SecureConfigStore(context).load())`，URL/token 来自 Android Keystore AES/GCM 加密的 SharedPreferences，小组件不落盘明文配置。
5. **刷新触发**：`onUpdate`（goAsync + 后台线程）、手动刷新按钮、App 保存配置（`NativeBridge.saveConfigJson` 成功后 `refreshWidgets()`）、JS 指令后 `/api/config` PUT 成功后 `native.refreshWidgets()`、`updatePeriodMillis=1800000`、指令成功后 2.5s AlarmManager 延迟刷新；单线程执行器 + 全局 REFRESH_IN_FLIGHT + per-widget COMMAND_IN_FLIGHT 做并发去重。
6. **超时 clamp**：`WidgetConfig.widgetTimeoutMs()` 将配置中的 `requestTimeoutMs` clamp 到 `[1000,5000]ms`（`WidgetContract.WIDGET_TIMEOUT_MS=5000`），与 goAsync 广播窗口匹配；单元测试覆盖 30000→5000、100→1000、4000→4000。
7. **只发 GET**：小组件所有网络调用均为 `NativeHttpClient.get()`；`NativeHttpClient` 仅 `setRequestMethod("GET")`，无 POST/PUT/DELETE。
8. **安全**：receiver `exported=false`；全部 PendingIntent 显式指向 provider 且 `FLAG_UPDATE_CURRENT | FLAG_IMMUTABLE`（含打开 App 的 Activity PendingIntent）；小组件不展示 URL/token，`WidgetStore` 只保存 power/online/时间/错误/操作提示；无任何日志输出。
9. **App 设置入口**：`public/index.html` 的 `#widgetSection` 默认 `hidden`，`public/native-bridge.js` 仅在检测到原生桥时解除隐藏并绑定「添加到桌面」→ `PowerCardNative.requestPinWidget()`；失败提示改为长按桌面手动添加。普通浏览器/PWA 不显示该区块。
10. **4×2/2×2 选择与文档**：见第 3.3 节。

### 3.7 测试复跑（全部独立执行）

| 套件 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- |
| Node 单元 + 集成 | `$env:NODE_OPTIONS='--test-isolation=none'; npm test` | tests 90 / pass 90 / fail 0，exit 0 | `11-npm-test.txt` |
| 网页 E2E（回归） | `node tests/e2e/run.js` | 18/18 pass，exit 0 | `12-e2e-web.txt` |
| 原生模式模拟（JS 桥/小组件入口） | `node tests/e2e/native-mode.js` | 7/7 pass，exit 0；含“设置页桌面小组件入口可请求添加”“指令后通知小组件刷新”用例 | `13-e2e-native.txt` |
| Android JVM 单测 | `gradle :app:testDebugUnitTest --rerun-tasks --no-daemon` | BUILD SUCCESSFUL，exit 0；WidgetStateParserTest 24/24 + WidgetConfigTest 5/5 = **29/29**，0 fail/0 error/0 skipped | `14-gradle-unit-tests.txt`、`test-results-xml/` |

### 3.8 文档与安全检查

- 文档一致性：README 的 1,722,546 B 与 `5af356…`、`docs/android-build.md` 的产物/大小/SHA/构建命令均与实测一致；README 明示“2×2 需 resize”“未真机验证”；`docs/android-build.md` §9 的 v1.1.0 记录（141 条目、14 资源、29 单测、widget_info 数值）逐项与实测吻合；v1.0.0 记录作为历史保留（其“132 条目”属 v1.0.0，不是 v1.1.0 数据）。
- 无旧 v1.1.0 hash：README + docs 中唯一 64-hex 为 v1.1.0 hash、v1.0.0 hash、release 证书指纹；没有其它残留 v1.1 hash。
- 安全：`android/keystore/`（`.jks` + `keystore.properties`）与 `.android-toolchain/` 均被 `.gitignore` 忽略；`git status --untracked-files=all` 无 keystore/口令/token 路径；231 个可扫描文件（APK 解包 + docs + public + scripts + android src）中无 Bearer token、`token=` 实值、私钥块、真实厂商域名；APK 内只有 UI 示例占位符 `192.168.1.50` 等（与 v1.0.0 相同）；`keystore-password-key` 命中仅文档变量名与构建脚本变量，无口令值。
- 版本兼容性：`v1.1.0` 与 `v1.0.0` 同包名、同签名、versionCode 递增，可直接覆盖升级；v1.0.0 三件套完整保留，可回退。

---

## 4. 问题清单（P0/P1 无；P2 汇总）

### P0 / P1

无。

### P2-1（文档，不阻塞；不在本次写作用域）`docs/android-bridge-contract.md` 两处文档漂移

- `§6.1` 写“状态由 `NativeHttpClient` + Java 版 `DeviceStatusParser` 读取/解析”，实际类名为 `WidgetStateParser`（`android/app/src/main/java/com/powercard/remote/WidgetStateParser.java`，DEX 类 `com.powercard.remote.WidgetStateParser`）。
- `§7 构建` 仍写“产出：`dist/PowerCard-v1.0.0.apk`”，当前交付应为 v1.1.0；`docs/android-build.md` 已更新，此处未同步。
- 复现：对照 `docs/android-bridge-contract.md` 第 135/153 行与实际源码/产物。期望：更新为 `WidgetStateParser` 与 v1.1.0 产物。影响：仅文档准确性，不影响 APK 功能。

### P2-2（文档，不阻塞；不在本次写作用域）`docs/android-build.md` §10 “打开 App/手动刷新恢复”表述不精确

- 原文：`重启后由系统下一次 APPWIDGET_UPDATE（约 30 分钟周期）或打开 App/手动刷新恢复`。
- 实际：打开 App 本身不会触发小组件刷新；触发点只有：App 保存配置（`NativeBridge.saveConfigJson` 成功后）、App 内指令/JS `refreshWidgets()`、小组件手动刷新按钮、系统 `APPWIDGET_UPDATE`（约 30 分钟）、指令成功后 2.5s 延迟刷新。打开 App 仅显示 App 内状态，不会同步桌面小组件。
- 期望：文档改为“打开 App 并保存设置/执行指令后，或手动刷新小组件”；若希望“打开 App 即刷新”，可在 `MainActivity.onResume` 调用 `refreshWidgets()`（产品决策，非本次缺陷）。
- 证据：全仓库 grep `refreshWidgets|requestRefreshAll`，无 `onResume/onCreate` 调用（`23-widget-code-grep.txt`）。

### P2-3（待真机核对的风险，非已确认缺陷）小尺寸/大字体下的布局拥挤与文案截断

- 静态核算：4×2 布局内容高度（17sp 标题 + 12sp 副文案 + 10dp 间距 + 38dp 按钮 + 24dp 内边距）约 109dp，已接近 `widget_info` 的 `minHeight=110dp`；系统字体放大（如 1.15–1.3×）时可能被裁切。
- 2×2：最小 resize 宽度 110dp，三个按钮（10sp）加“开机卡在线 · HH:mm”副文案在窄宽度下会被 `ellipsize="end"` 截断；README 的 2×2 示意图写作“在线 · 15:25”，而实现使用同一完整字符串 `widget_status_online_time`（没有 compact 专用短文案），实际显示可能与示意图不同。
- 影响：仅视觉，无功能/安全影响；**本机无真机/模拟器无法确认**。建议真机核对 4×2/2×2 在默认与大字体下的显示；必要时为 compact 提供短文案或调整字号/高度。
- 证据：`res/layout/widget_powercard_4x2.xml`、`widget_powercard_2x2.xml`、`res/values/strings.xml`、`08-widget-info-values.txt`。

### P2-4（说明缺失，不阻塞）小组件两段式确认不受 App「操作二次确认」开关影响

- 小组件始终要求二次确认（即使 App 设置里关闭了「操作二次确认」）；该行为更保守，但 README/`docs/android-build.md` 未明确说明这一差异。
- 建议：文档补一句“小组件的两段式确认始终开启，不受 App 内开关影响”。
- 证据：`WidgetRefresher.enterConfirm/handleConfirmAsync` 不读取 `confirmActions`；`WidgetConfig` 只读取状态/指令 URL、字段路径与超时。

> 非缺陷附注：Windows 解压 140 文件 vs zip 141 条目，是 `res/zR.png`/`res/zr.png` 大小写差异导致的解压工具现象（Android 侧为两个合法资源，`zipalign` 通过），不是 APK 缺陷，v1.0.0 同样存在。

---

## 5. 未验证项（如实声明，不得表述为“真机通过”）

1. **未执行 Android 真机/模拟器运行验证**（本机无真机，CPU 虚拟化不可用，无法启动模拟器）。因此以下**均未验证**：
   - Launcher 上 RemoteViews 的实际渲染（圆角/字号/间距/深浅色/大字体/多尺寸）；
   - 4×2 ↔ 2×2 拖动 resize 与布局切换；
   - 小组件内两段式点击链路、取消、30 秒 TTL 惰性过期恢复；
   - `AlarmManager` 2.5s 延迟刷新、重启/后台/待机后的系统更新行为；
   - `requestPinAppWidget` 系统“添加到桌面”弹窗与不同启动器兼容性；
   - 小组件真实网络请求/超时/错误态展示、多小组件实例、真实开机卡响应。
2. **Android 单元测试范围有限**：`WidgetStateParserTest`(24) + `WidgetConfigTest`(5) 仅覆盖 Java 解析器与配置/超时 clamp（JVM）；`WidgetRefresher/Renderer/Provider/WidgetStore` 等 Android 运行时逻辑无 instrumentation 测试。
3. **Chromium 原生模式 E2E 只覆盖 JS 侧**：7/7 用注入的 fake `PowerCardNative` 验证桥检测、设置入口、`requestPinWidget` 调用、指令后 `refreshWidgets` 通知、SW 跳过与页面回归；不是 Java/RemoteViews 运行时验证。
4. 未使用真实设备 URL/token 或真实开机卡；所有测试使用 mock/占位符；真实自签名 HTTPS、厂商 ROM、不同 Launcher 差异未覆盖。
5. 包内核对受 Windows 大小写不敏感影响（见附注），已用 zip 条目清单与 `zipalign` 交叉校验。

**不能声明“真机通过”；首次真机安装与小组件运行时行为需用户按 README 步骤人工确认。**

---

## 6. 验收结论

- **v1.1.0 桌面小组件 APK 独立复核：PASS。**
- 签名/版本/Manifest/Widget 声明/4 布局/widget_info/strings/DEX 类与桥方法/14 个 assets 一致性/安全约束全部通过独立复算与代码审查；三套 Node/浏览器测试与 Android JVM 单测（90/90、18/18、7/7、29/29）均可重复通过；README/docs 的 v1.1.0 大小、SHA、命令一致，无旧 v1.1 hash，无 keystore/token/真实设备 URL 泄漏。
- 未发现 P0/P1；4 项 P2 均不阻塞：其中 P2-1/P2-2 是 `docs/android-bridge-contract.md` 与 `docs/android-build.md` 的文档漂移/不精确（不在本任务写作用域，建议 owner 修正），P2-3 是需真机核对的视觉风险，P2-4 是文档说明缺失。
- 建议：接受交付；交付前可顺手修 P2-1/P2-2 文档与 P2-4 说明；P2-3 由用户真机安装后确认（尤其 2×2 与系统大字体场景）。
- 本任务仅新增 `docs/widget-qa-report.md` 与 `qa/widget-verify/**`，**未修改产品代码、README、其它 docs**。

---

## 7. 证据文件（`qa/widget-verify/`）

| 文件 | 内容 |
| --- | --- |
| `00-INDEPENDENT-CHECKLIST.md` | 10 项逐项核对清单 |
| `01-hash-signature.txt` | v1.1.0 SHA-256 / 大小 / apksigner / 证书 / v1.0.0 同证书对照 / debug 信息 |
| `02-badging.txt` | aapt2 badging（版本/权限/应用名/无 debuggable/provides app-widget） |
| `03-manifest-xmltree.txt` | release manifest 完整 xmltree |
| `04-resources.txt` | APK resources 表（4 布局、widget_info、widget strings/drawables/ids） |
| `05-widget-info-xmltree.txt` | 尝试按原文件名 dump（release 已缩短名，失败记录） |
| `06-apk-contents.txt` | 141 条目清单/大小 |
| `07-assets-hash-compare.txt` | assets 14/14 SHA-256 MATCH |
| `08-widget-info-values.txt` | release widget_info 实际属性值（minWidth/minHeight/targetCell/updatePeriod/preview/description） |
| `09-layout-*.txt` | 4 个布局的编译后结构（2x2/2x2_confirm/4x2/4x2_confirm） |
| `10-dex-widgets.txt` | DEX widget 类与方法清单（apkanalyzer） |
| `11-npm-test.txt` | Node 90/90 原始输出 |
| `12-e2e-web.txt` | 网页 E2E 18/18 原始输出 |
| `13-e2e-native.txt` | 原生模式 E2E 7/7 原始输出 |
| `14-gradle-unit-tests.txt` | Gradle 单测 BUILD SUCCESSFUL 原始输出 |
| `test-results-xml/` | Gradle XML：WidgetStateParserTest 24/24、WidgetConfigTest 5/5 |
| `15-widget-info-debug.txt` | debug APK 原文件名 widget_info（文档命令可复现） |
| `16-security-scan.txt` | 231 文件密钥/token/真实 URL 扫描（含分组统计） |
| `17-manifest-widget-receiver.txt` | receiver/actions/meta-data 片段 |
| `18-widget-resources.txt` | widget 资源行摘录（61 行） |
| `19-native-bridge-widget.txt` | native-bridge.js widget 区块（requestPin/refresh 通知） |
| `20-widget-string-values.txt` | APK 内 widget 字符串值（apkanalyzer 实测） |
| `21-docs-claims.txt` | README/docs 的 v1.1.0 大小/SHA/命令/resize/未真机声明摘录 |
| `22-security-git.txt` | gitignore 校验 + 权限 + 未跟踪泄漏扫描 |
| `23-widget-code-grep.txt` | 两段式确认/刷新/超时/GET/清除等代码行号证据 |
| `security-scan.js` | 本次安全扫描脚本（可复跑） |

---

## 8. Lead 收尾修复（2026-10-20）

- **P2-1 已修复**：`docs/android-bridge-contract.md` 中 `DeviceStatusParser` 改为实际的 `WidgetStateParser`，产出路径改为 `dist/PowerCard-v1.1.0.apk`。
- **P2-2 已修复**：`docs/android-build.md` §10 改为“系统下一次 APPWIDGET_UPDATE、手动刷新，或打开 App 并保存配置/执行指令后恢复；仅打开 App 不会主动刷新桌面小组件”。
- **P2-3 已记录**：README 与 `docs/android-build.md` 增加“系统大字体/极窄 2×2 可能拥挤或截断，待真机核对”的视觉风险说明；README 的 2×2 示意图已改为实际完整文案「开机卡在线·15:25」，不再写成 `在线`。
- **P2-4 已补充**：README 与 `docs/android-build.md` 明确“小组件二次确认始终开启，不受 App 内操作二次确认开关影响”；README 的两段式确认描述改为“超过 30 秒失效，下次刷新/点击时恢复”，与实现一致。
- 上述仅文档修改，APK 文件与 SHA-256 不变：`5af3560855f5707ae0718f86daedd1bc69b72eeda71f32ec0dacc39d7fb22599`。
