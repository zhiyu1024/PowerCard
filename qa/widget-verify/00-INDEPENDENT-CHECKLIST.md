# v1.1.0 桌面小组件 · 独立 QA 复核证据

- 复核对象：`dist/PowerCard-v1.1.0.apk`（1,722,546 B / SHA-256 `5af35608…b22599`）
- 复核人：qa-verifier（独立于实现，不采信构建者结论）
- 结论：**PASS**；P0 = 0，P1 = 0，P2 = 4（2 项文档、1 项待真机核对风险、1 项说明缺失，均不阻塞）

## 逐项核对（对应 task-7 的 10 项）

| # | 任务要求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | SHA-256 与 `.sha256` 一致；apksigner v2；证书与 v1.0.0 同一 keystore | PASS | `01-hash-signature.txt`：实测 `5AF356…B22599`（小写与文件一致）、1,722,546 B；v2=true；证书 SHA-256 `624d265b…5f03e8` 与 v1.0.0 完全相同；debug APK 2,248,938 B / `CE19…506B` |
| 2 | badging：versionCode 2 / versionName 1.1.0 / 包名 / minSdk 26 / targetSdk 35 / INTERNET / 应用名 / release 无 debuggable | PASS | `02-badging.txt`：`com.powercard.remote` versionCode 2 versionName 1.1.0、min 26、target/compile 35、INTERNET、`远程电脑控制`、`provides-component:'app-widget'`；`application-debuggable` ABSENT |
| 3 | xmltree：`PowerCardWidgetProvider` receiver exported=false、APPWIDGET_UPDATE intent-filter、`android.appwidget.provider` meta-data、无新增危险权限 | PASS | `03-manifest-xmltree.txt` / `17-manifest-widget-receiver.txt`：receiver `exported=false`、label=`@string/widget_label`、7 个 action（APPWIDGET_UPDATE + 6 个自定义）、meta-data resource `@0x7f0c0000`；权限与 v1.0.0 完全一致（INTERNET、ACCESS_NETWORK_STATE、AndroidX 自定义 permission） |
| 4 | resources：4 个 widget layout、xml/widget_info、widget strings；widget_info 关键属性 | PASS | `04-resources.txt` / `18-widget-resources.txt`：`layout/widget_powercard_{4x2,2x2,4x2_confirm,2x2_confirm}`、`xml/widget_info`、`string/widget_*` 均在；`08-widget-info-values.txt` / `15-widget-info-debug.txt`：minWidth 250dp、minHeight 110dp、minResize 110dp、targetCell 4/2、updatePeriodMillis 1800000、previewLayout=4×2、description 已配；`20-widget-string-values.txt` 验证字符串值（未配置/确认开机？/已发送等） |
| 5 | APK assets/public 14 文件与仓库 `public/` 逐一 SHA-256 MATCH（含 native-bridge widget 区块） | PASS | `07-assets-hash-compare.txt`：14/14 MATCH，含 `native-bridge.js`（widget API 区块已确认）与未变的 `app.js`；`19-native-bridge-widget.txt` |
| 6 | DEX 含 8 个 widget 类 + 桥方法 requestPinWidget/refreshWidgets | PASS | `10-dex-widgets.txt` / 内联 DEX 检查：`PowerCardWidgetProvider`、`WidgetRenderer`、`WidgetRefresher`、`WidgetStateParser`、`WidgetStore`、`WidgetConfig`、`WidgetContract`、`WidgetPin` 均存在；`NativeBridge.requestPinWidget()/refreshWidgets()` 与 `isRequestPinAppWidgetSupported`、7 个 action 字符串均 FOUND |
| 7 | 代码审查：两段式确认/未配置/错误保留/刷新/超时 clamp/只 GET/安全/设置入口/尺寸说明 | PASS（运行时未验证，见报告 §5） | `23-widget-code-grep.txt` + 源码逐行审查：第一次点击 `enterConfirm` 仅 `setPending`+render（无 HTTP）；第二次 `handleConfirmAsync` 读取 30s TTL pending 才 `NativeHttpClient.get`；`onDeleted` 清理并取消延迟刷新；未配置走 `hasStatusUrl()` 分支不请求、不显示 demo/假数据；错误保留上次成功状态与时间；状态 URL 来自 `SecureConfigStore` 加密配置；超时 `[1000,5000]ms`；仅 `NativeHttpClient.get`；receiver exported=false + `FLAG_IMMUTABLE`；无 Log 输出、无 token 展示/落盘；`#widgetSection` 仅原生模式显示（native-bridge.js 解除 hidden）；2×2 需 resize（README 三段说明） |
| 8 | 测试复跑：90/90、18/18、7/7、Gradle 29/29 | PASS | `11-npm-test.txt`（tests 90 / pass 90 / fail 0，exit 0）；`12-e2e-web.txt`（18/18，exit 0）；`13-e2e-native.txt`（7/7，exit 0）；`14-gradle-unit-tests.txt`（BUILD SUCCESSFUL，exit 0）+ `test-results-xml/`：WidgetStateParserTest 24/24、WidgetConfigTest 5/5，failures=0 errors=0 |
| 9 | 文档/安全：v1.1.0 大小/SHA/命令一致；无旧 v1.1 hash；2×2 需 resize、未真机；git 无 keystore/token；APK 无真实 token/厂商 URL | PASS（附 P2-1/P2-2 文档瑕疵） | `21-docs-claims.txt`：README 与 docs/android-build 的 1,722,546 B、`5af356…`、构建/校验命令一致；README 明示 2×2 需 resize、未真机验证；全 README/docs 只有 v1.1.0/v1.0.0/证书 3 个唯一 hash，无旧 v1.1 hash；`22-security-git.txt`：keystore/toolchain 被 gitignore、无口令路径；`16-security-scan.txt`：231 文件扫描，无 Bearer/token=/私钥/厂商域名，APK 内仅 UI 占位符（192.168.x） |
| 10 | 未真机/模拟器，不得写“真机通过” | PASS | README/docs 均写“未验证”；本报告 §5 明确声明，全文无“真机通过” |

## 附注

- 141 个 zip 条目 vs Windows 解压 140 个文件：`res/zR.png` 与 `res/zr.png` 仅大小写不同（Android 区分大小写，为两个合法资源；`zipalign -c 4` 通过），属解压工具现象，非 APK 缺陷。
- `docs/android-bridge-contract.md` 有两处文档漂移（`DeviceStatusParser` 类名、§7 产出仍写 v1.0.0）；`docs/android-build.md` §10 “打开 App/手动刷新恢复”表述不精确（打开 App 本身不会触发小组件刷新）。详见报告 P2。
