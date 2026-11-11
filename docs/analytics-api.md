# Deda Dashboard 内部分析接口契约（analytics 模块）

> 适用范围：deda-dashboard（内部数据看板），与小程序 C 端接口物理隔离。
> 实现：deda-server `src/modules/analytics/`，路由前缀 `/analytics/*`。
> 统一约定：响应信封 `{ code, message, data }`，`code=0` 成功；camelCase；ISO 8601 时间；
> 日期参数一律 `YYYY-MM-DD`、闭区间、Asia/Shanghai；**所有接口均为 GET**。
> 口径标注：`estimated` = 估算（每条 user 消息 × 0.5 分钟）；`proxy` = 代理指标；未标注 = 精确计数。

## 鉴权

管理员 JWT 与小程序 JWT 物理隔离：独立 secret（`ANALYTICS_JWT_SECRET`）、payload 必须带 `scope: "analytics"`。
一期账号来源为环境变量白名单 `ANALYTICS_ADMIN_USERS`（JSON 数组，scrypt 哈希，格式见 `.env.example`）。

```
GET /analytics/auth/login?username=&password=
→ { token, adminInfo: { username, displayName } }

GET /analytics/auth/profile   (Authorization: Bearer <token>)
→ { username, displayName }
```

错误码：401 未登录 / 凭据错误；403 token 非 analytics scope；400 参数非法（日期格式、metrics、granularity、范围倒置）。

## 总览（P1）

```
GET /analytics/overview?date=            (缺省=昨天 T-1)
→ {
    date,
    totals: { devicesRegistered, devicesActivated, usersRegistered, activationRate },
    today:  { dau, dauDeltaPct, avgDurationSecondsPerActiveDevice,  // estimated
              avgTurnsPerActiveDevice,
              devicesPoweredOn, powerOnRate, onlineNow },           // 一期恒 null（二期落库）
    retention: { d1, d7, d30 },          // 激活日为 date-N 的 cohort 在 date 的活跃率；分母为 0 时 null
    funnel: { shipped, activated, firstConversation, active7d }     // shipped 一期恒 null
  }
```
- 激活率分母：无出货数据时退化为已入库设备数（devices 全量）。

```
GET /analytics/overview/trend?startDate=&endDate=&granularity=day&metrics=dau,avgDuration,newActivated&characterKey=
→ { startDate, endDate, granularity, series: [{ date, dau, avgDurationSeconds, devicesPoweredOn, newActivatedDevices, newUsers }] }
```
- metrics 可选值：`dau, avgDuration, poweredOn, newActivated, newUsers`，逗号分隔多选，缺省全量；非法值 400。
- 无数据日期补零；week 粒度按 ISO 周（周一）聚合，month 按自然月；devicesPoweredOn 一期恒 null。
- characterKey 过滤按设备型号（elly/polly）。

## 留存与激活（P2）

```
GET /analytics/retention/cohorts?startDate=&endDate=&granularity=week&basis=activation
→ { basis, granularity, cohorts: [{ cohort: "2026-W41", size, retention: [{ n, rate }] }] }
```
- basis：`activation`=首次绑定；`firstUse`=首次 user 消息（解绑后仍可追溯）。
- n=0 恒为 1；n 为激活后第 n 天/周仍有 user 消息。
- 注意：activation 口径基于当前绑定记录，设备解绑后会从 cohort 消失（二期落 activation 快照表后冻结）。

```
GET /analytics/retention/curve?cohortStartDate=&cohortEndDate=
→ { points: [{ day: 1|3|7|14|30|60|90, rate }], cohortSize }
```
- 仅激活满 N 天的设备计入该点分母；无合格设备时 rate=null。

```
GET /analytics/activation/funnel?startDate=&endDate=
→ { steps: [{ key, label, value }], conversionRates: [{ from, to, rate }] }
```
- steps：shipped(null) → activated → first_conversation → active_d7 → active_d30。

## 使用行为（P3）

