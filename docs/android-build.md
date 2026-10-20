# Android 构建与安装说明

本文件说明如何在本机构建「远程电脑控制」的 Android APK（Java 原生壳 + WebViewAssetLoader，
设备 HTTP 请求全部由 Java 原生层发出，APK 不依赖 Node 服务）。桥接接口契约见
`docs/android-bridge-contract.md`。

## 1. 产物

| 文件 | 说明 |
| --- | --- |
| `dist/PowerCard-v1.1.0.apk` | **v1.1.0 交付物**：release 签名安装包（含桌面小组件） |
| `dist/PowerCard-v1.1.0.apk.sha256` | 上述 APK 的 SHA-256 |
| `dist/PowerCard-v1.0.0.apk` / `.sha256` | v1.0.0 历史产物（保留，未修改） |

> `-debug.apk` 可由 `scripts\build-android.ps1 -Target debug` 在本地生成，已加入 `.gitignore`，不提交。

包名 `com.powercard.remote`，应用名「远程电脑控制」，versionName `1.1.0`，versionCode `2`，
minSdk 26 / targetSdk 35 / compileSdk 35。v1.1.0 相较 v1.0.0 新增桌面小组件（RemoteViews），
页面/网络/加密架构不变。

## 2. 本机工具链位置

工具链全部在仓库内 `.android-toolchain/`（已被 `.gitignore` 忽略，不提交）：

| 组件 | 位置 | 版本 |
| --- | --- | --- |
| JDK | `.android-toolchain/jdk` | OpenJDK 17.0.2 (java.net GPL) |
| Gradle | `.android-toolchain/gradle-8.9` | 8.9（腾讯镜像） |
| Android SDK | `.android-toolchain/android-sdk` | cmdline-tools 11076708 |
| platforms | `.android-toolchain/android-sdk/platforms/android-35` | Android 35 |
| build-tools | `.android-toolchain/android-sdk/build-tools/35.0.0` | 35.0.0 |
| platform-tools | `.android-toolchain/android-sdk/platform-tools` | adb 等 |
| Gradle 缓存/偏好 | `.android-toolchain/gradle-home`、`.android-toolchain/.android-home` | 避免写 `%USERPROFILE%` |

工具链压缩包保存在 `.android-toolchain/downloads/`（`jdk17.zip`、`gradle-8.9-bin.zip`、
`commandlinetools.zip`、SDK 组件 zip）。重新搭建时：

```powershell
# 1) 解压三件套（tar.exe 可直接解压 zip）
tar -xf .android-toolchain/downloads/jdk17.zip -C .android-toolchain
tar -xf .android-toolchain/downloads/gradle-8.9-bin.zip -C .android-toolchain
# jdk-17.0.2 → jdk，gradle-8.9 → gradle-8.9
# commandlinetools.zip → .android-toolchain/android-sdk/cmdline-tools/latest

# 2) 安装 SDK 组件（本机 sdkmanager 的 Java 网络拉取 manifest 失败时的替代方案）
node .android-toolchain/install-sdk.cjs
# 解压 platform-35_r02.zip → platforms/android-35、build-tools_r35_windows.zip → build-tools/35.0.0、
# platform-tools-latest-windows.zip → platform-tools/
```

## 3. 构建

推荐使用脚本（自动设置 JAVA_HOME / ANDROID_HOME / 同步 public/ / 生成或复用 keystore / 校验）：

```powershell
# 单元测试 + debug + release，并输出 dist/ 与校验结果（默认版本 1.1.0 / versionCode 2）
powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1

# 只构建 release
powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1 -Target release

# 只构建 debug（跳过 APK 校验，快速迭代）
powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1 -Target debug -SkipChecks

# 跳过 Java 单元测试 / 指定其它版本号
powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1 -SkipTests
powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1 -Version 1.1.0 -VersionCode 2
```

脚本会先运行 `:app:testDebugUnitTest`（小组件状态解析器与配置 clamp，29 个用例；结果 XML 在
`android/app/build/test-results/testDebugUnitTest/`），失败即中止。

也可以手动执行 Gradle（先在当前会话设置环境变量）：

