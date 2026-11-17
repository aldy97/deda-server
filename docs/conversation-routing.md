# 五模式统一路由与 ConversationSession

## 路由契约

小模型分类器只允许输出以下七种标签：

- `free_chat`：角色自由对话。
- `adventure_story`：每日互动冒险。
- `english_story`：英语故事与口语陪练。
- `idiom_story`：成语故事。
- `sleep_config`：修改哄睡设置（时间、时长、内容偏好），走编排层的确定性短链路，不进持久会话。
- `sleep_story`：哄睡故事。
- `free_story`：泛化故事请求或自由创作故事，仅作为中间意图，不是持久会话模式。

不再使用 `not_story`。**每一轮都会调用分类模型**（续听、显式退出、强制哄睡三种情况除外）：
旧实现先用 `isRoutingCandidate` 正则做准入过滤，把「我困了」「眼皮打架了」这类不含词表字
的语义整句拦在模型之外——扩词表治不了本，故已移除该前置过滤。

代价与收益：意图分类与 L2 安全分类在编排层是 `Promise.all` 并行的，且两者用同一个小模型、
同样 `temperature: 0 / maxTokens: 10`，因此**首字延迟基本不变**；成本是每轮多一次
`qwen-flash` 调用（约 270 输入 + ≤10 输出 token ≈ 5.6e-5 元，缓存命中约 2.3e-5 元），
按日均 1 万轮计约 17 元/月。真实调用量与费用看 `intent_classify` 场景的 LLM 成本指标。

## 决策顺序

1. 冒险状态机优先处理互动作答，避免把选项或开放回答误分类成其他模式。
2. **强制哄睡覆写**（`ConversationSessionService` 内，先于会话状态机）：
   `enabled` 与 `forceSleep` 双开关都开、且当前在哄睡时段内时，孩子一开口即无条件进入
   `sleep_story`，不调分类模型。刻意排在最前，连显式退出与 `sleep_config` 都不放行——
   `applyVoiceUpdate` 的类型白名单挡得住 `forceSleep`，却挡不住 `sleepTime`，
   而窗口由 `sleepTime` 算出，放行就等于让孩子一句「哄睡改成 23:50」关掉强制哄睡。
   「不说话就不主动发起」由链路本身保证：本服务只在收到话时被动触发，新链路（百度 RTC）
   没有服务器推送通道。
3. `ConversationSessionService` 读取当前设备的持久会话。
4. 活跃英语、成语或哄睡会话中：
   - “继续”“再讲一个”等续听表达直接保持当前模式，不调用分类模型。
   - 明确退出时重置为 `free_chat`，不调用分类模型。
   - 其余一律调用分类模型做语义判定：**只有模型判为 `free_chat` 才维持原模式**并滑动续期，
     其他标签全部采纳。这样普通接话不会把故事打断，而「Elly 困了嘛」这类不含切换关键词
     的表达仍能真正切走（旧实现要求先命中 `isExplicitModeSwitch` 的动作词表才调模型，
     语义切换是假的；该词表已随之删除）。
5. 无活跃会话时，每轮都调用小模型分类。
6. **哄睡时段门禁**：分类结果为 `sleep_story` 但当前不在哄睡时段内 → 降级为 `free_chat`，
   由主模型自然共情回应（如「有点困啦？」），不硬拒也不强塞故事。降级**不写会话**，
   避免白天误入后占用 45 分钟粘滞。只拦 `sleep_story`：`sleep_config` 是改设置
   （白天也该能改），其余故事意图与哄睡无关。门禁对模型判定与关键词兜底一视同仁。
7. 非法模型输出或分类异常使用关键词兜底，最终可回落到 `free_chat`。
8. 今日冒险未完成时，`adventure_story` 和泛化 `free_story` 优先尝试进入每日冒险；完成后按既有每日门禁处理。成功进入冒险后重置普通会话，冒险进度仍由 `AdventureProgress` 和 `AdventureDailyRecord` 管理。

