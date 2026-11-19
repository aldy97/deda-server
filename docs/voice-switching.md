# 音色/语速动态切换

版本：1.4（2026-11-18）。后端通过设备端协议 v1.4 与百度云「大模型实时互动」控制面 API 动态切换 TTS 音色/语速，能力分三条：

1. **每轮创建前下发**（§2.5，v1.4 主通道）：固件每轮创建百度实例前调 `POST /client/bot/bot/getvalue` 拉取 `{vcn,vol,spd}`（我方额外附带 `lang`），且**不缓存**。这是平台配置到达设备的唯一常规通道，`vcn` 取自 `CHARACTER_TIMBRE_JSON`。
2. **同一轮内实时修正**（§2.1 / §2.3）：期望值落库 → 利用设备每轮上报的 BCE 签名调用百度控制面 API，对**当前实例**下发。设备在对话中即时生效，不在对话中则 deferred，下一轮 `bot/start` 后自动追平。v1.4 之后它的定位收窄为「同一轮内改口」——跨轮的权威值由 §2.5 承担。
3. **角色查表**（§2.4）：`CHARACTER_TIMBRE_JSON` 提供 IP/角色 → timbreId 的权威映射，是上面两条通道的共同数据源，同时供冒险剧情内多 IP 同剧时按角色切换音色（**该消费方尚无调用方**，接入前需先答 Q16）。

**产品定义**（熊总 2026-11-17，2026-11-18 按设备端协议 v1.4 修订）：一个机芯对应一个 IP，一个 IP 只有一个专属音色，家长不在小程序端选择音色。**音色的权威来源是服务端配置 `CHARACTER_TIMBRE_JSON`**：v1.4 新增 `POST /client/bot/bot/getvalue`，固件在每轮创建智能体实例前调用它拉取 `{vcn,vol,spd}` 且**不缓存**，因此平台配置是唯一真相源；1.1 版「`loginMac` 响应体下发初始音色」的设想已被这个独立接口取代，该通道在 1.2 已整体移除。`loginMac` 响应体已按 v1.4 §3.2 收敛为 `{id,nickname}`，`lang` 移到 getvalue 响应体（属我方扩展字段，见 Q22）。`/device-configs/:deviceId/voice` 端点保留为运维与联调的可观测入口（`applied`/`reason` 归因），不作为家长端功能。

契约唯一口径：`src/modules/baidu-agent/baidu-agent.types.ts`。

1.4 变更依据：把 v1.4 的 `getvalue` 落地为服务端实现（§2.5），并按 v1.4 §3.2 从 `loginMac` 响应体删除 `lang`。**固件侧 v1.4/v1.5 仍未实现**（v1.4 §八），现网设备还不会调用 getvalue，新端点在固件升级前是死代码；`loginMac` 删 `lang` 是本次唯一对现网有影响的行为变更，需罗工确认在网样机不读该字段。1.3 变更依据：机芯厂《设备端接口文档》**v1.4** 与《MQTT 交互协议》**v1.5**（2026-11-18，罗浩提供，出处见 §9）——v1.4 新增 `POST /client/bot/bot/getvalue` 作为音色/语速/音量的下发主通道，并把 `loginMac` 响应体收敛为 `{id,nickname}`；v1.5 §4.2 明确设备状态上报中每 600 秒带一组新签名（`query.data.authorization_Role` / `authorization_TTS`，有效期 1800 秒）。**1.3 仅修订文档表述，两个协议变更均未实现**——v1.4 §八：「本次只更新协议文档，固件与服务端实现与联调待完成」。1.2 变更依据（保留供追溯）：上述产品定义。1.1 变更依据（保留供追溯）：机芯厂（罗浩@智安芯科技）2026-11-17 书面答复三条——① 固件 `bot/start` 上报的 `lang` 取值为 `zh`；② 「百度控制台的所有音色都有音色id，设备请求上线的时候，响应体里面加一个音色id的参数，我解析后在创建百度实例的时候拼接进去就行」（该设想已在 1.3 被 v1.4 的独立 getvalue 接口取代）；③ 「目前没有刷新签名的机制，一次签名有效期是半个小时，后续可以上报设备状态的时候加一个签名参数，每隔十分钟重新上报一个新的」（已由 v1.5 §4.2 落地为协议，见 Q15）。

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

