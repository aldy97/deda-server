# 交互式冒险故事模式 · 开发文档

状态：已实现，本地测试通过，待人工审核（未 commit/push）
分支：`feat/adventure-story-mode`（基于 origin/main，已建）
上游需求：《Elly 新品 MVP 定义文档 v2.0》第四章（每日冒险）、4.2 交互原语、4.3 每日机制、4.4 连贯性保障。

---

## 1. 目标与范围

在现有语音链路（机芯厂云 WS 上行 ASR 文字 → 我方云 → chunk 流式下行）上，新增「交互式冒险故事模式」：

- 故事内容数据化：集（Episode）→ 段落（Segment）→ 交互点（Interaction），主线 100% 人写定稿；
- 服务端状态机推进，旁白原文直出（零 LLM、零改写）；
- 小模型负责故事语义分类和开放式交互接话，不续写主线、不直接决定路由权限；
- 交互等待期间 **10 秒无上行文字则自动兜底续播**（见第 6 节）；
- 每个设备独立选集和续玩；每日完成记录与不可变事件完整落库；
- `Device.characterKey` 决定 Elly / Polly 的选集和接话人设。

**非目标**：家长小程序开关与展示、story bible 结构化、真分支剧情。

## 2. 架构总览

```
机芯厂云 WS 上行（vendor:text:in）
        │
        ▼
VendorService.handleTextIn
        ├─ 正在等待互动 → AdventureService 处理孩子回答
        └─ 故事类请求 → 小模型输出 StoryIntent 标签
                          │
                          ▼
                   后端查询 DailyRecord 门禁
                          │
                          ▼
                AdventureService（状态机）
                ├─ 旁白原文 → chunk 流式下行（source=answer）
                ├─ 交互点 → 最后 chunk ack 后启动 10s 等待
                └─ 完集 → Progress + DailyRecord + Event 同事务落库
```

不变式：

1. 主线推进权永远在引擎，孩子回答只影响接话句；
2. 每个交互点最多引回一次，之后兜底推进，绝不卡死、绝不批评；
3. 接话只做「接住 + 过渡」，不讲新剧情；
4. 小模型只判意图，数据库每日状态才决定是否允许进入冒险。

## 3. 数据模型

| 模型 | 职责 | 关键约束 |
|---|---|---|
| `AdventureEpisode` | IP、季、集、前情回顾与发布状态 | `[characterKey, season, episodeNumber]` 唯一 |
| `AdventureSegment` | 人写旁白与四种交互原语 | `[episodeId, order]` 唯一 |
| `AdventureProgress` | 每个设备每一集的可变进度、星光、等待起点 | `[deviceId, episodeId]` 唯一；`completedAt` 记录实际完集时间 |
| `AdventureDailyRecord` | 每日分配档案；跨天续玩保留 `assignedDate` | `[deviceId, assignedDate]` 唯一；`completedDate` 是每日完成门禁 |
| `AdventureEvent` | 只追加审计历史，不复制 ASR/播报全文 | `eventKey` 唯一；完成事件幂等 |

每日完成与事件在同一事务写入；播报全文仍保存在 `Message`，`AdventureEvent` 只保存事件类型、轮次、段落序号和少量结构化元数据。

## 4. 状态机与入口

状态：`idle → narrating → awaiting_reply → narrating → … → completed → idle`；明确拒绝时进入 `exited`，之后只能恢复已分配的同一集。

| 场景 | 结果 |
|---|---|
| 今日未完成，泛化「我想听故事」或明确冒险 | 开第一个个人未完成集，或恢复当前集 |
| 中途退出后再次请求故事 | 从 `nextSegmentOrder` 续玩，不重播 recap，不换集 |
| 跨天仍未完成 | 继续原集；实际完成当天写入 `completedDate` |
| 今日完成后重听、换一集或泛化故事 | 禁止进入冒险，路由自由创作故事 |
| 今日完成后明确英语／成语故事 | 尊重明确意图，不进入冒险 |
| 下一集未发布 | 停止选集，不跳过、不循环 |
| 全部集已完成 | 返回自由故事，不重播旧集 |

## 5. 交互五类处置（行为契约）

| 类别 | 判定 | 动作 | LLM 调用 |
|---|---|---|---|
| 正常作答 | 二选一匹配到选项；开放提问在故事语境内 | 二选一播预生成回应；开放提问小模型接一句；随后续播 | 开放提问才调 |
| 脱离语境（首次） | 与故事无关但未达兜底条件 | 接住 + 轻引回一次（小模型），offTopicCount=1 | 调 |
| 超前发挥/编剧情 | 内容涉及后续剧情 | 不确认不否认不跟随，接话后照常播原文；禁止按孩子想象续写主线 | 调 |
| 持续不配合 | offTopicCount ≥ 1 再次跑题 | 播 fallbackText 推进，不再引回 | 不调 |
| 明确拒绝 | 含「不要听/不想玩」等 | 播 exitText，退出冒险回自由对话，进度保留当天可续 | 不调 |
| 沉默 | 10s 无上行（第 6 节） | 播 fallbackText 推进 | 不调 |

每次交互结果打标：`answered / off_topic / fallback / exit / timeout`，供周报与内测质量分析。

## 6. 10 秒沉默超时设计（本次新增需求）

