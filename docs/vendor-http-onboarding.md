# deda-server 设备侧 HTTP 接口对接说明（供机芯厂固件配置）

版本：1.2（2026-11-17）。本文档是机芯厂《设备端接口文档》v1.2 的**我方实现回执**：
三个 HTTP 接口已在 deda-server 实现并与公版协议逐项对齐，供固件烧录与联调使用。
协议语义（调用时机、错误码、重试规则）以公版文档为准，本文只写我方实现的具体事实。

1.2 变更：① `loginMac` 响应体 `data` 内新增**可选**音色字段（§2.1.1），依据罗浩 2026-11-17 答复；② `bot/start` 的音色追平改为不阻塞响应（§2.2）。

## 1. 基础地址（由我方提供，请配置进固件）

| 环境               | 基础地址                    | 说明                                             |
| ------------------ | --------------------------- | ------------------------------------------------ |
| staging（联调）    | `http://8.133.236.127:3001` | 联调期为 HTTP；设备直连，无需经过机芯厂云中转    |
| production（量产） | `https://<生产域名>`        | HTTPS；证书由我方运维配置，固件侧 TLS 能力待确认 |

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
  - **可选扩展字段**（2026-11-17 与罗浩约定，见下）：`data` 内可能多出一个音色字段。
- 重复上线按同一 MAC 更新登记，不重复建档。
- 服务端未配置 API KEY 时返回 500；设备按公版 6.2 退避重试即可。

#### 2.1.1 响应体 `data` 内的音色字段（我方新增，公版 3.2 节没有）

依据罗浩 2026-11-17 答复：「百度控制台的所有音色都有音色id，设备请求上线的时候，响应体里面加一个音色id的参数，我解析后在创建百度实例的时候拼接进去就行」。

- **出现条件**：仅当我方为该设备解析出了可用音色时才出现；未配置音色目录、该设备没有期望音色、或音色与语种不匹配时**整个字段不出现**，响应体与公版 3.2 节逐字节一致。固件必须按「可选字段」处理，缺失即用百度互动应用自身的默认 tts。
- **默认形态**（`LOGIN_VOICE_PAYLOAD_FORMAT=timbreId`）：

  ```json
  {"code":200,"data":{"id":"aabbccddeeff","nickname":"设备 ddeeff","lang":"zh","timbreId":"1000063"},"msg":"success"}
  ```

  固件取 `data.timbreId`，在创建百度实例时拼进 tts 配置。
- **备选形态**（`LOGIN_VOICE_PAYLOAD_FORMAT=tts`，待 Q12 确认后启用）：字段名变为 `tts`，值是**完整配置串**，固件原样填入创建实例接口的 `tts_url` 即可，无需自己拼：

  ```json
  {"code":200,"data":{"id":"aabbccddeeff","nickname":"设备 ddeeff","lang":"zh","tts":"DEFAULT{\"vcn\":\"1000063\",\"spd\":0.8}"},"msg":"success"}
  ```

  百度文档明确 switchSceneRole 的 `tts` 取值等价于创建实例接口的 `tts_url`，因此这种形态能让**音色与语速一次到位**；默认形态只能表达音色，语速得等我方事后调 switchSceneRole。

**待机芯厂书面确认**（确认前我方不改字段名，默认形态也不启用备选）：

| 编号 | 待确认项 |
| --- | --- |
| Q11 | 字段名用 `timbreId` 是否可以？还是固件已按别的名字解析 |
| Q12 | 能否接受备选形态（完整 `tts` 串），以便语速也在创建实例时生效 |
| Q13 | 固件把该值缓存多久？App 改音色后如何让固件刷新（新增 MQTT 下行指令，还是每轮创建实例前重新取）——否则**下一轮新实例会回弹到上线时的音色** |
| Q14 | 老固件遇到 `data` 内的未知字段是忽略还是报错 |

联调黄金值（供固件核对密码算法）：

| mac（归一化后） | password                           |
| --------------- | ---------------------------------- |
| `aabbccddeeff`  | `eec1ea82480a6a30fdf47227af0652b7` |
| `90fe1de7a1ca`  | `cf471119880560a0f8715d347bd8fa70` |

### 2.2 `POST /client/bot/bot/start`

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
- `lang` 缺省按 `zh` 处理（罗浩 2026-11-17 确认固件上报值就是 `zh`）；我方用它过滤音色目录，跨语种切换百度不支持。

### 2.3 `POST /client/bot/bot/stop`

- 按 `mac` + `instanceid` 精确结束；重复 stop 幂等返回 `{"code":200}`。
- 旧实例的延迟 stop 不会清理该设备的新实例。
- 未知实例或 MAC 不匹配返回 404；设备未上线返回 401。
- stop 处理后我方清除该实例的 authorization_Role、authorization_TTS 及 v1.1 兼容的 authorization。

### 2.4 通用

- 判定成功：HTTP 200 且响应体 `code` 为 200。
- 错误响应体：`{"code":<HTTP 状态码>,"msg/message":"原因"}`，HTTP 状态与 code 一致。
- 实例登记记录我方保存 24 小时；服务端登记状态丢失时，设备会在 start/stop 收到 401，按公版 6.2 重新 loginMac 后重试即可自恢复。
- MQTT 公共主题 `loginMac` 已取消，设备无需发布/订阅；MQTT 上下行主题与心跳规则不变（见《MQTT交互协议》）。

## 3. 联调 checklist

1. staging 基础地址已提供（`http://8.133.236.127:3001`）→ 固件配置。
2. 设备配网连上 WiFi → 调 loginMac → 核对响应头 `Authorization` 已保存。
3. 发起一轮对话 → 确认 start/stop 各返回 `{"code":200}`。
4. 配网窗口内（上线后 120 秒）小程序可看到该设备并完成绑定。
5. 异常路径抽查：错误密码（401）、未上线先 start（401）、start 缺少
   `authorization_Role` 或 `authorization_TTS`（400）、stop 未知实例（404）、
   stop 后再 start 同实例（409）。