### 2.4 角色 → timbreId 查表（v1.4 getvalue 与剧情内切音色共用的数据源）

```
CHARACTER_TIMBRE_JSON（IP/角色 → timbreId 权威映射）
  → VoiceReconcileService.getTimbreForCharacter(characterKey)
    → 查表；未配置 / 未命中 / 值为空 → null（由调用方决定降级）

消费方 A —— v1.4 每轮创建前下发（**已实现**，详见 §2.5）：
  固件每轮创建智能体实例前 POST /client/bot/bot/getvalue { id, nickname }
    → 服务端按 id 定位设备 → 取其 characterKey → getTimbreForCharacter() 得 vcn
    → 叠加语速期望值（§2.1 落库）与音量配置 → 返回 { vcn, vol, spd, lang }
    → 固件不缓存，每轮重取；本轮配置只用于新建实例，不改正在进行的实例

消费方 B —— 剧情内按角色切音色（**待 Q16**）：
  冒险剧情内某段由「非本机芯 IP」的角色说话
    → getTimbreForCharacter(characterKey)
    → 命中 → 复用 §2.1 同一条下发链（applyToActiveInstance → switchSceneRole）
    → 冒险结束 → 显式切回本 IP 音色（方案 B1，不依赖新实例自动复位）
```

**当前状态**：查表方法已实现并有单测覆盖。消费方 A 已接通（`ClientApiService.botGetValue`，见 §2.5）；消费方 B 仍被 Q16 阻塞：`switchSceneRole` 返回 2xx 后是否立即生效未经确认；若为异步生效，「先切后发」会让每段第一句串味，时序方案需改为「提前一段预切」。注意 v1.4 §4.2 已明确「本轮配置只用于新建实例、不改正在进行的实例」，因此同一实例内的剧情切换与「冒险结束显式切回」（B1）仍然必要，不因 getvalue 而冗余。

**查表返回 null 时消费方 A 不降级**：`botGetValue` 直接抛 500，而不是编一个兜底音色——v1.4 §4.3 下任何非 200 都会让固件停止本轮创建，但一个错的音色会让设备用别人的声音说话且无人察觉。500 至少在服务端日志里留下可归因的原因。

**分工**：

| 场景                                       | 生效通道                | 说明                                                     |
| ------------------------------------------ | ----------------------- | -------------------------------------------------------- |
| 样机每轮对话的音色/语速/音量（v1.4 主通道） | §2.5 getvalue 下发      | 固件每轮创建实例前拉取、不缓存；vcn 取 `CHARACTER_TIMBRE_JSON`，spd 取语速期望值，vol 取 `TTS_DEFAULT_VOL` |
| 运维/联调改**语速**，设备在对话中          | §2.1 实时下发           | 立即对当前实例生效（受 1800 秒签名有效期限制）；下一轮起由 §2.5 承接同一期望值 |
| 运维/联调改**语速**，设备未对话            | 落库 → §2.3 追平        | 下一轮 start 后追平；实际上 §2.5 在创建实例时已带上该值 |
| 运维/联调改**音色**                        | §2.1 实时下发（仅当前实例） | **不改 §2.5 的结果**：getvalue 的 vcn 只认角色表，运维写入的 `desired.vcn` 刻意不采信（见 Q23） |
| 剧情内多 IP 同剧，非本 IP 角色说话         | §2.4 查表 → §2.1 下发   | 待 Q16 答复后接入                                         |

### 2.5 每轮创建前下发（v1.4 §4，主通道）