```powershell
$tc = (Resolve-Path .android-toolchain).Path
$env:JAVA_HOME = "$tc\jdk"
$env:ANDROID_HOME = "$tc\android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:GRADLE_USER_HOME = "$tc\gradle-home"
# 用户目录不可写时把 AGP 偏好目录/debug keystore 重定向到这里（只需设置 ANDROID_USER_HOME，
# 不要同时设置 ANDROID_PREFS_ROOT，否则 AGP 会报 “different paths to the Android Preferences folder”）
$env:ANDROID_USER_HOME = "$tc\.android-home"

cd android
..\.android-toolchain\gradle-8.9\bin\gradle.bat :app:testDebugUnitTest --no-daemon --console=plain
..\.android-toolchain\gradle-8.9\bin\gradle.bat :app:assembleDebug --no-daemon --console=plain
..\.android-toolchain\gradle-8.9\bin\gradle.bat :app:assembleRelease --no-daemon --console=plain
```

构建前 Gradle 任务 `syncPublicAssets` 会把仓库根 `public/` 全量同步到
`android/app/src/main/assets/public/`（含 `shared/parser.js`），该副本已被
`android/.gitignore` 忽略，`clean` 时删除。APK 内页面地址为
`https://appassets.androidplatform.net/assets/public/index.html`。

## 4. 签名

- release keystore：`android/keystore/powercard-release.jks`（PKCS12，RSA 2048，有效期 10000 天）。
- 口令文件：`android/keystore/keystore.properties`（`storeFile`/`storePassword`/`keyAlias`/`keyPassword`）。
- 二者均在 `android/.gitignore` 中忽略，**不会进入 git**，文档与构建日志中也不打印口令。
- 首次构建 release 时脚本自动生成随机口令；如需固定口令，可在构建前设置环境变量
  `POWERCARD_STORE_PASSWORD`、`POWERCARD_KEY_PASSWORD`。
- 升级已安装的 App 必须使用同一 keystore，请备份 `android/keystore/`。丢失后只能卸载重装。

## 5. 安装

```powershell
# 手机开启“USB 调试”并连接后：
adb install -r dist\PowerCard-v1.1.0.apk

# 或直接把 APK 传到手机点击安装（需允许“安装未知应用”）
```

- 首次打开即为演示模式（四项接口 URL 全空）。在设置里填写开机卡的局域网地址后保存即可。
- 开机卡接口多为 `http://`，APK 已声明 `usesCleartextTraffic=true`（局域网明文）。
- 应用不需要电脑、Node 服务或外部服务器；所有请求由手机直接发往设备。
- 配置经 Android Keystore AES/GCM 加密写入 SharedPreferences，`allowBackup=false`，不进云备份。
- 桌面小组件：打开 App → 设置 → 「桌面小组件」→「添加到桌面」（Android 8+ `requestPinAppWidget`）；
  也可长按桌面空白处从小组件列表添加「电脑开关机」。默认 4×2，长按拖动边缘可缩到 2×2（自动切换紧凑布局）。
- v1.1.0 与 v1.0.0 使用同一 release keystore，可直接覆盖升级；卸载会丢失加密配置。

## 6. 桌面小组件（v1.1.0）

RemoteViews 实现，不引入 WorkManager / Compose / Glance；无新增危险权限，不申请 `RECEIVE_BOOT_COMPLETED`。

### 6.1 结构（`android/app/src/main/`）

| 文件 | 说明 |
| --- | --- |
| `java/com/powercard/remote/PowerCardWidgetProvider.java` | AppWidgetProvider：onUpdate / onReceive / onAppWidgetOptionsChanged / onDeleted |
| `java/com/powercard/remote/WidgetContract.java` | 广播 action、PendingIntent 槽位、30s TTL、2.5s 延迟刷新、5s 超时上限、布局宽度阈值 |
| `java/com/powercard/remote/WidgetStore.java` | SharedPreferences：最近成功状态/失败时间、按 appWidgetId 的 pending 与“已发送”提示 |
| `java/com/powercard/remote/WidgetConfig.java` | 从 `SecureConfigStore` 解密 JSON，读取 statusUrl / powerOnUrl / powerOffUrl / powerField / onlineField / requestTimeoutMs |
| `java/com/powercard/remote/WidgetRefresher.java` | goAsync 后台刷新、指令执行、延迟刷新闹钟、并发去重 |
| `java/com/powercard/remote/WidgetRenderer.java` | 4×2 / 2×2 普通态与确认态 RemoteViews 渲染 |
| `java/com/powercard/remote/WidgetStateParser.java` | Java 版状态解析器，行为对齐 `public/shared/parser.js` |
| `java/com/powercard/remote/WidgetPin.java` | requestPinAppWidget 系统“添加到桌面”弹窗 |
| `res/layout/widget_powercard_{4x2,2x2}{,_confirm}.xml` | 两套尺寸 × 普通/确认态，共 4 个布局 |
| `res/xml/widget_info.xml` | AppWidgetProviderInfo（尺寸/更新周期/预览/描述） |
| `res/drawable/widget_bg.xml`、`widget_btn_{green,red,neutral}.xml` | 暖白圆角背景与绿/红/中性按钮 |
| `src/test/java/.../WidgetStateParserTest.java`、`WidgetConfigTest.java` | 29 个 Java 单元测试（样本对齐 JS parser 测试） |

