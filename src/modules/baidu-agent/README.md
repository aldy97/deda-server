# baidu-agent 模块

百度云「大模型实时互动」控制面协议层 + 音色/语速切换编排。

业务背景、数据流、生效时机、配置项与未解决问题清单见 `docs/voice-switching.md`。
本文件只说明模块内部结构与契约。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `baidu-agent.types.ts` | 唯一契约：端口 token、端口接口、常量（含 `DEVICE_DEFAULT_LANG`、`TTS_SPD_MIN/MAX`）、`VoiceApplyBlockReason`、`parseVoicePayload` |
| `bce-auth-string.util.ts` | 解析 BCE v1 认证字符串、判定过期、校验必需签名头；返回值不含 AK 与 signature |
| `tts-config.util.ts` | 组装 tts 配置串 `DEFAULT{"vcn":...,"spd":...}`；只含 vcn/spd，不含 vol |
| `baidu-agent-client.service.ts` | 出站 HTTP 客户端：守卫链 → 手工拼 body → axios 调用 → 归一化结果 |
| `voice-catalog.service.ts` | 音色目录（`VOICE_CATALOG_JSON` placeholder，权威来源是百度 timbres 接口） |
| `voice-reconcile.service.ts` | 编排：读期望值 → fail-closed 判定 → 下发或归因 deferred；另含 `getTimbreForCharacter`（IP/角色 → timbreId 纯查表，不出网） |
| `baidu-agent.module.ts` | 装配，只导出三个端口 token |

## 端口（消费方只依赖 token，不依赖实现类）

| token | 实现 | 消费方 |
| --- | --- | --- |
| `BAIDU_AGENT_CLIENT_PORT` | `BaiduAgentClient` | `VoiceReconcileService` |
| `VOICE_CATALOG_PORT` | `VoiceCatalogService` | `VoiceReconcileService`、`DeviceConfigsService` |
| `VOICE_RECONCILE_PORT` | `VoiceReconcileService` | `DeviceConfigsService`、`ClientApiService` |

## fail-closed 原因枚举

`VoiceApplyBlockReason` 共 13 个取值，客户端层产生前 7 个，编排层产生其余：

| reason | 产生位置 | 含义 |
| --- | --- | --- |
| `disabled` | client / reconcile | `BAIDU_AGENT_ENABLED` ≠ 字面 `"true"` |
| `signature_unparsable` | client | 认证字符串格式非法（段数、前缀、timestamp、有效期任一不符） |
| `signed_headers_unexpected` | client | signedHeaders 缺 `host` 或 `x-bce-date` |
| `signature_expired` | client | `timestamp + expiresInSeconds <= now` |
| `unsupported_cloud_node` | client | `cloud_node` 不在 `BAIDU_AGENT_HOSTS` 内（当前仅 `cn`） |
| `invalid_request` | client / reconcile | `instanceId` 非 1–19 位十进制、`appId` 为空、mac 查不到设备 |
| `upstream_error` | client | 百度返回非 2xx 或网络异常（`detail` 含状态码与百度 code，不含签名） |
| `no_active_instance` | reconcile | Redis 无当前实例，或实例记录缺失/已结束/无 `authorization_Role` |
| `empty_catalog` | reconcile | 音色目录为空（placeholder 未填充） |
| `voice_not_in_catalog` | reconcile | 期望 vcn 不在目录内，或与实例 `lang` 语种不匹配 |
| `speech_rate_map_missing` | reconcile | `SPEECH_RATE_MAP_JSON` 未配置该档位，或值越界 `[0.5, 2.0]` |
| `incomplete_tts_target` | reconcile | vcn 与 spd 未同时齐备（见 `TODO(Q9)`） |
| `internal_error` | reconcile / device-configs | 编排抛出未预期异常，已吞掉以保住主流程响应 |

## 三条硬约束

1. **body 不进签名**：BCE v1 只对 `method + canonicalURI + canonicalQuery + signedHeaders` 签名，
   因此我方可自由填写请求体——这是能用设备签名切换音色的根本原因。
2. **`ai_agent_instance_id` 必须裸数字**：手工拼 JSON，禁止 `JSON.stringify` 或 `Number()`，
   否则 `9223372036854775806` 这类 Long 会失真；`INSTANCE_ID_PATTERN` 在守卫链里挡住注入。
3. **签名原值不落日志**：日志只带 mac / instanceId / reason / 百度 code。

## 出处链接

- 服务端 API（switchSceneRole / interrupt / timbres）：https://cloud.baidu.com/doc/RTC/s/hm8zjic1q
- 音色列表接口：https://cloud.baidu.com/doc/RTC/s/Umh4lwjxt
- 接口鉴权（host 固定值、公共头必须性）：https://cloud.baidu.com/doc/RTC/s/em8y48zz6
- 生成认证字符串（bce-auth-v1 格式、canonical query 规则）：https://cloud.baidu.com/doc/Reference/s/njwvz1yfu