```
固件每轮发起对话、创建百度实例之前
  → POST /client/bot/bot/getvalue { id, nickname }     # 不带 Authorization（v1.4 §4.1）
    → ClientApiService.botGetValue()
      → normalizeMac(id)：id 是 loginMac 返回的原值，我方 loginMac 的 id 就是归一化 MAC
        （非法形态 400；协议要求固件「不与 MAC 混用」指的是固件不得自行拼造 id）
      → assertDeviceRegistered(mac)：设备从未 loginMac → 401
      → nickname 与派生值不一致 → 只 warn，不拒绝
      → vol  ← TTS_DEFAULT_VOL（全局配置；缺失/越界 → 500）
      → vcn  ← getTimbreForCharacter(device.characterKey)（查不到 → 500）
      → spd  ← resolveSpd(readDesired(device.id).speechRate ?? "normal") ?? 1.0
  ← 200 { code:200, data:{ vcn, vol, spd, lang }, msg:"success" }
    → 固件写入本轮 TTS 创建配置（tts=DEFAULT / tts_url 的 vcn、vol、spd）后创建实例
```

**几个刻意的设计决定**：

- **`lang` 是我方扩展字段**，不在 v1.4 的三字段里。依据是罗浩 2026-11-18「固件对 data 中未知参数是忽略态度」，追加它对现有固件无影响；它承接的是从 `loginMac` 移出的语种参数。当前恒为 `DEVICE_DEFAULT_LANG`（`zh`），**不做任何猜测性映射**（Q22）。
- **`spd` 有兜底、`vcn`/`vol` 没有**。`spd` 的兜底值 1.0 有书面依据（v1.4 §4.2「1.0为基础语速」）；`vcn`/`vol` 编不出来，编了也没人能发现错，因此一律 500。
- **`vol` 走全局配置**，不做每设备可调：产品上没有「每台设备不同音量」的需求，设备本地音量由 MQTT 的 volume(0-100) 管，v1.4 §4.2 明确两者分别处理。
- **不采信 `desired.vcn`**：运维经 `/device-configs/:deviceId/voice` 写入的音色只影响 §2.1 的实时下发，不影响 §2.5。否则同一台设备会出现「本轮实例用运维值、下一轮用角色值」的漂移（Q23）。
- **不受 `BAIDU_AGENT_ENABLED` 约束**：本接口不出网、不碰百度，且失败会让设备整轮无法对话；把它挂在一个用于暗启动出站调用的开关下，等于让开关误伤设备可用性。

**与 §2.3 的重叠（已知冗余，本版刻意不动）**：固件升级到 v1.4 后，「设备离线期间改了语速」这个场景在 getvalue 创建实例时就已覆盖，§2.3 的追平会退化成一次冗余的 `switchSceneRole` 调用；而该调用的 tts 串只带 `vcn`/`spd`、不带 `vol`（Q20），理论上可能把 getvalue 刚设好的音量重置掉。当前不改 §2.3 的理由：它只在设备存在期望值时才触发，默认状态是 `noop`，影响面为零；等 Q20 有答复后再决定是否把它收窄为「只处理同一轮内的变更」。

**发布闸口**：固件升级到 v1.4 之前，`CHARACTER_TIMBRE_JSON` 必须填好该设备 IP 的 timbreId（Q1）。未填 → 每轮 getvalue 都 500 → 设备每轮对话都创建失败，且按 v1.4 §4.3 **不会**自动重新 loginMac，只能由用户再次发起。`TTS_DEFAULT_VOL` 有默认值 1.0，`SPEECH_RATE_MAP_JSON` 缺失只会让 spd 回落 1.0，两者都不阻塞发布。

**取值已定（熊总 2026-11-19）**：Elly/Polly 暂不区分专属音色，两个 IP 先统一用 v1.4 文档示例里的 `1000957`，即 `{"elly":"1000957","polly":"1000957"}`；日后拿到各 IP 的专属音色，只改这个映射里对应的一行即可切换（查表发生在每轮 getvalue、固件不缓存，代码零改动）。音色目录 `VOICE_CATALOG_JSON` 不做权威覆盖（staging 现含两条**占位**条目，`status:"TRAINED"` 是我方自述而非百度真值，见 §6「env 填写状态」）。**staging 已于 2026-11-19 12:14 填入并重启生效；prod 仍未填。**