### 6.2 显示与状态

- 主文案：`电脑已开机` / `电脑已关机` / `状态未知`；副文案：`开机卡在线 · HH:mm`、`开机卡离线 · HH:mm`
  （HH:mm 为最后一次成功刷新时间）。
- 未配置 `statusUrl`：显示“未配置 · 打开 App 设置”，点击打开 App；不显示演示假数据、不显示操作按钮。
- 刷新失败：保留上次成功状态与时间，并显示“连接失败 · 上次 HH:mm”；从未成功则“状态未知 · 连接失败 · 原因”。
- 请求成功但解析不出电源状态：`状态未知` + 开机卡在线（warning 规则与 `parser.js` 一致，不猜测）。

### 6.3 两段式确认（每个 appWidgetId 独立）

1. 第一次点开机/关机：仅把该实例切到确认态（“确认开机？”/“确认关机？” + [取消][确认]），
   在 SharedPreferences 记录 pending 动作与 30 秒过期时间，**不发任何请求**。
2. 第二次点确认：读取该实例 pending，发 `GET powerOnUrl/powerOffUrl`；成功显示“已发送，正在刷新…”，
   并安排 2.5 秒后的非精确延迟刷新；失败显示“发送失败 · 点击刷新重试”。
3. 点取消恢复；超过 30 秒在下一次渲染/点击时惰性清除并恢复普通态；`onDeleted` 清理该实例全部数据。
4. 小组件二次确认**始终开启**，不读取 App 内的 `confirmActions` 开关；这是为了桌面误触安全，属于有意的产品差异。

### 6.4 刷新策略

- `onUpdate` 立即刷新；手动刷新按钮；App 保存配置（`NativeBridge.saveConfigJson` 成功后自动）与
  JS 调 `refreshWidgets()` 触发全量刷新。
- `updatePeriodMillis=1800000`（约 30 分钟，系统允许的最小值）；指令成功后 2.5 秒延迟刷新。
- goAsync + 单线程后台执行器，不阻塞主线程；同一时刻只允许一次状态刷新、每个实例一条指令在途（并发去重）。
- 小组件网络超时 clamp 到 `[1000, 5000] ms`：广播（goAsync）执行窗口约 10s，即使配置里
  `requestTimeoutMs` 为 30s 也不会把小组件刷新拖到被系统杀。

### 6.5 尺寸与外观

- `widget_info.xml`：`minWidth=250dp`、`minHeight=110dp`（默认 4×2），`targetCellWidth/Height=4/2`，
  `minResizeWidth/Height=110dp`，`resizeMode=horizontal|vertical`，`updatePeriodMillis=1800000`，
  `initialLayout=previewLayout=4×2 普通布局`，`description` 已配置。
- 运行时按 `AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH` 选择：`< 200dp` 用紧凑 2×2，否则 4×2；
  两种尺寸的确认态各有一套布局（不用 RemoteViews 动态加控件）。
- 暖白圆角（`#f6f4ef`、22dp）、绿色 `#129c52` 开机、红色 `#cf4b3a` 关机、暖白刷新按钮，与 App 设计令牌一致。
- Android 12+ 使用 `previewLayout`；旧版本未提供 `previewImage`（可选）。
- 视觉风险（待真机核对）：4×2 在 `minHeight=110dp` 下内容高度余量较小，系统大字体可能拥挤；2×2 的三个按钮与完整状态文案在极窄宽度下可能被 `ellipsize` 截断。建议真机查看，必要时再调字号/文案。

### 6.6 Bridge（App 内“添加到桌面”）

- `window.PowerCardNative.requestPinWidget(): boolean`：JS bridge 线程调用；先 `isRequestPinAppWidgetSupported()`，
  `requestPinAppWidget()` 在 UI 线程执行，返回是否发起（设备/启动器不支持时 false）。
