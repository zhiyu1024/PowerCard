# Android 构建与安装说明

本文件说明如何在本机构建「远程电脑控制」的 Android APK（Java 原生壳 + WebViewAssetLoader，
设备 HTTP 请求全部由 Java 原生层发出，APK 不依赖 Node 服务）。桥接接口契约见
`docs/android-bridge-contract.md`。

## 1. 产物

| 文件 | 说明 |
| --- | --- |
| `dist/PowerCard-v1.0.0.apk` | release 签名安装包（交付物） |
| `dist/PowerCard-v1.0.0.apk.sha256` | 上述 APK 的 SHA-256 |
| `dist/PowerCard-v1.0.0-debug.apk` | debug 包，用于快速安装验证 |

包名 `com.powercard.remote`，应用名「远程电脑控制」，versionName `1.0.0`，versionCode `1`，
minSdk 26 / targetSdk 35 / compileSdk 35。

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
# debug + release，并输出 dist/ 与校验结果
powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1

# 只构建 release
powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1 -Target release

# 只构建 debug（跳过 APK 校验，快速迭代）
powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1 -Target debug -SkipChecks
```

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
adb install -r dist\PowerCard-v1.0.0.apk

# 或直接把 APK 传到手机点击安装（需允许“安装未知应用”）
```

- 首次打开即为演示模式（四项接口 URL 全空）。在设置里填写开机卡的局域网地址后保存即可。
- 开机卡接口多为 `http://`，APK 已声明 `usesCleartextTraffic=true`（局域网明文）。
- 应用不需要电脑、Node 服务或外部服务器；所有请求由手机直接发往设备。
- 配置经 Android Keystore AES/GCM 加密写入 SharedPreferences，`allowBackup=false`，不进云备份。

## 6. 校验

构建脚本会自动执行；也可手动：

```powershell
$bt = ".android-toolchain\android-sdk\build-tools\35.0.0"
& "$bt\apksigner.bat" verify --verbose --print-certs dist\PowerCard-v1.0.0.apk
& "$bt\aapt2.exe" dump badging dist\PowerCard-v1.0.0.apk
tar -tf dist\PowerCard-v1.0.0.apk | Select-String "assets/public/(index.html|app.js|shared/parser.js)|classes.dex|AndroidManifest.xml"
Get-FileHash -Algorithm SHA256 dist\PowerCard-v1.0.0.apk
```

## 7. 常见错误

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

## 8. 本机构建验证记录（2026-10-20）

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

## 9. 说明

- 本机未开启 CPU 虚拟化，不启动模拟器/真机自动化；构建与静态校验（apksigner/aapt2/unzip）通过即视为工具链与壳可用。
- 需要较新的 Android System WebView（建议 100+）。`minSdk 26` 只约束 Android 版本；页面使用 ES Modules、`??`、`Element.replaceChildren`、CSS `:where()`，极旧且未更新的 WebView 可能白屏，请在应用商店更新「Android System WebView」。
- WebView 调试仅在 debug 包开启；release 包已关闭。页面只加载 `appassets.androidplatform.net` 内部资源，
  外部 http/https 链接交给系统浏览器，file/content 访问已禁用。
- 图标由 `android/tools/generate-icons.py` 从 `public/icons/icon-512.png` 生成（各 mipmap 密度 +
  round + adaptive/monochrome），不修改 `public/icons/`。