**还有一道容易漏的闸口**：compose 的 `environment` 是白名单，`--env-file` 只做变量替换——键只写在 env 文件里不会进容器，且不报错。2026-11-19 实测 staging 容器内 6 个音色/百度键（`CHARACTER_TIMBRE_JSON`、`TTS_DEFAULT_VOL`、`SPEECH_RATE_MAP_JSON`、`VOICE_CATALOG_JSON`、`BAIDU_AGENT_ENABLED`、`BAIDU_AGENT_TIMEOUT_MS`）全部 UNSET；现已加入 `docker/docker-compose.yml` 并由 `compose-env-gate.spec.ts` 的 `MUST_FORWARD` 钉住。填 env 之后必须重启 compose 才生效。**2026-11-19 12:14 已按此路径复测通过**：追加 4 个键 → 显式带原 `IMAGE_TAG` 重启（镜像未换）→ 容器内 `CHARACTER_TIMBRE_JSON`/`SPEECH_RATE_MAP_JSON`/`VOICE_CATALOG_JSON`/`BAIDU_AGENT_ENABLED` 均 SET 且 JSON 可解析，日志无 `is not valid JSON`、`level:50` 计数 0，`POST /client/bot/bot/getvalue` 由 500 转 **200 且 `vcn=1000957`**。

## 3. 生效时机

| applied     | 含义                                                         | 触发条件                                                     |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `live`      | 已对当前活跃实例调用百度 API 并收到 2xx                      | 设备在对话中、签名有效、目录有对应音色、所有 fail-closed 检查通过 |
| `deferred`  | 期望值已落库，但本次未下发，等下一轮 start 后自动追平        | 设备未在对话中、签名过期/不可解析、目录为空、语速映射未配置等任一 fail-closed 原因 |
| `noop`      | 无需操作：期望值与当前一致，或期望值为空（清除了之前设置）   | 期望 vcn 和 speechRate 均为 null                              |

**为什么设备不在对话中只能 deferred**：百度三个控制面 API 都要求实例活跃（设备已 start）。未 start 或已 stop 时实例无效，调用必然返回错误，因此只能落库等下一轮 start 追平。

**本表只描述 §2.1/§2.3**。§2.5 的 getvalue 是设备主动拉取、同步返回，没有 applied/reason 语义：成功就是 200 带三个字段，失败就是 4xx/5xx 且固件停止本轮创建。

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
| `speech_rate_map_missing`  | `SPEECH_RATE_MAP_JSON` 未配置，语速档位无法映射为 spd 倍数   | 填入产品决策后的档位→倍数映射                                |
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

## 6. 配置项

| 变量                     | 默认    | 说明                                                         |
| ------------------------ | ------- | ------------------------------------------------------------ |
| `BAIDU_AGENT_ENABLED`    | `false` | 总开关。默认关闭（暗启动）；开启前必须先填 `VOICE_CATALOG_JSON` |
| `BAIDU_AGENT_TIMEOUT_MS` | `5000`  | 百度云出站请求超时（毫秒）                                   |
| `VOICE_CATALOG_JSON`     | `[]`    | 音色目录 JSON 数组。权威来源百度 `GET /api/v1/timbres`，我方无 AK/SK 无法自动同步，需机芯公司导出后填入 |
| `SPEECH_RATE_MAP_JSON`   | `{}`    | 语速档位 → spd 倍数映射。产品决策。未配置时：§2.1 的语速变更只落库不下发；§2.5 的 `spd` 回落基础语速 1.0（不阻塞发布） |
| `TTS_DEFAULT_VOL`        | `1.0`   | §2.5 getvalue 响应体 `vol` 的唯一来源，全局配置、不做每设备可调。合法范围 `[0.5, 2.0]`（v1.4 §4.2，与 spd 同区间）。非法或越界 → getvalue 一律 500 → 设备每轮对话都创建失败，因此改这个值等于改全量设备可用性 |
| `CHARACTER_TIMBRE_JSON`  | `{}`    | IP/角色（`Device.characterKey`）→ timbreId 权威映射，例 `{"elly":"1000063","polly":"1000064"}`（示例值非真实音色 id）。v1.4 起是设备每轮音色的**唯一数据源**（§2.5 getvalue），同时供剧情内按角色切音色查表（§2.4）。与人设注入同源（`prompt-registry` 也按 characterKey 取人设）。**取值已定（熊总 2026-11-19）：staging 已填、prod 未填**（见本节「env 填写状态」）：两个 IP 暂统一用 `1000957`，日后按 IP 各填各的即可切换；**未填的环境** getvalue 一律 500，是固件升级到 v1.4 的发布闸口（Q1） |