- `window.PowerCardNative.refreshWidgets(): void`：显式广播给 provider 触发全量刷新；`saveConfigJson` 成功会自动调用。

## 7. 校验

构建脚本会自动执行；也可手动：

```powershell
$bt = ".android-toolchain\android-sdk\build-tools\35.0.0"
& "$bt\apksigner.bat" verify --verbose --print-certs dist\PowerCard-v1.1.0.apk
& "$bt\aapt2.exe" dump badging dist\PowerCard-v1.1.0.apk
# 小组件：receiver / meta-data / 两套布局 / widget_info
& "$bt\aapt2.exe" dump xmltree --file AndroidManifest.xml dist\PowerCard-v1.1.0.apk |
  Select-String "PowerCardWidgetProvider|appwidget.provider|APPWIDGET_UPDATE|allowBackup|usesCleartextTraffic"
& "$bt\aapt2.exe" dump resources dist\PowerCard-v1.1.0.apk |
  Select-String "widget_powercard_(4x2|2x2)|widget_info|widget_unconfigured"
& "$bt\aapt2.exe" dump xmltree --file res/xml/widget_info.xml dist\PowerCard-v1.1.0-debug.apk |
  Select-String "minWidth|minHeight|targetCell|minResize|resizeMode|updatePeriodMillis|previewLayout|description"
tar -tf dist\PowerCard-v1.1.0.apk | Select-String "assets/public/(index.html|app.js|shared/parser.js)|classes.dex|AndroidManifest.xml"
Get-FileHash -Algorithm SHA256 dist\PowerCard-v1.1.0.apk
```

## 8. 常见错误

| 现象 | 原因 / 解决 |
| --- | --- |
| `AccessDeniedException: C:\Users\<用户>\.android` | 用户目录不可写（受限环境）。脚本已设置 `ANDROID_USER_HOME` 到 `.android-toolchain/.android-home`（不要同时设置 `ANDROID_PREFS_ROOT`，否则 AGP 报 “different paths to the Android Preferences folder”）。 |
| `AccessDeniedException: ...\Temp\tempdir_xxx`（mergeJavaResource 等） | 系统 `%TEMP%` 不可写。脚本已把 `TEMP`/`TMP` 重定向到 `.android-toolchain/tmp`。 |
| `Could not initialize native services / native-platform.dll` | 未设置 `GRADLE_USER_HOME` 或无法写用户目录。设置到 `.android-toolchain/gradle-home`。 |
| `sdkmanager` 报 `IO exception while downloading manifest` / `Failed to download any source lists` | 本机 Java 访问 Google 仓库受限（Node fetch 正常）。用 `.android-toolchain/install-sdk.cjs` 直接下载官方 zip，并把 licenses 写入 `.android-toolchain/android-sdk/licenses/`。 |
| Gradle 下载依赖失败 | 首次构建需访问 `dl.google.com/dl/android/maven2`（google()）与 `repo.maven.apache.org`；确认网络/代理。 |
| `Installed Build Tools revision 35.0.0 is corrupted` | build-tools 目录结构不对；应为 `android-sdk/build-tools/35.0.0/`（含 `apksigner.bat`、`aapt2.exe`）。 |
| `SDK location not found` | 未设置 `ANDROID_HOME` / `ANDROID_SDK_ROOT`。 |
| `Unsupported class file major version` / Java 版本错误 | 必须使用 `.android-toolchain/jdk`（JDK 17），Gradle 8.9 + AGP 8.7.3 不支持更高/更低 JDK。 |
| release APK 未签名 | 缺少 `android/keystore/keystore.properties`；重新执行 `scripts\build-android.ps1 -Target release` 生成。 |
| 页面上设备请求失败（`NETWORK`/`TIMEOUT`/`HTTP`） | 检查手机与设备是否同一局域网、URL 是否可达、超时是否过小（1000–30000ms）。错误会以 toast 和原始响应展示。 |
| `INVALID_URL` | 设备 URL 必须是 `http://` 或 `https://` 完整地址。 |

## 9. 本机构建验证记录（2026-10-20）

- 构建命令：`powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1`
  （Gradle 8.9 / AGP 8.7.3 / JDK 17.0.2 / SDK 35 / build-tools 35.0.0；`assembleDebug` 与 `assembleRelease` 均 BUILD SUCCESSFUL）
