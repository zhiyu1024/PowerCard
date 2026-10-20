# 远程电脑控制 · 接口契约 v1

前后端共享的**唯一契约**。任何一方改动字段，必须先改本文件并通知 Lead。

## 1. 运行模型

- 单个 Node.js 进程（>=20，零运行时依赖）同时提供：
  - `public/` 静态前端（PWA）
  - `/api/*` JSON 接口
  - 反向代理：由服务端用 `fetch` 以 **GET** 访问开机卡的 URL，规避浏览器 CORS / mixed-content 限制。
- 默认端口 `8787`，默认监听 `0.0.0.0`（手机需访问），可用 `PORT` / `HOST` 覆盖。
- 配置持久化到 `data/config.json`（不入库）；测试用 `CONFIG_PATH` 覆盖。
- 未配置任何接口 URL 时进入 **演示模式（demo）**：不需要设备也能完整体验 UI；操作会改变内存中的模拟状态，重启服务后恢复。
- 演示模式判定：`statusUrl`、`powerOnUrl`、`powerOffUrl`、`rebootUrl` 四项**全部为空**。

## 2. 配置对象

```json
{
  "statusUrl": "http://192.168.1.50/api/status",
  "powerOnUrl": "http://192.168.1.50/api/power/on",
  "powerOffUrl": "http://192.168.1.50/api/power/off",
  "rebootUrl": "http://192.168.1.50/api/reboot",
  "lanAddress": "192.168.1.50",
  "wanAddress": "https://example.com:8443",
  "subnetMask": "255.255.255.0",
  "gateway": "192.168.1.1",
  "macAddress": "AA:BB:CC:DD:EE:FF",
  "pollIntervalSec": 10,
  "requestTimeoutMs": 5000,
  "confirmActions": true,
  "powerField": "",
  "onlineField": ""
}
```

字段规则：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `statusUrl` / `powerOnUrl` / `powerOffUrl` / `rebootUrl` | string | `""` | 完整 `http://` 或 `https://` URL；空字符串表示未配置。保留查询串。 |
| `lanAddress` / `wanAddress` | string | `""` | 设备资料，仅展示/快速打开；允许 `192.168.1.50` 或带协议、端口。 |
| `subnetMask` / `gateway` | string | `""` | 设备资料，仅展示。 |
| `macAddress` | string | `""` | 设备资料，仅展示；尽量规范成大写冒号格式。 |
| `pollIntervalSec` | number | `10` | 5–300 的整数。 |
| `requestTimeoutMs` | number | `5000` | 1000–30000 的整数。 |
| `confirmActions` | boolean | `true` | 前端是否对关机/重启弹确认框。 |
| `powerField` | string | `""` | 可选，手动指定开机状态字段路径，如 `data.power`；空 = 自动识别。 |
| `onlineField` | string | `""` | 可选，手动指定在线状态字段路径，如 `data.online`；空 = 自动识别。 |

### 校验规则

- URL：`new URL()` 可解析、协议为 `http:`/`https:`、长度 ≤ 2048、不允许 `#` 片段。空字符串合法。
- 地址资料：长度 ≤ 255；不得含空白/换行（前端做轻提示，后端只做基本长度与 trim）。
- MAC：允许空；非空时接受 `AA:BB:CC:DD:EE:FF`、`AA-BB-...`、`aabb.ccdd.eeff`、12 位十六进制。服务端统一成大写冒号格式。
- 非法请求返回 400，`error.fields` 给出字段级中文信息。

## 3. 通用约定

- 所有响应 `Content-Type: application/json; charset=utf-8`，`Cache-Control: no-store`。
- 业务响应统一 200；只有请求本身非法（400/404/405/413）才用非 2xx。
- 时间统一 ISO 8601 UTC 字符串。
- 原始响应最多保留 8192 字符，超出截断并置 `raw.truncated = true`。
- 请求日志为内存环形缓冲 30 条，不落盘。

## 4. 接口

### `GET /api/health`

```json
{ "ok": true, "app": "powercard-remote", "version": "1.0.0", "uptimeSec": 42 }
```

### `GET /api/config`

```json
{ "ok": true, "config": { ... }, "mode": "demo" }
```