**env 填写状态（截至 2026-11-19 12:14）**：

| 环境    | `CHARACTER_TIMBRE_JSON`                | `SPEECH_RATE_MAP_JSON`                 | `VOICE_CATALOG_JSON`                                                                     | `BAIDU_AGENT_ENABLED` | `TTS_DEFAULT_VOL` / `BAIDU_AGENT_TIMEOUT_MS` |
| ------- | -------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------- |
| staging | `{"elly":"1000957","polly":"1000957"}` | `{"slow":0.8,"normal":1,"fast":1.25}`  | 2 条**占位**：`1000957`（在线对话音色）、`1001022`（离线音频音色），均自述 `TRAINED`、`chinese` | `true`                | 沿用默认 `1.0` / `5000`                      |
| prod    | **未填**（默认 `{}`）                  | **未填**（默认 `{}`）                  | **未填**（默认 `[]`）                                                                    | **未填**（默认 `false`） | 默认                                         |

表内 timbreId、语速倍数、目录条目名都不是凭据，可以入库；env 文件本身权限保持 600，值不进仓库。目录条目的 `name` 是中性占位名，`status:"TRAINED"` 是我方自述而非百度真值，两者都等 Q7（只读 AK/SK）/ Q8（试听 url 刷新）有答复后按百度导出结果替换。**L0（两个 id 在线是否真可用 + 听感）服务端测不了**，仍需机芯公司或百度控制台确认，或用 L2 的 `applied` 归因反推（`live` = 可用，`upstream_error` = 该 id 在线不可用）。

**§2.5 的发布闸口在 staging 已解除、在 prod 仍然适用**：prod 的 `CHARACTER_TIMBRE_JSON` 填好之前，固件不能在 prod 升级到 v1.4，否则每轮 getvalue 都 500。

**默认关闭**：`BAIDU_AGENT_ENABLED=false` + `VOICE_CATALOG_JSON=[]` 时，§2.1/§2.3 全链路 fail-closed（`applied:"deferred"`），不出网、不改设备行为。

**§2.5 不受该开关约束**（刻意决定，理由见 §2.5）：getvalue 不出网、不碰百度，失败会让设备整轮无法对话。但它有自己的闸口——`CHARACTER_TIMBRE_JSON` 未填时一律 500。

`loginMac` 响应体已按 v1.4 §3.2 收敛为 `{id,nickname}`，无任何我方新增字段。**这是本版唯一对现网固件有影响的行为变更**：仍在读 `lang` 的老固件会拿到 undefined，需罗工确认在网样机不依赖它。

## 7. 未解决问题