- 产物：
  - `dist/PowerCard-v1.0.0.apk`（1,697,462 字节）
    SHA-256 `cdd4bf7c0f06f9f265ec8207f6a4a0a11f8b0646ca0b743609d592ae13c766ce`
  - `dist/PowerCard-v1.0.0.apk.sha256`（内容与上面一致）
  - `dist/PowerCard-v1.0.0-debug.apk`（2,185,012 字节，仅用于快速安装验证，非交付物）
- `apksigner verify --verbose --print-certs dist/PowerCard-v1.0.0.apk`：
  `Verifies`；APK Signature Scheme v2: true；Signer #1 `CN=PowerCard Remote, OU=PowerCard, O=PowerCard, L=Local, ST=Local, C=CN`；
  证书 SHA-256 `624d265b000a279d721896c691853b00fd77fc1cb25bd252c64dd5822c5f03e8`；RSA 2048。
- `aapt2 dump badging`：`package: name='com.powercard.remote' versionCode='1' versionName='1.0.0'`，
  `minSdkVersion:'26'`，`targetSdkVersion:'35'`，`uses-permission: android.permission.INTERNET`（另含 ACCESS_NETWORK_STATE），
  `application-label:'远程电脑控制'`；release 包无 `application-debuggable`。
- Manifest（`aapt2 dump xmltree`）：`allowBackup=false`、`usesCleartextTraffic=true`、`enableOnBackInvokedCallback=false`，
  exported **Activity** 仅 `com.powercard.remote.MainActivity`（launcher）。合并清单另含 AndroidX
  `profileinstaller` 的 `ProfileInstallReceiver`（exported=true，受系统 `DUMP` 权限保护，普通应用无法触发，非安全漏洞）。
  > 兼容性修正：为避免 minSdk 26 的类直接引用 API 33 的 `OnBackInvoked*` 类型，返回键改用 legacy `onBackPressed`
  > 并在 manifest 关闭 `enableOnBackInvokedCallback`；所有 Android 版本行为一致。
- APK 内容：`classes.dex`、`AndroidManifest.xml`、`resources.arsc`，
  `assets/public/{index.html,app.js,styles.css,native-bridge.js,shared/native-api.js,shared/parser.js,manifest.webmanifest,sw.js,favicon.svg,icons/*}`，
  共 132 个条目；APK 内 14 个前端资源与仓库 `public/` 当前文件逐一 SHA-256 相同。
- 图标：`application-icon` 解析为自适应图标（`res/BW.xml`，adaptive-icon：品牌绿背景 + 白色显示器前景，来自 `public/icons/icon-512.png`）；未使用 `<monochrome>`，避免 minSdk 26 旧系统解析异常。
- 未执行：模拟器/真机安装与 WebView 运行时交互（本机 CPU 虚拟化未开启）；本记录为构建与静态校验结论。

### v1.1.0（桌面小组件）构建与校验记录

- 构建命令：`powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1`（默认 `-Version 1.1.0 -VersionCode 2`）；
  `:app:testDebugUnitTest`、`assembleDebug`、`assembleRelease` 均 BUILD SUCCESSFUL（release 的 lintVitalRelease 通过）。
- Java 单元测试：**29 个全过**（`WidgetStateParserTest` 24 + `WidgetConfigTest` 5），0 失败 0 错误。
  覆盖 JSON 自动识别/嵌套/手动字段（含数组下标）/深度上限 5/泛化键/API 信封 status:0/纯文本 key=value/
  整体词元/HTML 同时出现开机+关机不猜测/“开机卡在线”不误判/离线/在线推断/显式 false/值映射/键名归一化/
  字段路径/电源文案/超时 clamp 与 URL 校验。
- 产物：
  - `dist/PowerCard-v1.1.0.apk`（1,722,546 字节）
    SHA-256 `5af3560855f5707ae0718f86daedd1bc69b72eeda71f32ec0dacc39d7fb22599`
  - `dist/PowerCard-v1.1.0.apk.sha256`（内容与上面一致）
  - `dist/PowerCard-v1.1.0-debug.apk`（2,248,938 字节，仅安装验证，非交付物）
  - v1.0.0 三个文件保留且 SHA-256 未变（`cdd4bf7c0f06f9f265ec8207f6a4a0a11f8b0646ca0b743609d592ae13c766ce`）
- `apksigner verify --verbose --print-certs dist/PowerCard-v1.1.0.apk`：`Verifies`；APK Signature Scheme v2: true；
  Signer #1 `CN=PowerCard Remote, OU=PowerCard, O=PowerCard, L=Local, ST=Local, C=CN`；
  证书 SHA-256 `624d265b000a279d721896c691853b00fd77fc1cb25bd252c64dd5822c5f03e8`（与 v1.0.0 同一 keystore）。