### 6.1 计时口径

- **起点 t0 = 引导词最后一个 chunk 上传完成（收到机芯厂 ack）的服务器时间**，写入 `AdventureProgress.waitingSince`。
- 说明：机芯厂侧 TTS 实际播完引导词的时点晚于 t0（TTS 合成 + 播报时长）。10s 预算 = 引导词播报残余 + 孩子反应时间，MVP 先按 10s 固定值实现，灰度后按实测调整（常量配置，不写死散落各处）。
- **终点判定 = 我方服务器收到该设备 vendor:text:in 的时间**（不是 ASR 识别完成在机芯厂侧的时点）。

### 6.2 超时动作

- 到点未收到上行：播该交互点 `fallbackText` + 推进至下一段（与「持续不配合」共用兜底路径）；
- 交互结果标记 `timeout`；本轮 assistant 落库内容 = 兜底话术 + 续播原文（无 user 行，因为没有输入）。

### 6.3 竞态处理

- 上行到达时先检查 `waitingSince`：若 `now - waitingSince < 10s` → 正常处置并取消定时器；
- 若定时器已触发、故事已推进，**迟到的回答不回滚故事**，该上行按新一轮普通输入走（意图路由/自由对话）；
- 每个设备同时最多一个等待定时器；开新交互、退出冒险、完集时必须清理。

### 6.4 重启恢复

- 定时器在内存（`Map<deviceId, Timeout>`），但 `waitingSince` 已持久化；
- 进程重启后：后台 sweep（每 2s 扫描一次 `status=awaiting_reply` 且 `waitingSince` 超时的记录）补触发兜底，保证不卡死在等待态；
- sweep 同时覆盖「定时器因异常未启动/未触发」的漏网情况。

### 6.5 设备隔离

- 定时器、progress、上行路由全部按 deviceId 隔离；A 设备的上行不得触发 B 设备的等待取消。

## 7. 语音链路与意图路由

1. `awaiting_reply` 的上行先进入状态机，避免把选项回答误分类成新故事；
2. 故事候选文本调用小模型，返回 `adventure_story / english_story / idiom_story / free_story / not_story` 之一；非法输出或调用失败使用关键词兜底；
3. 今日未完成时，`adventure_story` 和 `free_story` 都尝试开集／续玩；明确英语、成语故事不抢占；
4. 今日完成后不再调用 `startToday`，记录 `entry_blocked_completed` 与 `routed_other_mode`，再进入对应故事链路；
5. 非故事普通聊天不自动开冒险，沿用原教材／自由对话流程。

冒险回复复用 `VendorReplyUploader`：`source=answer`、seq 连续、逐 chunk await ack、最后发送 `vendor:text:out` 全量兜底；WS DTO 不变。落库后追加 `segments_presented` 和交互结果事件。

## 8. 小模型 prompt

### 意图分类

输入只有当前孩子话术；`temperature=0`、`maxTokens=10`，要求只返回一个标签。泛化故事与每日冒险的区分只表达语义，是否允许进入由 `DailyRecord` 决定。

### 互动接话（`buildAdventureInteractionPrompt`）

输入：由 `Device.characterKey` 选择的角色人设、交互点引导词、孩子回答、处置类别。硬约束：

1. 只输出 1-2 句口语化中文，符合角色口癖；
2. 禁止续写、改写或剧透主线；
3. 禁止连续追问、禁止批评纠正孩子；
4. 跑题引回时先接住孩子话题一句，再引回交互问题；
5. 内容不适宜时输出固定安全话术。

模型走 `SMALL_LLM_*`（qwen-flash）；分类失败走关键词兜底，接话失败走 `fallbackText`。

## 9. 测试覆盖与验证

- 开集、个人顺序选集、完成后禁止重播、未发布集不跳过、跨天续玩同一集；
- 旁白推进、二选一、开放提问、跟读、奖励、首次跑题引回、第二次兜底、明确退出；
- 10s 超时、ACK 后计时、竞态、重启 sweep、设备隔离；
- 意图分类调用、完成后自由故事／英语故事路由、chunk 顺序与逐次 ACK；
- e2e 完整一集：分配 → 开集 → 回答 → 接话 → 超时 → 完集，并核查 `Progress + DailyRecord + Event + Message`。

```bash
npm run test -- --runInBand
npm run test:e2e -- --runInBand --forceExit
npm run lint -- --quiet
npx tsc --noEmit
npm run build
npx prisma validate --schema=src/prisma/schema.prisma
```

## 10. 本轮文件清单

- `src/prisma/schema.prisma`：每集进度、每日档案、事件模型及关系；
- `src/prisma/migrations/20261029213000_adventure_daily_history/migration.sql`：旧数据回填后切换约束；
- `src/modules/adventure/adventure.service.ts`：选集、续玩、门禁、事务完集与审计事件；
- `src/modules/vendor/vendor.service.ts`：小模型意图分类、完成门禁与其他故事路由；
- 对应单测与 `test/adventure-stream.e2e-spec.ts`：TDD 覆盖上述行为；
- `test/vendor-stream.e2e-spec.ts`、`test/vendor.e2e-spec.ts`：仅对齐新 Prisma mock。

所有改动保持未提交；不 commit/push 除非明确要求。