| ID  | 问题                                                   | 阻塞什么                               | 不阻塞什么                               | 谁能答               |
| --- | ------------------------------------------------------ | -------------------------------------- | ---------------------------------------- | -------------------- |
| Q1  | **部分已答（熊总 2026-11-19）**：Elly/Polly 暂不区分专属音色，两个 IP 先统一用 v1.4 文档示例里的 `1000957`；`CHARACTER_TIMBRE_JSON` 保留按 characterKey 分键的结构，日后拿到各 IP 专属音色只改对应一行。音色目录 `VOICE_CATALOG_JSON` 不做权威覆盖（staging 现为两条占位条目，见 §6「env 填写状态」）。**仍未答**：`1000957` 属于哪个 IP、两个 IP 各自的专属 timbreId 何时给 | **发布闸口（staging 已解除、prod 仍在）**：staging 已填并于 2026-11-19 复测 getvalue 200 / `vcn=1000957`；prod env 未填则 §2.5 getvalue 一律 500，固件在 prod 升级到 v1.4 后设备每轮对话都创建失败；另阻塞目录的权威填充与剧情内角色查表 | 代码框架、fail-closed 路径、语速切换、v1.4 之前的现网设备 | 取值由熊总定；`1000957` 的归属与各 IP 专属音色仍待机芯公司 / 百度控制台 |
| Q2  | overseas / euUs 节点的百度域名是什么                   | 海外设备音色切换                       | cn 节点设备                              | 机芯公司 / 百度文档  |
| ~~Q3~~ | **已答（2026-11-17）**：目前没有刷新签名的机制，一次签名有效期半小时 | ——                                     | ——                                       | 已关闭               |
| Q4  | 真机切换是否有爆音；tts_sayhi 是否默认开启            | 用户体验验收                            | 服务端功能                               | 机芯公司联调         |
| Q5  | sendMsg（主动播报）是否需要第三份签名                  | 主动播报功能                           | 音色切换 + interrupt                     | 机芯公司 / 百度文档  |
| Q6  | 设备是否常驻实例（决定 interrupt/主动播报/定时哄睡能否用） | interrupt + 定时哄睡 + 定时播报        | 音色切换（§2.1/§2.3 在对话中即可）       | 机芯公司             |
| Q7  | 是否给我方只读 AK/SK，以自动同步 `GET /api/v1/timbres` | 音色目录自动同步                       | 手动填入目录后功能可用                   | 机芯公司 / 百度      |
| Q8  | 试听 url（`auditionAudioUrl`）1 小时过期               | 小程序试听功能                          | 音色目录展示（仅名称）                   | 百度 / 需设计刷新策略 |
| Q9  | 只传 spd 不传 vcn 时，百度是否沿用当前音色             | 语速单独切换                            | vcn+spd 同时切换                          | 机芯公司联调验证     |
| Q10 | 设备签名的 `signedHeaders` 实际取值（有效期已确认为 1800 秒，且代码本就从签名串第 4 段读） | 无——缺必需头即 fail-closed | 全部已落地路径                           | 机芯公司             |
| ~~Q15~~ | **已答（MQTT 交互协议 v1.5 §4.2，2026-11-18）**：设备状态上报的 `query.data` 每 600 秒带一组新签名，字段名 `authorization_Role` / `authorization_TTS`，有效期 1800 秒，不新增主题/cmd/instanceid，后端按主题 MAC 找当前 start 登记的实例替换签名；两字段均缺省 → 不动已有签名；仅一个字段、任一为 null 或空串、格式错 → 不覆盖；QoS1 重复上报幂等；**较早生成的签名不覆盖较新签名**（新 start 的首次签名也参与比较）；stop 或失效时清理 | 服务端续签实现（待后续 PR）            | 30 分钟内的实时切换                      | 已关闭（协议侧）     |
| Q16 | `switchSceneRole` 返回 2xx 后，新音色是**立即生效**还是异步生效（下一句/下一段才生效） | 剧情内按角色切音色的时序方案（先切后发 vs 提前一段预切） | §2.1/§2.3 的期望值下发与归因             | 机芯公司 / 百度联调  |
| Q17 | 一次对话内切换音色的**频率上限**与单次切换耗时         | 逐段切音色的延时预算（目标 ≤0.8s）      | 低频切换（冒险开始/结束各一次）           | 机芯公司 / 百度联调  |
| Q18 | 切换瞬间是否有**爆音**或可感知的停顿（与 Q4 同源）      | 剧情内切音色的体验验收                  | 服务端功能                               | 机芯公司联调         |
| ~~Q19~~ | **已答（设备端接口文档 v1.4 §4.1/§4.2，2026-11-18）**：不存在「固件内置音色」这一复位目标——固件不缓存音色配置，每轮创建实例前重新调 getvalue，新实例用的就是当轮平台配置；且 v1.4 §4.2 明确本轮配置只用于新建实例、不改正在进行的实例，故同一实例内「冒险结束显式切回」（B1）仍然必要 | ——                                     | ——                                       | 已关闭               |