```
GET /analytics/engagement/summary?startDate=&endDate=
→ { activeDevices, avgDurationSecondsPerDevice, durationP50Seconds, durationP90Seconds,  // estimated
    avgTurnsPerDevice, turnsP50, avgActiveDaysPerDevice, totalTurns }

GET /analytics/engagement/duration-distribution?date=      (缺省=昨天，estimated)
→ { date, buckets: [{ range: "0-5min|5-15min|15-30min|30-60min|60min+", devices }] }

GET /analytics/engagement/hourly-heatmap?startDate=&endDate=
→ { grid: [[7 行（周一=0）× 24 列活跃设备数]], maxValue }

GET /analytics/engagement/mode-usage?startDate=&endDate=
→ { series: [{ date, modes: [{ mode, conversationModeKey, turns, devices }] }] }
   // 口径与小程序 learning-stats/mode-usage 一致（role=user 按 mode 聚合）

GET /analytics/engagement/feature-adoption?date=
→ { date, features: [
    { key: "sleep_mode",  label: "哄睡",     enabledDevices, penetrationRate },
    { key: "adventure",   label: "冒险故事", activeDevices, penetrationRate, completionRate },
    { key: "habit_plan",  label: "习惯打卡", activeDevices, penetrationRate, avgCompletionRate },
    { key: "english",     label: "英语对话", activeDevices, penetrationRate } ] }
```
- 渗透率分母 = 已激活设备（有绑定关系去重）；english/adventure 按近 30 天活跃口径。

## 用户画像（P5）

```
GET /analytics/users/summary?startDate=&endDate=   (范围同时提供才返回 newUsersInRange，否则 null)
→ { totalUsers, newUsersInRange, usersWithBoundDevice, avgDevicesPerUser, multiChildFamilies }

GET /analytics/users/demographics
→ { ageDistribution: [{ range: "0-3|3-6|6-9|9+|unknown", devices }],
    genderSplit: { male, female, unset },
    characterKeySplit: [{ characterKey, devices }],
    bindingsPerDevice: [{ count: 1|2|"3+", devices }] }
```
- PII 红线：只出年龄段与计数，不出姓名、生日、openid。

## 内容与质量（P6）

```
GET /analytics/content/adventure?startDate=&endDate=
→ { startedDevices, completedEpisodes, completionRate, avgStarsPerEpisode,
    topEpisodes: [{ episodeId, title, completions, avgStars }] }

GET /analytics/content/learning?startDate=&endDate=
→ { totalNewWords, avgNewWordsPerActiveDevice, speakCountTotal, habitPlansActive, habitCompletionRate }

GET /analytics/content/parent-report?startDate=&endDate=
→ { generated, failed, successRate, feedbackTotal, usefulRate }

GET /analytics/quality/conversation?startDate=&endDate=&granularity=day
→ { granularity, series: [{ date, totalTurns, failedTurns, failureRate, safetyBlockedTurns, safetyRate }] }
   // totalTurns=role=user 消息数；failedTurns=assistant status=failed；安全拦截=rawPayload 含 safetyCategory
```

## 模型监控（LLM）

数据源 `llm_usage_logs`：`LlmService.complete()/completeStream()` 单点埋点（fire-and-forget，
写库失败只记日志不影响主链路）。scene 枚举：safety_l2 / intent_classify / filler /
adventure_interaction / memory_extract / sleep_config_extract / sleep_story_generate /
chat_main / parent_report。failureReason 枚举：timeout / rate_limit / parse_error /
upstream_error / empty_response（空响应视为失败）。