安全优先级不受上述顺序影响：L1/L2 拦截在编排层（`LlmAdapterService`）先于意图路由返回，
强制哄睡不会绕过安全闸。

### 决策来源（intentSource）

排查「孩子说要听故事却在闲聊」时，只看 intent 结果无法区分成因，因此
`resolveWithSource()` 在每个出口都带出来源，逐轮落 `turn_decision_logs.intentSource`：

| 来源                     | 对应出口 | 调模型 | 含义                                                                                |
| ------------------------ | -------- | ------ | ----------------------------------------------------------------------------------- |
| `model`                  | 4 / 5    | 是     | 小模型输出合法标签                                                                  |
| `fallback_invalid_label` | 7        | 是     | 模型有响应但标签不在七标签契约内 → 关键词兜底（**prompt 退化信号**）                |
| `fallback_error`         | 7        | 是     | 模型调用异常 → 关键词兜底（按 turnId 拼 `llm_usage_logs.failureReason` 可定位原因） |
| `pre_filter_skip`        | —        | —      | **已停用，仅历史数据**。前置关键词过滤已移除，新数据不会再产生该值；保留取值是为了让上线前的行仍能正确分桶 |
| `continuation`           | 4        | 否     | 活跃会话中的续听表达                                                                |
| `session_sticky`         | 4        | **是** | 活跃会话中调了模型、但模型判为 `free_chat` → 维持原模式并滑动续期（**语义已变**：旧实现是「没调模型」） |
| `explicit_exit`          | 4        | 否     | 明确退出，重置为 `free_chat`                                                        |
| `force_sleep`            | 2        | 否     | 家长开了强制哄睡且在哄睡时段内，直接覆写为 `sleep_story`                             |
| `sleep_window_closed`    | 6        | **是** | 模型判为 `sleep_story`，但当前不在哄睡时段 → 降级 `free_chat`                        |

> **`modelInvokedCount` 口径提醒**：服务端该字段只统计 `source === "model"`
> （见 `turn-decision-analytics.service.ts`），语义是「模型判定被直接采纳的轮次」，
> 不是「调用过模型的轮次」。`sleep_window_closed` 与 `session_sticky` 都调过模型
> 却不被计入，因此**模型真实调用量与费用请看 `intent_classify` 场景的 LLM 成本指标**，
> 不要用意图漏斗反推。

编排层（`LlmAdapterService`）另有三种「本轮没走到路由」的来源，同样落库但**不属于** `IntentSource`：

| 来源                 | 含义                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `not_routed`         | 被 L1/L2 拦截，直接播兜底话术，`intent` 为 null                                                                                       |
| `adventure_takeover` | 冒险状态机在编排顺序上早于 L2，命中即返回；本轮 `safetySource=not_evaluated`（**已知盲区**，见 `docs/analytics-api.md` 判定质量监控） |
| `no_device`          | 请求未带设备标识（匿名链路），无会话状态可依赖，恒定 `free_chat`                                                                      |

> `resolve()` 保留原签名（返回裸 intent）并委托 `resolveWithSource()`，
> 因此老 WS 链路 `vendor.service.ts` 零改动；新链路一律用 `resolveWithSource()`。
> 注意「零改动」指的是**代码**：强制哄睡与时段门禁实现在 `resolveWithSource()` 内部，
> 老链路的路由行为会一并变化——这是刻意的，两条链路必须同一套哄睡口径。

## 哄睡时段

窗口口径：**北京时间当日 `HH:mm >= sleepTime`，至当日 24:00 结束**，实现见
`src/modules/sleep-configs/sleep-window.util.ts` 的 `isInSleepWindow()`，
与 `sleep-scheduler.service.ts` 的定时扫描同一时区约定（`Asia/Shanghai`）。
**绝不能用服务器本地时区或设备时区**，否则跨时区部署或设备时钟漂移会让边界整段错位。