| Q20 | §2.1 下发用的 tts 串只带 `vcn`/`spd`、不带 `vol`，`switchSceneRole` 之后当前实例的音量是否被重置为百度默认值 | 「同一轮内改语速」会不会顺带改掉音量（§2.5 的 `vol` 只对新建实例生效） | §2.5 getvalue（三字段一起给，不存在漏字段） | 机芯公司 / 百度联调 |
| ~~Q21~~ | **已答（熊总 2026-11-19）**：不加 IP 白名单，也不额外加限流——按 v1.4 §4.1 getvalue 不带 Authorization，返回字段均非敏感，且 `id` 必须先 loginMac 才存在，风险面可接受 | ——                                       | ——                                       | 已关闭               |
| Q22 | 我方在 getvalue 响应体追加的 `lang`：固件是否会解析并使用？多语种时 `DeviceConfig.language` 的 `bilingual` 该如何映射百度 `lang` | 多语种切换（当前恒返回 `zh`，代码里不做猜测性映射） | 单语种（zh）全部路径 | 机芯公司（罗浩） |
| Q23 | 运维经 `/device-configs/:deviceId/voice` 写入的 `desired.vcn` 是否应该覆盖 §2.5 的角色音色 | 当前**刻意不采信**（角色表权威，避免跨轮漂移）；若产品要求运维值优先，需改 `botGetValue` 的取值顺序 | §2.5 已落地行为、剧情内切音色 | 熊总（产品决策） |

## 8. TODO 注释索引

代码中所有与该功能相关的暂缓项均以 `TODO(Q` 开头标注。在仓库内搜索 `TODO(Q` 即可定位所有 placeholder：

| 标记 | 位置 | 内容 |
| --- | --- | --- |
| `TODO(Q1)` | `baidu-agent.types.ts`、`voice-reconcile.service.ts`、`voice-catalog.service.ts`（与 Q7 合并）、`client-api.service.ts`（`botGetValue` 的 vcn 分支）、`.env.example` | `CHARACTER_TIMBRE_JSON` 的取值已定（两 IP 暂统一 `1000957`，见 §2.5 的「取值已定」），**staging 已填（2026-11-19）、prod 仍未填**（见 §6「env 填写状态」）；音色目录的权威内容与 `en`、`ja` 语种映射仍待确认。**`client-api.service.ts` 那处是发布闸口**：staging 填好并重启后已复测恢复（getvalue 200 / `vcn=1000957`），prod 填好即恢复，代码零改动 |
| `TODO(Q2)` | `baidu-agent.types.ts` | overseas/euUs 域名待确认 |
| `TODO(Q8)` | `voice-catalog.service.ts` | 试听 url 刷新策略待设计 |
| `TODO(Q9)` | `voice-reconcile.service.ts`、`README.md` | 仅 spd 切换时百度行为待验证 |
| `TODO(Q10)` | `bce-auth-string.util.ts` | 签名 `signedHeaders` 实际取值待确认（有效期已确认 1800 秒） |
| `TODO(Q22)` | `client-api.controller.ts`（getvalue 的 `lang` 字段） | 固件是否解析 `lang`、`bilingual` 如何映射百度 `lang` 待确认；当前恒返回 `DEVICE_DEFAULT_LANG` |

Q3 已由机芯厂 2026-11-17 答复关闭（无中途续签、有效期 1800 秒），代码本就从签名串第 4 段读有效期、过期即 `signature_expired` fail-closed，因此无需改动、无残留标记。
Q4/Q5/Q6/Q15–Q20/Q23 属联调、后续协议或产品决策事项，只在本文 §7 跟踪，代码中暂无对应 placeholder（Q20/Q23 对应的代码位置分别是 `voice-reconcile.service.ts` 的 tts 串组装、`client-api.service.ts` 的 `botGetValue`）。Q21 已于 2026-11-19 关闭（不加限流与 IP 白名单），无代码改动。
Q11/Q12/Q13/Q14 在 1.2 随「`loginMac` 响应体下发初始音色」通道移除而暂时关闭，1.3 按 v1.4 复核后的最终处置：Q11（字段名）/ Q12（载荷形态）对 `loginMac` 不再适用——v1.4 改用独立的 getvalue 接口，其请求/响应字段已由 v1.4 §4.1/§4.2 定死（请求 `{id,nickname}`，响应 `{vcn,vol,spd}`），无需再问；Q13（固件是否缓存音色 id）已答：**不缓存**，「不管是平台在设备离线或是对话的过程中更换了音色，重新建立时都会重新给平台请求一次更新音色配置，确保每次的智能体实例创建都是与平台配置匹配」（罗浩 2026-11-18）；Q14（固件对 data 中未知参数的态度）已答：**忽略**，该结论是我方在 getvalue 响应体追加扩展字段（如 `lang`）的依据，但「忽略」不等于「解析」，扩展字段是否生效仍需在实现 PR 中登记确认。

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
- **产品定义**（熊总 2026-11-17，2026-11-18 修订）：一个机芯对应一个 IP，一个 IP 一个专属音色；
  家长不在小程序端选择音色。这是 1.2 移除上线下发通道、并把需求收敛为「剧情内按角色切音色」的依据。
  **修订点**：1.2 版此处曾记为「机芯对应 IP 的默认音色在不联网状态即已写好，不需服务端约束」，
  该表述已被设备端接口文档 v1.4 推翻——音色由服务端 getvalue 每轮下发、固件不缓存，平台配置是唯一真相源。
  产品定义中仍然成立的是「一个机芯一个 IP、一个 IP 一个专属音色、家长端不选音色」。
