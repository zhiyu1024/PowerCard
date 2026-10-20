# Security Policy

## 敏感数据

- 开机卡 URL 中可能包含 `token` 查询参数，它等同于设备控制权限。
- 配置在 APK 内使用 Android Keystore AES/GCM 加密保存，`allowBackup=false`；网页版保存在服务端 `data/config.json`（gitignore）。
- 请不要把真实 URL / token 提交到仓库、Issue、截图或公开聊天中。
- 如果 token 泄露，请尽快在开机卡管理端重置/更换。

## 支持范围

- 主要支持最新 release 版本（当前 v1.1.0）。
- v1.0.0 保留为回退版本，安全问题优先在当前版本修复。

## 报告漏洞

请通过 GitHub Security Advisories（仓库 → Security → Report a vulnerability）私下报告，或在 Issue 中只描述问题、不要附带真实 URL/token。建议包含：

- 版本号 / APK SHA-256
- Android 版本与机型（如适用）
- 复现步骤
- 影响范围
- 不包含真实设备凭据的日志

## 已知边界

- 未在真机/模拟器上做运行时验证的版本会在 README 的「已知限制」中明确标注。
- 自签名 HTTPS 证书默认不受信任。
- 本项目默认无登录鉴权；网页版不要直接暴露公网 8787，需配合 VPN 或反向代理认证。