- `aapt2 dump badging`：`package: name='com.powercard.remote' versionCode='2' versionName='1.1.0'`，
  `minSdkVersion:'26'`、`targetSdkVersion:'35'`、`uses-permission: android.permission.INTERNET`（另含 ACCESS_NETWORK_STATE），
  `application-label:'远程电脑控制'`；release 无 `application-debuggable`；**未新增权限**（无 `RECEIVE_BOOT_COMPLETED`）。
- Manifest（`aapt2 dump xmltree`）：小组件 receiver `com.powercard.remote.PowerCardWidgetProvider`、`exported=false`、
  `android.appwidget.provider` meta-data、`android.appwidget.action.APPWIDGET_UPDATE` 与自定义 action intent-filter；
  `allowBackup=false`、`usesCleartextTraffic=true`、`enableOnBackInvokedCallback=false` 保持不变。
- `widget_info.xml`（aapt2 xmltree，debug 包保留原文件名）：minWidth 250dp、minHeight 110dp、
  minResizeWidth/Height 110dp、targetCellWidth/Height=4/2、resizeMode=horizontal|vertical（0x3）、
  updatePeriodMillis=1800000、initialLayout=previewLayout=4×2 普通布局、description 有值。
- 小组件资源（`aapt2 dump resources`）：`layout/widget_powercard_4x2`、`layout/widget_powercard_2x2`、
  `layout/widget_powercard_4x2_confirm`、`layout/widget_powercard_2x2_confirm`、`xml/widget_info`、
  `string/widget_label`、`string/widget_unconfigured_full` 均存在。
- APK 内容：141 个条目；`assets/public` 14 个文件与仓库 `public/` 当前文件逐一 SHA-256 相同
  （含新版 `native-bridge.js` 的 widget 区块、`shared/native-api.js`、`shared/parser.js`、最新 `app.js`）。
- DEX 字符串校验：`PowerCardWidgetProvider`、`WidgetStateParser`、`WidgetRefresher`、`WidgetRenderer`、
  `WidgetStore`、`WidgetConfig`、`WidgetPin`、`requestPinWidget`、`refreshWidgets`、四个布局资源名、
  widget action 字符串、`isRequestPinAppWidgetSupported` 均存在。
- **未执行：真机/模拟器验证。** 本机未开启 CPU 虚拟化，未安装到任何设备。因此以下行为仅为静态检查/单测结论，
  未在真实 Launcher/AppWidget 环境验证：小组件实际渲染（圆角/字号/间距）、4×2↔2×2 尺寸切换、
  两段式确认点击链路与 30 秒过期恢复、AlarmManager 延迟刷新、`requestPinAppWidget` 系统固定弹窗、
  小组件真实网络请求与错误态展示。**不能声明“真机通过”。**

## 10. 说明

- 本机未开启 CPU 虚拟化，不启动模拟器/真机自动化；构建与静态校验（apksigner/aapt2/unzip）通过即视为工具链与壳可用。
- 桌面小组件使用 RemoteViews，不依赖 WorkManager/Compose/Glance；未申请 `RECEIVE_BOOT_COMPLETED`，
  重启后由系统下一次 `APPWIDGET_UPDATE`（约 30 分钟周期）、手动刷新小组件，或打开 App 并保存配置/执行指令后恢复，不保证重启后立即刷新；仅打开 App 不会主动刷新桌面小组件。
- 小组件默认 4×2；2×2 通过长按拖动调整尺寸触发（单 provider 响应式），不提供独立尺寸选择入口。
  小组件侧网络超时上限 5s（goAsync 广播窗口约 10s），与 App 内 30s 上限不同。
- 需要较新的 Android System WebView（建议 100+）。`minSdk 26` 只约束 Android 版本；页面使用 ES Modules、`??`、`Element.replaceChildren`、CSS `:where()`，极旧且未更新的 WebView 可能白屏，请在应用商店更新「Android System WebView」。
- WebView 调试仅在 debug 包开启；release 包已关闭。页面只加载 `appassets.androidplatform.net` 内部资源，
  外部 http/https 链接交给系统浏览器，file/content 访问已禁用。
- 图标由 `android/tools/generate-icons.py` 从 `public/icons/icon-512.png` 生成（各 mipmap 密度 +
  round + adaptive/monochrome），不修改 `public/icons/`。

