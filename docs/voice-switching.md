# 音色/语速动态切换

版本：1.1（2026-11-17）。本功能让小程序端选择音色与语速，后端通过两条互补通道让设备用目标音色说话：

1. **上线下发**（§2.4）：设备 `loginMac` 时把 timbreId 放进响应体，固件在创建百度实例时拼进 tts 配置 → 本轮第一句话就是目标音色，不依赖签名有效期。
2. **实时追平**（§2.1 / §2.3）：利用机芯厂设备每轮对话上报的 BCE 签名，调用百度云「大模型实时互动」控制面 API，在对话中动态切换 TTS 音色/语速。

契约唯一口径：`src/modules/baidu-agent/baidu-agent.types.ts`。

1.1 变更依据：机芯厂（罗浩@智安芯科技）2026-11-17 书面答复三条——① 固件 `bot/start` 上报的 `lang` 取值为 `zh`；② 「百度控制台的所有音色都有音色id，设备请求上线的时候，响应体里面加一个音色id的参数，我解析后在创建百度实例的时候拼接进去就行」；③ 「目前没有刷新签名的机制，一次签名有效期是半个小时，后续可以上报设备状态的时候加一个签名参数，每隔十分钟重新上报一个新的」。

## 1. 机制：为什么设备上报的签名能让我方切换音色

机芯厂设备在 `POST /client/bot/bot/start` 上报两份 BCE v1 签名：

- `authorization_Role`：用于调用百度 `PUT /api/v1/aiagent/instances/operation?switchSceneRole=`（切换角色/音色）
- `authorization_TTS`：用于调用百度 `POST /api/v1/aiagent/interrupt`（打断当前播报并播 `extra_msg`）

BCE v1 签名格式：`bce-auth-v1/{accessKeyId}/{timestamp}/{expirationPeriodInSeconds}/{signedHeaders}/{signature}`。

**关键安全事实**：BCE v1 的签名只对 `HTTP Method + CanonicalURI + CanonicalQueryString + CanonicalHeaders` 计算，**请求体不进签名**（《生成认证字符串》文档明确）。这意味着我方可以自由填写请求体（`tts` 配置串、`app_id`、`ai_agent_instance_id` 等），只要签名有效、且被签名的请求头取值与签名时完全一致，百度即放行。这正是「用设备上报的签名切换音色」成立的根本原因。

我方**不持有**百度 AK/SK，不参与签名生成，只原样回填设备上报的签名到 `Authorization` 请求头。

## 2. 数据流

### 2.1 App 设置路径

```
小程序音色设置页
  → POST /device-configs/:deviceId/voice { vcn?, speechRate? }
    → DeviceConfigsService.updateVoiceConfig()
      → 校验 vcn 是否在音色目录内（不在 → 400）
      → 将期望值写入 DeviceConfig.payload.voice（复用已有 payload Json 列）
      → VoiceReconcileService.applyToActiveInstance(mac, desired)
        → 从 Redis bot:current:{mac} 读取当前实例签名
        → fail-closed 检查链（见 §4）
        → 组装 tts 配置串 → BaiduAgentClient.switchSceneRole()
        → 返回 { applied: "live"|"deferred"|"noop", reason? }
  ← 响应 { deviceId, vcn, speechRate, spd, applied, reason? }
```

### 2.2 查询路径

```
小程序音色设置页
  → GET /device-configs/:deviceId/voice
    → DeviceConfigsService.getVoiceConfig()
      → 查该设备 isActive:true 且 createdAt 最新的 DeviceConfig，
        用 parseVoicePayload 取出期望 vcn、用 config.speechRate 取出期望语速
      → VoiceCatalog.listUsable() 获取可用音色列表
      → canApplyLive 只做只读判定（vcn + speechRate + spd 三者齐备），不查 Redis、不触发下发
      → 返回 { deviceId, vcn, speechRate, spd, catalog, available, canApplyLive, reason? }
```

### 2.3 start 追平路径

```
设备 start 成功后
  → ClientApiService 将签名存 Redis
  → VoiceReconcileService.onInstanceRegistered(mac, instanceId, deviceInternalId)
    → readDesired() 读取落库期望值
    → 有期望值 → 直接用 start 上报的 instanceId 走下发流程（不再查 bot:current:{mac}）
    → 无期望值 → noop
  → 追平以 fire-and-forget 触发，不阻塞 start 响应
```