```
GET /analytics/llm/summary?startDate=&endDate=
→ { scenes: [{ scene, tier, calls, successRate,
               p50LatencyMs, p90LatencyMs,
               p50FirstTokenMs, p90FirstTokenMs,   // 仅流式场景有值，否则 null
               totalTokens,
               failureBreakdown: [{ reason, count }] }] }
   // 只返回区间内有调用的场景；分母 0 时 successRate=null；分位数用 percentile_cont 口径

GET /analytics/llm/trend?startDate=&endDate=&granularity=day&scene=
→ { granularity, series: [{ date, calls, successRate, p50LatencyMs,
                            avgFirstTokenMs, p50FirstTokenMs, p90FirstTokenMs,
                            totalTokens }] }
   // granularity: day/week/month；scene 缺省=全部聚合，非法值 400；无数据日期补零（比率与分位数 null）
   // p50FirstTokenMs/p90FirstTokenMs：首包分位数（percentile_cont），仅流式场景有样本

GET /analytics/llm/turn-handoff?startDate=&endDate=&gapThresholdMs=0
→ { turnsWithChat, turnsWithBoth, turnsMissingFiller, turnsUnknown,
    gapThresholdMs, gapP50Ms, gapP90Ms, gapRate,
    topGaps: [{ turnId, gapMs, createdAt }] }
   // 轮次衔接健康度（防死空气，生成侧口径）：按 turnId join 同轮 filler 与 chat_main，
   // gapMs = chat_main 首包时刻 − filler 生成完成时刻；gap > 阈值记空窗，gapRate = 空窗轮数/双样本轮数
   // turnsMissingFiller：有 chat_main 但无 filler（filler 静默降级）的轮数，本身是待盯信号
   // turnsUnknown：两者都有但 chat_main.firstTokenMs 为 null；topGaps 按 gapMs 倒序取前 10
   // 口径警示：生成侧时刻 ≠ 设备播放侧真实死空气（filler 播放时长不在 llm_usage_logs）

GET /analytics/llm/slow-calls?startDate=&endDate=&scene=&limit=20
→ { items: [{ id, scene, tier, model, latencyMs, firstTokenMs, totalTokens,
              turnId, deviceId, createdAt }] }
   // 慢调用长尾（仅 success=true 且 latencyMs 非空），latencyMs 倒序；limit ≤ 50；
   // 失败调用由 recent-failures 覆盖；deviceId 为业务设备 ID，匿名/后台调用为 null

GET /analytics/llm/recent-failures?page=1&pageSize=20&scene=
→ { total, page, pageSize,
    items: [{ id, scene, tier, model, failureReason, latencyMs, turnId, deviceId, createdAt }] }
   // createdAt 倒序；pageSize ≤ 100；deviceId 为业务设备 ID，匿名/后台调用为 null；
   // turnId 为对话轮次 ID（可跳消息明细 ?turnId=），后台任务/存量数据为 null

GET /analytics/llm/by-turn?turnId=
→ { turnId,
    calls: [{ id, scene, model, tier, success, failureReason,
              latencyMs, firstTokenMs,
              promptTokens, completionTokens, totalTokens, createdAt }] }
   // 单轮调用链路：createdAt 升序；turnId 为 messages.turn_id（一轮问答一个 ID，
   // 安全/意图/filler/主回答/记忆提取共用）；无记录返回空 calls，不报错；
   // 后台任务（parent_report / sleep_*）无轮次上下文，turn_id 恒 null，本接口查不到
```

`llm_usage_logs.turn_id`（可空，带索引）：对话链路的 turnId 由 `VendorService.handleTextIn`
在入口生成并贯穿同轮全部 LLM 调用与消息落库；冒险状态机超时推送等非对话场景不落 turnId。

（原 `GET /analytics/quality/llm-usage` 501 占位接口已随本批下线。）

## 消息明细（P1.5）

