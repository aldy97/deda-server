# 五模式统一路由与 ConversationSession

## 路由契约

小模型分类器只允许输出以下六种标签：

- `free_chat`：角色自由对话。
- `adventure_story`：每日互动冒险。
- `english_story`：英语故事与口语陪练。
- `idiom_story`：成语故事。
- `sleep_story`：哄睡故事。
- `free_story`：泛化故事请求或自由创作故事，仅作为中间意图，不是持久会话模式。

不再使用 `not_story`。普通聊天不调用分类模型，直接路由到 `free_chat`。

## 决策顺序

1. 冒险状态机优先处理互动作答，避免把选项或开放回答误分类成其他模式。
2. `ConversationSessionService` 读取当前设备的持久会话。
3. 活跃英语、成语或哄睡会话中：
   - “继续”“再讲一个”等续听表达直接保持当前模式，不调用分类模型。
   - 普通作答和接话默认保持当前模式，并滑动续期。
   - 明确的模式切换请求才调用分类模型。
   - 明确退出时重置为 `free_chat`。
4. 无活跃会话时，只有故事、冒险、哄睡等候选表达才调用小模型分类。
5. 非法模型输出或分类异常使用关键词兜底，最终可回落到 `free_chat`。
6. 今日冒险未完成时，`adventure_story` 和泛化 `free_story` 优先尝试进入每日冒险；完成后按既有每日门禁处理。成功进入冒险后重置普通会话，冒险进度仍由 `AdventureProgress` 和 `AdventureDailyRecord` 管理。

### 决策来源（intentSource）

上面 7 条出口里有 4 条**根本不调小模型**。排查「孩子说要听故事却在闲聊」时，
只看 intent 结果无法区分成因，因此 `resolveWithSource()` 在每个出口都带出来源，
逐轮落 `turn_decision_logs.intentSource`：

| 来源                     | 对应出口 | 调模型 | 含义                                                                                |
| ------------------------ | -------- | ------ | ----------------------------------------------------------------------------------- |
| `model`                  | 3 / 4    | 是     | 小模型输出合法标签                                                                  |
| `fallback_invalid_label` | 5        | 是     | 模型有响应但标签不在七标签契约内 → 关键词兜底（**prompt 退化信号**）                |
| `fallback_error`         | 5        | 是     | 模型调用异常 → 关键词兜底（按 turnId 拼 `llm_usage_logs.failureReason` 可定位原因） |
| `pre_filter_skip`        | 4        | 否     | `isRoutingCandidate` 未命中，直接 `free_chat`（**词表覆盖不足信号**）               |
| `continuation`           | 3        | 否     | 活跃会话中的续听表达                                                                |
| `session_sticky`         | 3        | 否     | 活跃会话中的普通接话，滑动续期                                                      |
| `explicit_exit`          | 3        | 否     | 明确退出，重置为 `free_chat`                                                        |

编排层（`LlmAdapterService`）另有三种「本轮没走到路由」的来源，同样落库但**不属于** `IntentSource`：

| 来源                 | 含义                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `not_routed`         | 被 L1/L2 拦截，直接播兜底话术，`intent` 为 null                                                                                       |
| `adventure_takeover` | 冒险状态机在编排顺序上早于 L2，命中即返回；本轮 `safetySource=not_evaluated`（**已知盲区**，见 `docs/analytics-api.md` 判定质量监控） |
| `no_device`          | 请求未带设备标识（匿名链路），无会话状态可依赖，恒定 `free_chat`                                                                      |

> `resolve()` 保留原签名（返回裸 intent）并委托 `resolveWithSource()`，
> 因此老 WS 链路 `vendor.service.ts` 零改动；新链路一律用 `resolveWithSource()`。

## 持久会话

每台设备最多一条 `ConversationSession`，通过唯一 `deviceId` 执行 upsert：

- `currentMode` 只保存 `free_chat / english_story / idiom_story / sleep_story`。
- 英语和成语故事无输入 20 分钟后过期。
- 哄睡故事无输入 45 分钟后过期。
- 每次有效互动滑动续期。
- 下一条文字到达时惰性判断过期，不创建定时清理任务。
- 服务重启后从数据库恢复会话。
- 删除设备时级联删除会话。

## Prompt 与记忆边界

- 英语、成语、自由故事使用各自的故事 prompt。
- 哄睡 prompt 要求平静、缓慢，不提问、不邀请互动，并逐渐安静收尾。
- 长期记忆只注入真正的 `free_chat` 主回答，不注入 filler、故事或哄睡回答。
- 消息落库继续使用现有 `Message.mode` 和 filler／answer 边界，不改变表结构。

## 流式兼容性

统一路由只决定本轮使用哪种对话模式，不改变既有 WS payload、chunk、`seq`、ack、全量兜底或 TTS 上传顺序。filler 仍全部先于 answer 上传，且每条 chunk 按顺序等待 ack。
