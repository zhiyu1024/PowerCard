# Contributing

## 开发环境

- Node.js 20+
- JDK 17、Gradle 8.9、Android SDK 35（或项目内 `.android-toolchain/`，见 `docs/android-build.md`）
- Windows 构建 APK；网页/测试跨平台

## 常用命令

```powershell
# 网页版
npm install
npm start

# 测试（沙箱禁用子进程时使用 --test-isolation=none）
$env:NODE_OPTIONS='--test-isolation=none'; npm test
npm run test:e2e
npm run test:native

# Android 单测 + APK
cd android
..\.android-toolchain\gradle-8.9\bin\gradle.bat :app:testDebugUnitTest --no-daemon
cd ..
powershell -ExecutionPolicy Bypass -File scripts\build-android.ps1
```

## 提交约定

- 不提交 `data/config.json`、`android/keystore/`、`.android-toolchain/`、`node_modules/`、构建产物中间目录或真实设备 URL/token。
- 改前端静态资源后需同步 bump `public/sw.js` 的 `CACHE_VERSION`，并重跑 Android 构建脚本同步 assets。
- 改 widget 的解析/确认/刷新逻辑后，至少完成：
  - Node 测试 90/90；
  - `tests/e2e/run.js` 18/18；
  - `tests/e2e/native-mode.js` 7/7；
  - Gradle `:app:testDebugUnitTest` 29/29；
  - APK 静态校验（见 `docs/android-build.md`）。
- 说明真实设备限制：未在真机验证的功能不要写成“真机通过”。

## 代码风格

- 前端：原生 HTML/CSS/ES Modules，无框架、无 CDN；遵守服务端 CSP，不写内联脚本/样式。
- 后端：零运行时依赖，ESM，中文错误信息。
- Android：Java 17、RemoteViews，不引入 Compose/Glance/WorkManager。
- 保持 4 空格 Java 缩进、2 空格 JS/CSS 缩进（见 `.editorconfig`）。