```
GET /analytics/messages
  ?startDate=&endDate=&deviceId=&role=&status=&mode=&conversationModeKey=
  &turnId=&conversationId=&keyword=&sort=spokeAt_desc&page=1&pageSize=20
→ { total, page, pageSize,
    items: [{ id, turnId, conversationId, role, content, status, mode,
              conversationModeKey, cefrLevel, spokeAt, createdAt,
              device: { deviceId, deviceCode, characterKey } }] }
   // 列表不含 rawPayload；deviceId 为业务设备 ID（内部 resolve 成 UUID）；
   // spokeAt 区间闭区间、Asia/Shanghai 当日边界；keyword 大小写不敏感 ≤50 字；
   // sort 白名单仅 spokeAt_asc / spokeAt_desc；范围倒置 / 非法枚举 / pageSize 越界 → 400
   // status 枚举：completed / failed / interrupted（interrupted=被打断，推断口径见下）

GET /analytics/messages/modes?startDate=&endDate=
→ { categories: [{ key, name, messageCount,
                   modes: [{ key, name, messageCount }] }] }
   // 对话模式选项源（供过滤下拉）：配置表 conversation_mode_categories/conversation_modes
   // 全量启用项（sortOrder 升序）+ 区间内消息数（spokeAt 口径，仅参考，0 也返回）；
   // 分类 messageCount 按顶层 mode 统计（含无子模式的消息），子模式按 conversationModeKey

GET /analytics/messages/interruption-rate?startDate=&endDate=
→ { assistantTotal, interrupted, interruptionRate,
    byMode: [{ mode, assistantTotal, interrupted, interruptionRate }] }
   // AI 回复打断率：分母 = assistant 消息总数，分子 = status=interrupted；
   // mode 为 null 的历史消息归入 "(unknown)"；分母 0 时比率为 null

GET /analytics/messages/:id
→ 整行全部字段，含 rawPayload 原样 JSON；id 不存在 → 404
```

打断判定（`interrupted`）为**服务端推断口径**（`common/interruption/interruption.util.ts`，
非设备真实事件），由两个互补机制覆盖完整时间线：

1. **新轮开始标记**（`markPreviousReplyInterrupted`）：新一轮对话开始时，若该设备
   上一轮 assistant 回复的估算播放窗口（content 字数 × 120ms，封顶 60s）尚未结束，
   则把上一轮标记为 interrupted——覆盖「已落库 completed、TTS 播放中被打断」。
2. **落库时判定**（`wasSupersededByNewerTurn`）：assistant 回复在 LLM 完整生成后才
   落库；落库前若该设备已存在更新的 user 消息（本轮生成期间孩子又开口），说明回复
   未及完整播报即被打断，直接落库 interrupted——覆盖「LLM 生成期间被打断」。
   LLM 失败时 failed 优先于 interrupted；判定查询失败降级 completed，不阻塞落库。

vendor（/vendor/text）与 llm-adapter（百度 RTC 直连）两条链路均已接入；
新轮开始标记为 fire-and-forget 不阻塞首音。状态单调收敛：任何路径都不会把
interrupted 改回 completed。孩子话密/家长插话都会计入，dashboard 展示须标注「疑似」。

## 设备运维（admin 手动操作）

> 例外：本节为写操作（POST），不适用上文「所有接口均为 GET」的约定。

```
POST /analytics/devices/:deviceId/wipe
→ { success, deviceId, deviceOnline }
```

- 用途：退货／设备流转。admin 拿到机芯后手动触发。
- 行为：先经机芯厂 MQTT 协议向设备下发 `recover`（恢复出厂），再删除 Device 记录；
  设备关联的绑定、对话消息、孩子档案、长期记忆、配置等随删除级联清除
  （schema 全部 `onDelete: Cascade`）。设备重新配网上报 `loginMac` 后作为全新设备入库。
- `deviceOnline=false` 表示下发时设备离线，`recover` 可能未送达，admin 需到手后手动复位设备。
- 设备不存在 → 404。家长小程序解绑（DELETE /devices/:id）不触发本流程，仅删绑定关系。

## 二期预告（需 schema 审批）

- `device_presence_daily`：MQTT DEVICE_STATUS 旁路落库 → 开机率 / onlineNow / fleet 接口。
- ~~`llm_usage_logs`：token 落库~~ 已上线（见「模型监控」）。注：DeepSeek 主网关流式是否返回 usage 待复验，拿不到则 token 字段为 null，不影响其他字段。
- `admin_users` 表替换 env 白名单；activation 快照表冻结历史 cohort。