**为什么必须 fire-and-forget**：出站调用百度云最长阻塞 `BAIDU_AGENT_TIMEOUT_MS`（默认 5000ms），而协议 4.2 要求 start 幂等快速返回 `{"code":200}`；等追平完成再响应会把一次慢调用放大成设备按协议 6.2 的多轮重试。代价是追平结果无法从 HTTP 响应观察，只能看日志或 `GET /device-configs/:deviceId/voice` 的 `applied`/`reason`。

`deviceInternalId` 由 bot/start 的 401 校验顺带取得并透传，追平钩子不再为同一个 id 重复查库。

### 2.4 上线（loginMac）初始音色下发路径

```
设备联网 → POST /client/user/user/loginMac
  → ClientApiService.loginMac()
    → 校验密码 → upsert Device（拿到内部 id 与 characterKey）→ 写认领窗口
    → VoiceReconcileService.resolveInitialVoice({deviceInternalId, characterKey, lang:"zh"})
      → readDesired()：DeviceConfig 里用户显式选的音色优先
      → 没有显式值 → 回落 CHARACTER_DEFAULT_TIMBRE_JSON[characterKey]（IP 默认音色）
      → fail-closed 检查：总开关 / 目录非空 / timbreId 在目录内且语种匹配
      → 语速映射缺该档位时不拦下发，降级为只发音色并打 warn
      → 按 LOGIN_VOICE_PAYLOAD_FORMAT 组装：裸 timbreId 或完整 tts 串
  ← 200 {"code":200,"data":{"id","nickname","lang",<音色字段>},"msg":"success"}
固件解析该字段 → 创建百度实例时拼进 tts 配置
```

**这条路径不调用百度云**：只是把「该用哪个音色」告诉固件。因此它不读 Redis 实例登记、不需要设备签名、不受 1800 秒有效期限制，也不要求实例已活跃（绕开未答的 Q6）。

**与 §2.1/§2.3 的分工**：

| 场景                     | 生效通道              | 说明                                                             |
| ------------------------ | --------------------- | ---------------------------------------------------------------- |
| 样机出厂默认音色         | §2.4（characterKey）  | 无需任何 App 操作，开机上线即生效                                |
| 用户在 App 改音色，设备在对话中 | §2.1 实时下发    | 立即对当前实例生效（受 1800 秒签名有效期限制）                   |
| 用户在 App 改音色，设备未对话 | 落库 → §2.3 追平   | 下一轮 start 后追平                                              |
| 改完之后新开的每一轮对话 | §2.3 追平             | 固件缓存的仍是上线时的 timbreId，新实例第一句可能回弹（见 Q13）  |

## 3. 生效时机

| applied     | 含义                                                         | 触发条件                                                     |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `live`      | 已对当前活跃实例调用百度 API 并收到 2xx                      | 设备在对话中、签名有效、目录有对应音色、所有 fail-closed 检查通过 |
| `deferred`  | 期望值已落库，但本次未下发，等下一轮 start 后自动追平        | 设备未在对话中、签名过期/不可解析、目录为空、语速映射未配置等任一 fail-closed 原因 |
| `noop`      | 无需操作：期望值与当前一致，或期望值为空（清除了之前设置）   | 期望 vcn 和 speechRate 均为 null                              |

**为什么设备不在对话中只能 deferred**：百度三个控制面 API 都要求实例活跃（设备已 start）。未 start 或已 stop 时实例无效，调用必然返回错误，因此只能落库等下一轮 start 追平。

## 4. fail-closed 原因枚举

`VoiceApplyBlockReason`（定义于 `src/modules/baidu-agent/baidu-agent.types.ts`）：

