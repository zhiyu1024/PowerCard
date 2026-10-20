# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## v1.1.0 — 2026-10-20

### 新增

- Android 桌面小组件（RemoteViews）：
  - 标准 4×2 布局、紧凑 2×2 布局；
  - 显示电脑开关机状态、开机卡在线/离线、最后更新时间；
  - 开机 / 关机 / 刷新按钮，无重启按钮；
  - 小组件内两段式二次确认：第一次点击进入确认态，第二次确认才发送 GET；
  - 取消或 30 秒失效；每个 appWidgetId 独立 pending 状态。
- App 设置页「桌面小组件」入口，使用 `requestPinAppWidget` 添加。
- `NativeBridge.requestPinWidget()` / `refreshWidgets()` 桥接能力。
- Java 版 `WidgetStateParser`，与 `public/shared/parser.js` 共用测试语义。
- Widget 状态缓存、未配置提示、错误态保留上次成功状态与时间。
- 30 分钟系统周期刷新 + 手动/App 事件刷新 + 指令后延迟刷新。

### 变更

- 版本号升级为 `1.1.0`（versionCode 2），复用 v1.0.0 release keystore。
- 小组件超时 clamp 到 1000–5000ms，避免 goAsync 广播被系统杀。
- 兼容性修正：返回键改为 legacy `onBackPressed`，manifest 关闭 `enableOnBackInvokedCallback`，避免 minSdk 26 直接引用 API 33 类型。

### 验证

- Node 测试 90/90、网页 E2E 18/18、原生模式 E2E 7/7、Android JVM 单测 29/29。
- APK 签名 v2、widget receiver/meta-data/4 布局/widget_info 静态校验通过。
- **未做真机/模拟器运行验证**。

## v1.0.0 — 2026-10-20

### 新增

- 独立 Android APK（Java 原生壳 + WebViewAssetLoader + 原生 HTTP），不依赖 Node/服务器。
- 首页状态、开机/关机/重启/刷新、统一二次确认。
- 加密配置（Android Keystore AES/GCM）、调试/测试/日志、演示模式。
- 可选网页版：Node 零依赖代理 + PWA。

### 验证

- Node 测试 90/90、网页 E2E 18/18、原生模式 E2E 6/6（v1.0.0 阶段）。