- **机芯厂 2026-11-17 书面答复**（罗浩@智安芯科技，聊天记录截图 `answer.png`）：
  ① `bot/start` 上报 `lang` 取值为 `zh`；② 上线响应体加音色 id 参数、固件解析后在创建百度实例时拼接；
  ③ 无签名刷新机制、有效期半小时，后续拟在设备状态上报中每 10 分钟带一次新签名。
  ①③ 是 `DEVICE_DEFAULT_LANG` 常量与 Q3 关闭结论的唯一依据；② 曾是 1.1 上线下发路径的依据，
  该路径已在 1.2 按产品定义移除，1.3 确认其设想已由 v1.4 的独立 getvalue 接口取代（见下条）。
- **机芯厂协议文档 v1.4 / v1.5**（2026-11-18，罗浩提供：`~/Desktop/设备端接口文档-1118.md` v1.4、
  `~/Desktop/MQTT交互协议-1118.md` v1.5；尚未纳入本仓库，是 §2.5 与后续续签 PR 的唯一依据）：
  - v1.4 §4.1/§4.2/§4.3：新增 `POST /client/bot/bot/getvalue`，请求体 `{id,nickname}`（**不带 Authorization**），
    响应 `{vcn:string, vol:number, spd:number}` 三字段必填、vol/spd 取值范围 0.5–2.0；任一字段缺失/类型错/越界
    → 固件停止本轮创建、不发 start 也不发 stop，用户再次发起时重新调 getvalue（**不会自动重新 `loginMac`**）。
    `vol` 是 TTS 合成音量，与 MQTT 本地 volume(0-100) 分别处理；本轮配置只用于新建实例，不改正在进行的实例。
  - v1.4 §3.2：`loginMac` 响应 data 收敛为 `{id,nickname}`（1.4 已落地）；§5.1：`start` 仍保留 `lang`（默认 zh）/`cloud_node`（默认 cn）。
  - v1.4 §7.1/§7.2：错误码与重试规则（400 不自动重复、401 先 loginMac、500 退避重试；getvalue 失败不套用 start/stop 的后台重试）。
  - v1.4 §八：**本次只更新协议文档，固件与服务端实现与联调均待完成**——这是 1.3 只改文档的依据。
    1.4 起**服务端一侧已实现**（§2.5）；固件侧仍未实现，因此现网设备还不会调用 getvalue。
  - v1.5 §4.2：签名中途续签的字段名、周期（600 秒）、有效期（1800 秒）、幂等与新旧签名比较规则（Q15 关闭依据）。
- **罗浩 2026-11-18 补充答复**（聊天记录）：新增 getvalue 用于「在本地智能体实例创建前获取平台设置的最新音色
  及语速等可调参数」，当前响应体形如 `{"vcn":"1000957","vol":2.0,"spd":1.0}`（tts 串）；固件不缓存音色 id，
  每次重建实例都重新请求；固件对 data 中未知参数持忽略态度。示例中的 `1000957` 属于哪个 IP **未确认**（并入 Q1）。