| 取值                       | 含义                                                         | 运维处置                                                     |
| -------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `disabled`                 | `BAIDU_AGENT_ENABLED=false`，总开关关闭（暗启动）            | 设为 `true` 并确保其他配置已就绪                             |
| `no_active_instance`       | 设备无活跃实例（未 start 或已 stop），签名已被清除           | 设备发起对话即可，无需人工介入                               |
| `signature_unparsable`     | 签名串形态不符：段数不对、前缀不是 `bce-auth-v1`、timestamp 格式非法、有效期非数字 | 检查固件签名生成逻辑，确认与机芯厂文档 2.2 节一致            |
| `signature_expired`        | `timestamp + expirationPeriodInSeconds < now`，签名已过期    | 设备重新 start 刷新签名；若频繁出现则检查固件与百度时钟同步  |
| `signed_headers_unexpected` | `signedHeaders` 缺少 `host` 或 `x-bce-date`                  | 固件改了签名方式，联系机芯厂确认                             |
| `unsupported_cloud_node`   | `cloud_node` 不在 `BAIDU_AGENT_HOSTS` 映射内（当前仅 `cn`）  | 确认 overseas/euUs 域名后补入映射（见 §7 Q2）                |
| `invalid_request`          | 我方入参非法（instanceid 不是十进制整数串、mac 查不到设备等） | 检查 Redis 中存储的 instanceid 格式与设备是否已注册           |
| `internal_error`           | 编排过程抛出未预期异常（DB/Redis 故障等），已吞掉以保住主流程响应 | 查服务端错误日志；期望值已落库，下一轮 start 会自动追平      |
| `empty_catalog`            | 音色目录为空（placeholder 未填充）                           | 从百度导出 timbres 列表填入 `VOICE_CATALOG_JSON`             |
| `voice_not_in_catalog`     | 期望音色不在目录内，或与实例语种不匹配                       | 确认 timbreId 与百度控制台一致，且语种匹配                   |
| `speech_rate_map_missing`  | `SPEECH_RATE_MAP_JSON` 未配置该档位，语速无法映射为 spd 倍数。仅 §2.1/§2.3 返回此值；§2.4 上线路径不拦，降级为只发音色并打 warn | 填入产品决策后的档位→倍数映射；上线路径的语速会在补齐后下一次上线生效 |
| `incomplete_tts_target`    | 只有 vcn 或只有 speechRate，不足以组装完整 tts 串            | 两者都需要才能下发（仅落库时不需要）                         |
| `upstream_error`           | 百度返回非 2xx                                               | 查百度控制台日志；常见错误码见百度文档                       |

## 5. 安全约束

1. **签名原值不落日志**：`ParsedBceAuthString` 刻意不暴露 `accessKeyId` 与 `signature`，只保留 `raw` 用于原样回填请求头。日志、管理页面、响应体均不得包含签名原值。
2. **AK/SK 我方不持有**：签名由设备生成，我方只做原样回填，不参与密钥管理。
3. **请求体不进签名**是本功能的基石：若百度未来将请求体纳入签名，本功能将完全失效，需回退到「设备侧切换音色然后 via MQTT 通知我方」的方案。
4. **host 被签进签名**：`cloud_node` 决定域名，域名改变则签名失效。当前仅支持 `cn` 节点（`rtc-aiagent.baidubce.com`），其他节点 fail-closed。
5. **音色目录为空时全链路 fail-closed**：空 `VOICE_CATALOG_JSON` → `available=false` → 任何 vcn 都未知 → POST 400。不静默接收未验证的音色 ID。
6. **语速仅限内置 tts 范围**：`spd` 取值 `[0.5, 2.0]`，越界拒绝不裁剪。
7. **我方刻意不传 `scene_role` / `scene_role_cfg`**：人设 prompt 由我方 llm-adapter + prompt-registry 按 `characterKey` 注入，百度侧角色 prompt 会与之叠加打架。
8. **上线下发的音色字段不是凭据**：timbreId 与 tts 配置串都是非敏感配置值，可以进响应体与日志；两份签名原值依旧绝不进响应体、绝不落日志（见第 1 条）。
9. **显式选择不被静默替换**：`resolveInitialVoice` 里 DeviceConfig 的 vcn 优先于 IP 默认值，且校验不通过时**不回落**到默认音色——静默换成另一个音色比不生效更难排查。

## 6. 配置项