- 该窗口同时服务强制哄睡（出口 2）与 `sleep_story` 时段门禁（出口 6），必须是同一份实现。
- 设备没有 `sleep_configs` 行时按 schema 默认 `21:30` 门禁，保证已配置与未配置设备行为一致。
- 历史脏数据（如未零填充的 `9:30`）判为不在窗口：即不强制哄睡、也不拦孩子的请求。
  失败方向一律偏向「少限制孩子」，不让一条坏配置把设备锁进哄睡模式。
- `durationMinutes` **不参与**边界计算。它的语义是「哄睡内容播放时长」而非「时段长度」，
  且当前 LLM 故事长度不可精确控时（见 `sleep-scheduler.service.ts` 注释）；若用它算边界，
  `21:30 + 10 分钟` 会让窗口只到 21:40，21:45 说「我困了」反而不进哄睡。
  该字段目前仍无消费点，待播放时长控制能力就绪后启用。
- 边界示例：`sleepTime=23:50` → 窗口仅 10 分钟；`sleepTime=00:00` → 全天；
  `sleepTime=03:00` → 当日 03:00–24:00。均由同一条 `HH:mm >= sleepTime` 规则覆盖。
- 强制哄睡每轮会重置 `sleep_story` 的 45 分钟 TTL。**已知残留行为**：家长在 23:00 关掉
  `forceSleep` 后，会话仍留在 `sleep_story` 直到 TTL 过期或被显式退出打断；刻意不做额外清理任务。

### 哄睡内容降级

儿歌与催眠曲内容源尚未接入，`storyPrompt()` 的 `sleep_story` 分支恒出故事，
即 `SleepConfig.contentType` 配成 `song` / `mixed` 时**行为不变、只留证据**：

- 结构化 warn 日志：`Sleep content degraded: contentType=song served=story ...`。
- 本轮 assistant 的 `Message.rawPayload.sleepContentDegraded = { requested, served, reason }`
  （JSON 列，无需 migration）；未降级时该键不存在，`filler` / `answer` 两个既有键不变。

目的是避免「配置项看起来永远已生效」——否则没人会发现儿歌其实一次都没播过。

## 持久会话

每台设备最多一条 `ConversationSession`，通过唯一 `deviceId` 执行 upsert：

- `currentMode` 只保存 `free_chat / english_story / idiom_story / sleep_story`。
- 英语和成语故事无输入 20 分钟后过期。
- 哄睡故事无输入 45 分钟后过期。
- 每次有效互动滑动续期。
- 强制哄睡每轮覆写都会重置这 45 分钟 TTL（残留行为见「哄睡时段」一节）。
- 时段门禁降级为 `free_chat` 时**不写会话**，白天说困了不会占用哄睡粘滞。
- 下一条文字到达时惰性判断过期，不创建定时清理任务。
- 服务重启后从数据库恢复会话。
- 删除设备时级联删除会话。

## Prompt 与记忆边界

- 英语、成语、自由故事使用各自的故事 prompt。
- 哄睡 prompt 要求平静、缓慢，不提问、不邀请互动，并逐渐安静收尾。
- 分类器 prompt 显式覆盖困意语义（状态陈述、第三人称、撒娇式说法均算 `sleep_story`），
  并声明「是否真的进入哄睡由服务端时段门禁决定」——时段判断留在确定性代码里，不交给模型。
- 长期记忆只注入真正的 `free_chat` 主回答，不注入 filler、故事或哄睡回答。
  注意：被时段门禁降级的轮次意图就是 `free_chat`，因此**会**注入长期记忆，
  这正好让主模型能结合孩子作息自然共情回应。
- 消息落库继续使用现有 `Message.mode` 和 filler／answer 边界，不改变表结构；
  哄睡内容降级证据挂在同一条 assistant 的 `rawPayload` 上（见「哄睡内容降级」）。

## 流式兼容性

统一路由只决定本轮使用哪种对话模式，不改变既有 WS payload、chunk、`seq`、ack、全量兜底或 TTS 上传顺序。filler 仍全部先于 answer 上传，且每条 chunk 按顺序等待 ack。
