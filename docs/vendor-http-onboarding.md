# deda-server 设备侧 HTTP 接口对接说明（供机芯厂固件配置）

版本：1.4（2026-11-18）。本文档是机芯厂《设备端接口文档》v1.4 的**我方实现回执**：
四个 HTTP 接口已在 deda-server 实现并与公版协议逐项对齐，供固件烧录与联调使用。
协议语义（调用时机、错误码、重试规则）以公版文档为准，本文只写我方实现的具体事实。

1.4 变更（对齐公版 v1.4，2026-11-18）：

- 新增 `POST /client/bot/bot/getvalue`（§2.2）：固件每轮创建百度实例前拉取本轮 TTS 配置 `{vcn, vol, spd}`，我方额外附带 `lang`。
- `loginMac` 响应体删除 `lang`（§2.1）：上线接口只作登录用，语种参数移到 getvalue 响应体。
- 上述两处**已实现并可联调**；`CHARACTER_TIMBRE_JSON` 尚未填入真实 timbreId（见 §2.2 的「上线前必须由我方填好的配置」），在填好之前 getvalue 会返回 500。

1.2 变更（保留供追溯）：`bot/start` 的音色追平改为不阻塞响应（§2.3）。

## 1. 基础地址（由我方提供，请配置进固件）

| 环境               | 基础地址                    | 说明                                             |
| ------------------ | --------------------------- | ------------------------------------------------ |
| staging（联调）    | `http://8.133.236.127:3001` | 联调期为 HTTP；设备直连，无需经过机芯厂云中转    |
| production（量产） | `https://<生产域名>`        | HTTPS；证书由我方运维配置，固件侧 TLS 能力待确认 |

- 四条路径原样拼接在基础地址后，无任何额外前缀：
  - `POST /client/user/user/loginMac`
  - `POST /client/bot/bot/getvalue`
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
  - 响应体：`{"code":200,"data":{"id":"<归一化mac>","nickname":"设备 <mac后6位>"},"msg":"success"}`。
    **v1.4 起不再返回 `lang`**；请固件不要继续读取该字段。
- `id` 与 `nickname` 需要在 getvalue 请求里**原值回传**（§2.2）。`id` 就是归一化 MAC，但请固件把它当不透明串处理、不要自行用 MAC 拼造。
- 重复上线按同一 MAC 更新登记，不重复建档。
- 服务端未配置 API KEY 时返回 500；设备按公版 7.2 退避重试即可。

联调黄金值（供固件核对密码算法）：

| mac（归一化后） | password                           |
| --------------- | ---------------------------------- |
| `aabbccddeeff`  | `eec1ea82480a6a30fdf47227af0652b7` |
| `90fe1de7a1ca`  | `cf471119880560a0f8715d347bd8fa70` |

### 2.2 `POST /client/bot/bot/getvalue`

调用时机同公版 §4.1：每轮创建百度智能体实例之前，**每轮都调**，我方不做缓存也不期望固件缓存。
请求头只需 `Content-Type: application/json; charset=utf-8`，**不带 Authorization**（不使用三方 LLM API KEY）。

请求体：`{"id":"<loginMac 返回的 data.id 原值>","nickname":"<loginMac 返回的 data.nickname 原值>"}`

- `id` 非法（不是十二位十六进制 MAC 形态，允许带 `:`/`-` 与大小写）→ 400。
- `id` 对应设备从未成功 loginMac → 401；请先 loginMac 再重新调本接口。
- 缺少 `id` 或 `nickname` 字段、或携带未声明字段 → 400（我方对请求体做白名单校验）。
- `nickname` 与我方派生值不一致**不会**被拒绝，只在我方日志留一条 warn；它是纯展示字段，不参与定位设备。

成功响应（HTTP 200）：

```json
{"code":200,"data":{"vcn":"<timbreId>","vol":1,"spd":1,"lang":"zh"},"msg":"success"}
```

- `vcn`：取自平台配置 `CHARACTER_TIMBRE_JSON`（IP/角色 → timbreId），按该设备绑定的 IP 查表。**我方不返回兜底音色**：查不到就 500，因为一个错的音色不会被任何人察觉。
- `vol`：TTS 合成音量倍数，来自全局配置 `TTS_DEFAULT_VOL`（默认 `1.0`，取值范围 0.5–2.0）。当前**不做每设备可调**。与 MQTT 的本地 volume（0–100）互不影响。
- `spd`：语速倍数。设备有语速档位设置时按 `SPEECH_RATE_MAP_JSON` 映射；无设置或映射缺失时回落公版 §4.2 的基础语速 `1.0`。
- `lang`：**我方在公版三字段之外追加的扩展字段**，当前恒为 `zh`。依据是罗浩 2026-11-18「固件对 data 中未知参数是忽略态度」，追加它对现有固件无影响。
  待确认（Q22）：固件是否会解析并使用它；多语种时 `bilingual` 该如何映射百度 `lang`。在答复前我方不做任何猜测性映射。