| 变量                     | 默认    | 说明                                                         |
| ------------------------ | ------- | ------------------------------------------------------------ |
| `BAIDU_AGENT_ENABLED`    | `false` | 总开关。默认关闭（暗启动）；开启前必须先填 `VOICE_CATALOG_JSON`。同时管住两条通道：实时追平与上线下发 |
| `BAIDU_AGENT_TIMEOUT_MS` | `5000`  | 百度云出站请求超时（毫秒）。只影响实时追平；上线下发不出网     |
| `VOICE_CATALOG_JSON`     | `[]`    | 音色目录 JSON 数组。权威来源百度 `GET /api/v1/timbres`，我方无 AK/SK 无法自动同步，需机芯公司导出后填入 |
| `SPEECH_RATE_MAP_JSON`   | `{}`    | 语速档位 → spd 倍数映射。产品决策，未配置时语速变更只落库不下发（§2.4 上线路径例外，见 §4） |
| `CHARACTER_DEFAULT_TIMBRE_JSON` | `{}` | IP（`Device.characterKey`）→ 默认 timbreId 映射，例 `{"elly":"1000063","polly":"1000064"}`。样机出厂默认音色靠它；为空时上线不下发任何音色字段。与人设注入同源（`prompt-registry` 也按 characterKey 取人设） |
| `LOGIN_VOICE_PAYLOAD_FORMAT` | `timbreId` | 上线响应体下发形态：`timbreId`（裸音色 id，固件自己拼 tts 串）或 `tts`（完整配置串，音色+语速一次到位）。见 Q12 |

**三重默认关闭**：`BAIDU_AGENT_ENABLED=false` + `VOICE_CATALOG_JSON=[]` + `CHARACTER_DEFAULT_TIMBRE_JSON={}`，三者任一保持默认，loginMac 响应体就与《设备端接口文档》3.2 节完全一致，不会给老固件带来任何新字段。

## 7. 未解决问题

| ID  | 问题                                                   | 阻塞什么                               | 不阻塞什么                               | 谁能答               |
| --- | ------------------------------------------------------ | -------------------------------------- | ---------------------------------------- | -------------------- |
| Q1  | 音色目录内容：Elly/Polly 各自对应的 timbreId 是多少    | 目录填充 → 两条通道都可用              | 代码框架、fail-closed 路径               | 机芯公司 / 百度控制台 |
| Q2  | overseas / euUs 节点的百度域名是什么                   | 海外设备音色切换                       | cn 节点设备                              | 机芯公司 / 百度文档  |
| ~~Q3~~ | **已答（2026-11-17）**：目前没有刷新签名的机制，一次签名有效期半小时 | ——                                     | ——                                       | 已关闭               |
| Q4  | 真机切换是否有爆音；tts_sayhi 是否默认开启            | 用户体验验收                            | 服务端功能                               | 机芯公司联调         |
| Q5  | sendMsg（主动播报）是否需要第三份签名                  | 主动播报功能                           | 音色切换 + interrupt                     | 机芯公司 / 百度文档  |
| Q6  | 设备是否常驻实例（决定 interrupt/主动播报/定时哄睡能否用） | interrupt + 定时哄睡 + 定时播报        | 音色切换（§2.4 上线下发不依赖实例活跃）  | 机芯公司             |
| Q7  | 是否给我方只读 AK/SK，以自动同步 `GET /api/v1/timbres` | 音色目录自动同步                       | 手动填入目录后功能可用                   | 机芯公司 / 百度      |
| Q8  | 试听 url（`auditionAudioUrl`）1 小时过期               | 小程序试听功能                          | 音色目录展示（仅名称）                   | 百度 / 需设计刷新策略 |
| Q9  | 只传 spd 不传 vcn 时，百度是否沿用当前音色             | 语速单独切换（仅 §2.1/§2.3 实时路径）  | vcn+spd 同时切换；§2.4 上线路径          | 机芯公司联调验证     |
| Q10 | 设备签名的 `signedHeaders` 实际取值（有效期已确认为 1800 秒，且代码本就从签名串第 4 段读） | 无——缺必需头即 fail-closed | 全部已落地路径                           | 机芯公司             |
| Q11 | loginMac 响应体里承载音色的**字段名**是什么（对方原话只有「加一个音色id的参数」） | §2.4 上线下发真正生效                  | 实时切换路径；代码框架（改一处常量即可） | 机芯公司             |
| Q12 | **语速怎么传到实例创建**：固件只拼 timbreId 的话 spd 无处安放。我方建议改为下发完整 tts 串（百度文档明确 switchSceneRole 的 `tts` 等价于创建实例的 `tts_url`），固件原样填入即可 | 出厂默认语速；改 `LOGIN_VOICE_PAYLOAD_FORMAT=tts` 的前提 | 音色下发；实时语速切换（§2.1） | 机芯公司             |
| Q13 | 固件把 timbreId **缓存多久**？App 改音色后如何让固件刷新（新增 MQTT 下行 `voice` 指令，还是每轮创建实例前重新取） | 改音色后新开轮次的**音色回弹**         | 当前实例的实时切换                       | 机芯公司             |
| Q14 | 老固件对 loginMac 响应体 `data` 内**新增未知字段**的容忍度（忽略 or 严格校验报错） | 灰度安全性                             | 新固件；默认配置下字段根本不出现         | 机芯公司             |
| Q15 | 后续「上报设备状态时加签名参数、每 10 分钟一次」的**字段名与协议版本号** | 签名自动刷新（延长实时切换可用窗口）   | 30 分钟内的实时切换                      | 机芯公司             |