`mode`: `"demo" | "live"`。

### `PUT /api/config`

请求体：完整配置对象（缺失字段取默认值，未知字段忽略）。

成功：`{ "ok": true, "config": { ... }, "mode": "live" }`

失败 400：

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION",
    "message": "有 2 项设置需要检查",
    "fields": { "statusUrl": "URL 必须以 http:// 或 https:// 开头", "pollIntervalSec": "轮询间隔需为 5–300 秒" }
  }
}
```

### `GET /api/status`

查询参数：`refresh=1` 时跳过 1.5 秒服务端短缓存。

成功到达设备（即使状态解析不出来）：

```json
{
  "ok": true,
  "mode": "live",
  "online": true,
  "onlineInferred": true,
  "power": "on",
  "powerLabel": "电脑已开机",
  "latencyMs": 38,
  "fetchedAt": "2026-10-20T07:30:00.000Z",
  "sourceUrl": "http://192.168.1.50/api/status",
  "httpStatus": 200,
  "raw": {
    "contentType": "application/json; charset=utf-8",
    "body": "{\"power\":1,\"online\":true}",
    "truncated": false
  },
  "mapping": { "powerField": "power", "onlineField": "online" },
  "warning": null,
  "error": null
}
```

字段语义：

- `online`：开机卡是否在线。状态请求成功且未解析出在线字段时，按“能访问即在线”推断为 `true`，并置 `onlineInferred: true`。
- `power`：`"on" | "off" | "unknown"`。
- `powerLabel`：服务端生成的中文文案：`电脑已开机` / `电脑已关机` / `状态未知`。
- `mapping`：实际命中的字段路径，调试用；未命中为 `null`。
- `warning`：请求成功但无法识别电源状态时的中文提示（例如 `"已连接，但无法识别电源状态；请在调试中指定字段或查看原始响应"`）。

连接/配置失败（HTTP 仍为 200）：

```json
{
  "ok": false,
  "mode": "live",
  "online": false,
  "onlineInferred": false,
  "power": "unknown",
  "powerLabel": "状态未知",
  "latencyMs": 5002,
  "fetchedAt": "2026-10-20T07:30:05.000Z",
  "sourceUrl": "http://192.168.1.50/api/status",
  "httpStatus": null,
  "raw": null,
  "mapping": null,
  "warning": null,
  "error": { "code": "TIMEOUT", "message": "请求超时（5000 ms）" }
}
```

`error.code` 枚举：`CONFIG`（未配置状态 URL）、`INVALID_URL`、`TIMEOUT`、`NETWORK`、`HTTP`（设备返回非 2xx）、`PARSE`（保留）。

演示模式返回：

```json
{
  "ok": true,
  "mode": "demo",
  "online": true,
  "onlineInferred": false,
  "power": "on",
  "powerLabel": "电脑已开机",
  "latencyMs": 0,
  "fetchedAt": "...",
  "sourceUrl": null,
  "httpStatus": null,
  "raw": { "contentType": "application/json", "body": "{\"demo\":true,\"online\":true,\"power\":\"on\"}", "truncated": false },
  "mapping": null,
  "warning": null,
  "error": null
}
```

### `POST /api/command`

请求体：

```json
{ "action": "on" }
```

`action`: `"on" | "off" | "reboot"`，其余 400。

成功：

```json
{
  "ok": true,
  "mode": "live",
  "action": "on",
  "message": "开机指令已发送",
  "latencyMs": 126,
  "httpStatus": 200,
  "sourceUrl": "http://192.168.1.50/api/power/on",
  "raw": { "contentType": "text/plain", "body": "OK", "truncated": false },
  "error": null
}
```

失败（仍 200，`ok:false`）：

```json
{
  "ok": false,
  "mode": "live",
  "action": "on",
  "message": "开机指令发送失败",
  "latencyMs": 5001,
  "httpStatus": null,
  "sourceUrl": "http://192.168.1.50/api/power/on",
  "raw": null,
  "error": { "code": "TIMEOUT", "message": "请求超时（5000 ms）" }
}
```

- 未配置对应 URL：`error.code = "CONFIG"`，`message = "尚未配置开机接口 URL"`。
- 设备返回非 2xx：`error.code = "HTTP"`，`message = "设备返回 HTTP 500"`。
- 演示模式：延迟约 600ms，改变模拟电源状态；`mode:"demo"`，`sourceUrl:null`。
- **只使用 GET** 访问设备，不使用设备返回内容做任何跳转。

### `POST /api/test`

不保存配置，用请求体中的临时配置测试状态接口。请求体：

```json
{ "statusUrl": "http://...", "powerField": "", "onlineField": "", "requestTimeoutMs": 5000 }
```

响应与 `/api/status` 同构，额外字段 `"mode": "test"`。未提供 `statusUrl` 时返回 `error.code = "CONFIG"`。

### `GET /api/logs`

```json
{
  "ok": true,
  "logs": [
    {
      "id": "l_1729400000000_1",
      "at": "2026-10-20T07:30:00.000Z",
      "kind": "status",
      "method": "GET",
      "url": "http://192.168.1.50/api/status",
      "httpStatus": 200,
      "ok": true,
      "latencyMs": 38,
      "error": null,
      "rawPreview": "{\"power\":1,\"online\":true}"
    }
  ]
}
```

`kind`: `"status" | "command" | "test"`。最新的在前。敏感查询串原样保留，仅本地展示。

## 5. 状态解析器（服务端）

输入：HTTP 响应文本、`content-type`、可选 `powerField` / `onlineField`。

1. 手动字段优先：支持点路径与数组下标，如 `data.power`、`items.0.state`。命中后映射值。
2. JSON 自动识别：递归遍历对象（深度 ≤ 5），键名归一化（小写、去掉 `_` `-` 空格）后匹配候选：
   - 电源：`power`, `powerstate`, `powerstatus`, `pcpower`, `pcstatus`, `pcstate`, `computerstatus`, `hoststatus`, `state`, `status`, `switch`, `onoff`, `running`
   - 在线：`online`, `online status`, `cardonline`, `is online`, `connected`, `connect`, `link`, `wifi`, `networkstatus`, `deviceonline`
   - 同一键名命中两类时，优先更具体的语义；`status` 只有在值能明确映射为开关机时才采用。
3. 文本/HTML：去标签、trim 后，若整体（或 `key=value` / `key: value` 行）能明确映射，则采用；包含“在线/离线”可判断在线状态；HTML 页面同时含“开机”“关机”时**不得**猜测电源状态。
4. 值映射：
   - on：`true`, `1`, `"on"`, `"open"`, `"开机"`, `"已开机"`, `"运行"`, `"running"`, `"up"`, `"started"`
   - off：`false`, `0`, `"off"`, `"close"`, `"关机"`, `"已关机"`, `"停止"`, `"stopped"`, `"down"`
   - online：`true`, `1`, `"online"`, `"在线"`, `"connected"`, `"ok"`
   - offline：`false`, `0`, `"offline"`, `"离线"`, `"disconnected"`, `"error"`
   - 无法映射则忽略该字段。
5. 默认值：`power = "unknown"`；在线未解析到时 `online = true`（请求成功）+ `onlineInferred = true`。

## 6. 前端行为约定

- 首屏立即请求 `/api/status`，之后按 `pollIntervalSec` 轮询；`document.hidden` 时暂停，重新可见时立即刷新。
- 请求进行中显示骨架/加载态；失败不弹重复 toast，只在状态区展示可读错误。
- 开机/关机为大按钮；重启/刷新为小按钮。卡片离线或请求进行中禁用操作按钮。
- 开机、关机、重启在 `confirmActions` 为 true 时二次确认。
- 指令成功后 1.5s 触发一次状态刷新，并 toast 成功；失败 toast 显示服务端 message。
- 刷新按钮带旋转动画，且有 `aria-label`。
- 设置抽屉：保存调用 `PUT /api/config`，成功后关闭、立即刷新；测试连接调用 `/api/test`，展示在线/电源/原始响应。
- 顶部调试按钮（右上角，滑杆图标）打开设置抽屉；支持 Esc 关闭、焦点圈定。
- 演示模式：顶部/状态区显示“演示模式”徽标；设置中说明填入状态 URL 后自动切换到真实设备。
