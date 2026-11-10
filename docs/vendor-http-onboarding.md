# deda-server 设备侧 HTTP 接口对接说明（供机芯厂固件配置）

版本：1.0（2026-11-10）。本文档是机芯厂《设备端接口文档》v1.1 的**我方实现回执**：
三个 HTTP 接口已在 deda-server 实现并与公版协议逐项对齐，供固件烧录与联调使用。
协议语义（调用时机、错误码、重试规则）以公版文档为准，本文只写我方实现的具体事实。

## 1. 基础地址（由我方提供，请配置进固件）

| 环境 | 基础地址 | 说明 |
| --- | --- | --- |
| staging（联调） | `http://<staging 域名或 IP>:<端口>` | 联调期为 HTTP；设备直连，无需经过机芯厂云中转 |
| production（量产） | `https://<生产域名>` | HTTPS；证书由我方运维配置，固件侧 TLS 能力待确认 |

- 三条路径原样拼接在基础地址后，无任何额外前缀：
  - `POST /client/user/user/loginMac`
  - `POST /client/bot/bot/start`
  - `POST /client/bot/bot/stop`
- 待确认：基础地址写入固件的方式（烧录 / 可远程下发），以及固件 TLS 能力（是否支持 HTTPS、证书校验方式）。

## 2. 我方实现的具体行为

### 2.1 `POST /client/user/user/loginMac`

请求体与密码算法同公版 3.1 节（macKey 与公版一致，此处不重复印刷）。

我方行为细节：

- MAC 归一化在服务端完成：接受带 `:`/`-` 分隔符与大小写的入参，统一转为十二位小写十六进制；非法形态返回 400。
- 密码校验失败返回 401，且**不会**建档。
- 成功响应（HTTP 200）：
  - 响应头 `Authorization: <三方 LLM API KEY>`——设备必须读取并保存，用于三方 LLM 接入配置的 `llm_token`；该 key 轮换策略由我方管理，设备以最近一次成功响应为准。
  - 响应体：`{"code":200,"data":{"id":"<归一化mac>","nickname":"设备 <mac后6位>","lang":"zh"},"msg":"success"}`。
- 重复上线按同一 MAC 更新登记，不重复建档。
- 服务端未配置 API KEY 时返回 500；设备按公版 6.2 退避重试即可。

联调黄金值（供固件核对密码算法）：

| mac（归一化后） | password |
| --- | --- |
| `aabbccddeeff` | `eec1ea82480a6a30fdf47227af0652b7` |
| `90fe1de7a1ca` | `cf471119880560a0f8715d347bd8fa70` |

### 2.2 `POST /client/bot/bot/start`

- 设备未上线（未成功 loginMac）时返回 401；请先 loginMac 再以**原实例 ID**重试。
- 同设备同实例重复 start：幂等返回 `{"code":200}`，并刷新本轮控制鉴权信息（`authorization`）。
- 同设备新实例：登记为当前实例，旧实例记录不再作为当前实例（不自动停止旧云端实例）。
- 已结束（stop 过）的实例被延迟 start 复活：返回 409。
- 成功响应：`{"code":200}`（无响应体详情，鉴权信息不回显）。

### 2.3 `POST /client/bot/bot/stop`

- 按 `mac` + `instanceid` 精确结束；重复 stop 幂等返回 `{"code":200}`。
- 旧实例的延迟 stop 不会清理该设备的新实例。
- 未知实例或 MAC 不匹配返回 404；设备未上线返回 401。
- stop 处理后我方清除该实例的控制鉴权信息。

### 2.4 通用

- 判定成功：HTTP 200 且响应体 `code` 为 200。
- 错误响应体：`{"code":<HTTP 状态码>,"msg/message":"原因"}`，HTTP 状态与 code 一致。
- 实例登记记录我方保存 24 小时；服务端登记状态丢失时，设备会在 start/stop 收到 401，按公版 6.2 重新 loginMac 后重试即可自恢复。
- MQTT 公共主题 `loginMac` 已取消，设备无需发布/订阅；MQTT 上下行主题与心跳规则不变（见《MQTT交互协议》）。

## 3. 联调 checklist

1. 我方提供 staging 基础地址 → 固件配置。
2. 设备配网连上 WiFi → 调 loginMac → 核对响应头 `Authorization` 已保存。
3. 发起一轮对话 → 确认 start/stop 各返回 `{"code":200}`。
4. 配网窗口内（上线后 120 秒）小程序可看到该设备并完成绑定。
5. 异常路径抽查：错误密码（401）、未上线先 start（401）、stop 未知实例（404）、stop 后再 start 同实例（409）。