失败响应：500 表示我方配置不全（音色表或音量配置缺失/越界）。按公版 §4.3，此时固件应停止本轮创建、不发 start 也不发 stop；**我方不会**因为 getvalue 失败而清理设备登记，设备也无需重新 loginMac，用户再次发起时重新调本接口即可。

**上线前必须由我方填好的配置**（否则每轮对话都会失败）：

| 配置 | 缺失后果 | 状态 |
| --- | --- | --- |
| `CHARACTER_TIMBRE_JSON` | `vcn` 无法解析 → 500 | **待填**（timbreId 待机芯公司/百度控制台提供，Q1） |
| `TTS_DEFAULT_VOL` | `vol` 越界 → 500 | 有默认值 `1.0`，无需显式配置 |
| `SPEECH_RATE_MAP_JSON` | `spd` 回落 `1.0` | 不会导致失败，但语速设置会失效 |

### 2.3 `POST /client/bot/bot/start`

请求体 v1.2 起必须同时携带两份用途不同的 BCE 签名：

- `authorization_Role`：用于切换角色、人设或音色（PUT `/api/v1/aiagent/instances/operation?switchSceneRole=`）；
- `authorization_TTS`：用于 interrupt 打断播报（POST `/api/v1/aiagent/interrupt`）。

v1.1 的单 `authorization` 字段仍作为**可选字段**被接受，兼容尚未升级的老固件；
v1.2 固件应发送上述两个必填字段，不再发送单 `authorization`。

- 设备未上线（未成功 loginMac）时返回 401；请先 loginMac 再以**原实例 ID**重试。
- 同设备同实例重复 start：幂等返回 `{"code":200}`，并刷新 authorization_Role 与 authorization_TTS（及各自的签名时间）。
- 同设备新实例：登记为当前实例，旧实例记录不再作为当前实例（不自动停止旧云端实例）。
- 已结束（stop 过）的实例被延迟 start 复活：返回 409。
- 成功响应：`{"code":200}`（无响应体详情，任一签名均不回显）。
- 缺少 authorization_Role 或 authorization_TTS 时返回 400；设备不可省略任一个。
- **响应延迟**：本接口登记完成后会异步追平音色/语速（可能出站调用百度云，最长 5 秒），但**不阻塞响应**——200 会在登记落库后立即返回，设备无需为此放宽超时。追平结果不回显在响应体里。
- `lang` 缺省按 `zh` 处理（罗浩 2026-11-17 确认固件上报值就是 `zh`）；我方用它过滤音色目录，跨语种切换百度不支持。v1.4 §5.1 保留了 start 的 `lang`，与 getvalue 响应体里的 `lang` 是同一个语种口径。

### 2.4 `POST /client/bot/bot/stop`

- 按 `mac` + `instanceid` 精确结束；重复 stop 幂等返回 `{"code":200}`。
- 旧实例的延迟 stop 不会清理该设备的新实例。
- 未知实例或 MAC 不匹配返回 404；设备未上线返回 401。
- stop 处理后我方清除该实例的 authorization_Role、authorization_TTS 及 v1.1 兼容的 authorization。

### 2.5 通用

- 判定成功：HTTP 200 且响应体 `code` 为 200。
- 错误响应体：`{"code":<HTTP 状态码>,"msg/message":"原因"}`，HTTP 状态与 code 一致。
- 实例登记记录我方保存 24 小时；服务端登记状态丢失时，设备会在 start/stop 收到 401，按公版 7.2 重新 loginMac 后重试即可自恢复。
- MQTT 公共主题 `loginMac` 已取消，设备无需发布/订阅；MQTT 上下行主题与心跳规则不变（见《MQTT交互协议》）。
- 公版 v1.5 §4.2 的「设备状态上报中每 600 秒带一组新签名」**我方服务端尚未实现**（当前只在 start 时收一次签名）；在实现前，超过 1800 秒的长对话里我方无法再对实例做音色切换/打断。不影响 getvalue 与 start/stop。

## 3. 联调 checklist

1. staging 基础地址已提供（`http://8.133.236.127:3001`）→ 固件配置。
2. 设备配网连上 WiFi → 调 loginMac → 核对响应头 `Authorization` 已保存，响应体只有 `id` 与 `nickname`。
3. 发起一轮对话 → 先调 getvalue → 核对拿到 `vcn`/`vol`/`spd`（`lang` 可忽略）→ 创建实例 → start/stop 各返回 `{"code":200}`。
4. 第二轮对话重新调 getvalue，确认固件未使用上一轮缓存值。
5. 配网窗口内（上线后 120 秒）小程序可看到该设备并完成绑定。
6. 异常路径抽查：错误密码（401）、未上线先 getvalue（401）、未上线先 start（401）、
   getvalue 携带未声明字段（400）、start 缺少 `authorization_Role` 或 `authorization_TTS`（400）、
   stop 未知实例（404）、stop 后再 start 同实例（409）。
7. 我方在 `CHARACTER_TIMBRE_JSON` 填入真实 timbreId 之前，getvalue 会返回 500——这是预期行为，不是固件问题。