## 8. TODO 注释索引

代码中所有与该功能相关的暂缓项均以 `TODO(Q` 开头标注。在仓库内搜索 `TODO(Q` 即可定位所有 placeholder：

| 标记 | 位置 | 内容 |
| --- | --- | --- |
| `TODO(Q1)` | `baidu-agent.types.ts`、`voice-reconcile.service.ts`、`voice-catalog.service.ts`（与 Q7 合并） | 音色目录内容 / `en`、`ja` 语种映射待确认 |
| `TODO(Q2)` | `baidu-agent.types.ts` | overseas/euUs 域名待确认 |
| `TODO(Q8)` | `voice-catalog.service.ts` | 试听 url 刷新策略待设计 |
| `TODO(Q9)` | `voice-reconcile.service.ts`、`README.md` | 仅 spd 切换时百度行为待验证 |
| `TODO(Q10)` | `bce-auth-string.util.ts` | 签名 `signedHeaders` 实际取值待确认（有效期已确认 1800 秒） |
| `TODO(Q11)` | `baidu-agent.types.ts`、`client-api.service.ts` | loginMac 音色字段名待确认 |
| `TODO(Q12)` | `baidu-agent.types.ts`、`voice-reconcile.service.ts` | 下发形态（裸 timbreId vs 完整 tts 串）待确认 |
| `TODO(Q14)` | `baidu-agent.types.ts`、`client-api.controller.ts`、`client-api.service.ts` | 老固件对新增未知字段的容忍度待确认 |

Q3 已由机芯厂 2026-11-17 答复关闭（无中途续签、有效期 1800 秒），代码本就从签名串第 4 段读有效期、过期即 `signature_expired` fail-closed，因此无需改动、无残留标记。
Q4/Q5/Q6/Q13/Q15 属联调或后续协议事项，只在本文 §7 跟踪，代码中暂无对应 placeholder。

## 9. 出处链接

- 百度「大模型实时互动」服务端 API（switchSceneRole / interrupt / timbres 请求语法与错误码）：
  https://cloud.baidu.com/doc/RTC/s/hm8zjic1q
- 百度「接口鉴权」（host 固定值、公共请求头必须性）：
  https://cloud.baidu.com/doc/RTC/s/em8y48zz6
- 百度「生成认证字符串」（bce-auth-v1 格式、timestamp、有效期起算点）：
  https://cloud.baidu.com/doc/Reference/s/njwvz1yfu
- 百度「音色列表」`GET /api/v1/timbres`（timbreId / name / status / language / auditionAudioUrl）：
  https://cloud.baidu.com/doc/RTC/s/Umh4lwjxt
- 两份签名的用途分工：以本仓库 `src/modules/client-api/dto/bot-start.dto.ts` 的注释为准
  （源自机芯厂《设备端接口文档》v1.2 §4.1）——`authorization_Role` → switchSceneRole，
  `authorization_TTS` → interrupt。
- 签名实际覆盖的 `signedHeaders` 取值：本仓库无书面出处，待机芯公司确认（Q10）。
  代码不依赖该项——有效期一律从签名串第 4 段读取，`signedHeaders` 缺 `host`/`x-bce-date`
  时按 `signed_headers_unexpected` fail-closed。
- **机芯厂 2026-11-17 书面答复**（罗浩@智安芯科技，聊天记录截图 `answer.png`）：
  ① `bot/start` 上报 `lang` 取值为 `zh`；② 上线响应体加音色 id 参数、固件解析后在创建百度实例时拼接；
  ③ 无签名刷新机制、有效期半小时，后续拟在设备状态上报中每 10 分钟带一次新签名。
  这三条是 §2.4 上线下发路径、`DEVICE_DEFAULT_LANG` 常量与 Q3 关闭结论的唯一依据。