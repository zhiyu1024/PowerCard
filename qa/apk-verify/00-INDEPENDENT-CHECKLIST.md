# 独立复核证据清单（task-5）

独立 QA（qa-verifier）对最终 APK 的复核命令与结果。所有命令均在仓库根目录执行；
原始输出见本目录 `01-*.txt` ~ `16-*.txt`、`dex-check.js`、`security-scan.js`。

- 复核对象：`dist/PowerCard-v1.0.0.apk`（1,697,462 B）
- 复核时间：2026-10-20（Asia/Shanghai）
- 结论：**PASS**；P0 = 0，P1 = 0，P2 = 4（2 项文档/说明类 + 2 项兼容性/契约说明，均不阻塞）

## 逐项核对

| # | 任务要求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1a | SHA-256 与 `.sha256` 文件一致 | PASS | 实测 `CDD4BF7C…C766CE`（小写形式与文件一致）；`01-hash-signature.txt` |
| 1b | apksigner verify 通过（v2） | PASS | `Verifies`；v2=true；v1/v3=false；`01-hash-signature.txt` |
| 1c | 证书 DN / 证书 SHA-256 | PASS | DN `CN=PowerCard Remote, OU=PowerCard, O=PowerCard, L=Local, ST=Local, C=CN`；SHA-256 `624d265b…5f03e8`；RSA 2048；有效期 2026-10-20 → 2054-03-07（约 10000 天）；`01-hash-signature.txt`、`14-keystore-cert.txt` |
| 2 | aapt2 badging：包名/版本/minSdk/targetSdk/INTERNET/应用名/release 无 debuggable | PASS | `com.powercard.remote`、1/1.0.0、min 26、target 35、compile 35、`INTERNET`（另 `ACCESS_NETWORK_STATE`）、`远程电脑控制`、无 `application-debuggable`；`02-badging.txt`、`02-badging-debug.txt` |
| 3 | xmltree：allowBackup=false、usesCleartextTraffic=true、enableOnBackInvokedCallback=false；仅 MainActivity exported | PASS（附注 1） | 三项属性均符合；exported **Activity** 仅 `MainActivity`；另含 AndroidX `ProfileInstallReceiver` exported=true（DUMP 保护，见 P2-2）；`03-manifest-xmltree.txt` |
| 4 | APK 含 classes.dex/manifest/assets 关键文件，且 assets 与 `public/` SHA-256 全 MATCH | PASS | 132 zip 条目；9 个必查路径全部存在；`assets/public` 14 个文件；14/14 MATCH（`05-assets-hash-compare.txt`）；`04-apk-contents.txt` |
| 5 | DEX 含 5 个类与桥字符串 | PASS | 5 个类描述符 FOUND；`PowerCardNative`、`getConfigJson`、`saveConfigJson`、`httpGet`、`window.__powercardHttpResult`、`AES/GCM/NoPadding` 等全部 FOUND；`OnBackInvoked*` ABSENT；`06-dex-classes.txt`、`07-dex-strings.txt` |
| 6 | Java 代码审查（GET/超时/重定向/8192/错误映射/Keystore/WebView 安全/API33） | PASS | 见 `docs/android-qa-report.md` 第 9 节代码审查表；`setRequestMethod("GET")` 唯一；无 Log 调用；`BuildConfig.DEBUG=false`（release）；无 `OnBackInvoked*` 引用 |
| 7 | JS 原生模式：fetch 覆盖、原生检测、回调匹配、SW 跳过、模块顺序 | PASS | `public/native-bridge.js` 覆盖 `/api/` fetch、requestId pending 匹配、超时兜底、`window.__powercardBack`；`app.js` 原生模式跳过 SW；`index.html` 中 `native-bridge.js` 在 `app.js` 之前；`09-js-review.md` |
| 8 | 测试复跑：90/90、18/18、6/6 | PASS | `npm test` → tests 90 / pass 90 / fail 0；`node tests/e2e/run.js` → 18/18；`node tests/e2e/native-mode.js` → 6/6；均 exit 0；`10-npm-test.txt`、`11-e2e-web.txt`、`12-e2e-native.txt` |
| 9 | 文档 hash/大小/命令一致；二次确认描述正确；无旧 hash | PASS（附注 2） | README / android-build / android-qa-report 的 SHA+大小与实测一致；仅 2 个唯一 64-hex（APK hash、证书指纹），无旧 hash；README 三处确认描述正确；README APK 校验命令路径有误（P2-1）；`08-docs-grep.txt` |
| 10 | 安全：无 keystore/口令/token 泄漏；keystore 与 toolchain 被 ignore | PASS | `git check-ignore` 命中 `android/keystore/`、`.android-toolchain/`；git 未跟踪文件列表无 keystore/口令；APK 内无 keystore/jks/密码；203 文件扫描 57 处均为文档/占位符/脚本变量，无 Bearer/token=/私钥/真实厂商域名；`13-security-scan.txt` |
| 11 | 如实说明未真机/模拟器验证 | PASS | 原报告与 README 均写“未执行”；本复核不写“真机通过”；`docs/android-qa-report.md` 第 9 节再次声明 |

## 附注

1. `res/zR.png` 与 `res/zr.png` 为仅大小写不同的两个合法资源（Android 文件系统区分大小写）；Windows 大小写不敏感解压后文件数 131 ≠ zip 条目 132，属解压工具现象，非 APK 缺陷；`zipalign -c 4` 校验通过（`15-zipalign.txt`）。
2. README 第 233–234 行校验命令写 `android-sdk/build-tools/...`，仓库根实际路径为 `.android-toolchain/android-sdk/build-tools/...`（`Test-Path` = False）；`docs/android-build.md` 与 `docs/android-qa-report.md` 中的 `$bt` 路径正确。见 P2-1。
3. DEX 中另确认 `https://appassets.androidplatform.net/assets/public/index.html`、`window.__powercardBack` 等源码字符串，可作为源码→APK 的绑定证据。
