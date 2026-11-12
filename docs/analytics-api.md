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

## 反馈与日报（用户详情页）

```
GET /analytics/feedback/parent-reports?startDate=&endDate=&isUseful=&deviceId=&page=&pageSize=
→ { total, page, pageSize,
    summary: { usefulCount, notUsefulCount, usefulRate },
    items: [{ id, reportDate, isUseful, feedbackAt, user: { nickname, phone } | null,
              device: { deviceId, deviceCode, characterKey },
              report: { reportDate, generationStatus, expressionObservation,
                        emotionObservation, thinkingObservation, suggestion, generatedAt } }] }
   // 日期区间按 reportDate；summary 为区间内整体有用率，不受 isUseful 过滤影响；
   // report 为该反馈对应的日报内容（同设备同 reportDate）；deviceId 为业务设备 ID，
   // 查不到设备返回空页（summary 清零）

GET /analytics/feedback/user-feedbacks?startDate=&endDate=&hasContact=&deviceId=&page=&pageSize=
→ { total, page, pageSize,
    items: [{ id, content, contact, createdAt, user: { nickname, phone } | null }] }
   // 日期区间按 createdAt；deviceId 经 UserDeviceBinding 反查该设备全部绑定账号的反馈；
   // 设备不存在或无绑定用户返回空页

GET /analytics/parent-reports?deviceId=&page=&pageSize=   (deviceId 必填)
→ { total, page, pageSize,
    device: { deviceId, deviceCode, characterKey },
    items: [{ reportDate, generationStatus, expressionObservation, emotionObservation,
              thinkingObservation, suggestion, generatorModel, generatedAt,
              feedbacks: [{ isUseful, feedbackAt, user: { nickname, phone } }] }] }
   // 单设备日报列表，按 reportDate 倒序；generationStatus 非 completed 的行也返回
   // （观察字段为空），便于排查生成失败；设备不存在 404；
   // feedbacks 为该日报的家长反馈（多个绑定账号可分别评价 → 数组，无反馈为 []），
   // feedbackAt=updatedAt（家长可改票，取最新状态时间）
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

GET /analytics/llm/cost-daily?startDate=&endDate=
→ { currency: "CNY",
    pricing: { version, peakNote,
               lines: [{ model, band, kind, tierLabel, label, cnyPerMillionTokens }] },
    range: { startDate, endDate, requestedStartDate, requestedEndDate, clamped, days },
    sources: {
      aliyun:   { status: "ok"|"no_data"|"unconfigured", kind: "bill",
                  latestBillDate, latestFetchedAt, modelSplit, daysWithData, message },
      deepseek: { status: "ok", kind: "estimated", pricingVersion,
                  rows, pricedRows, cacheHitRows, upperBoundRows, cacheTokenAvailable } },
    series: [{ date, smallCny, mainCny, otherCny, totalCny,
               smallTokens, mainTokens,
               smallCnyPerMillionTokens, mainCnyPerMillionTokens,
               smallSource: "bill"|"none", mainSource: "estimated"|"none",
               mainAccuracy: "exact"|"upper_bound"|"mixed"|null, settled }],
    totals: { smallCny, mainCny, otherCny, totalCny, partial, days,
              unpricedRows, noTokenRows, unpricedTokens },
    month: { cycle, daysInCycle, daysWithData,
             toDateCny|null, toDateSmallCny|null, toDateMainCny|null,
             projectedEndCny|null, prevSamePeriodCny|null, deltaPct|null, partial },
    unitEconomics: [{ model, tier, source: "bill"|"estimated", cny, tokens, pricedTokens,
                      cnyPerMillionTokens, tokenActiveDevices, daysWithData,
                      cnyPerDevicePerDay, unpricedRows, noTokenRows }],
    reconciliation: { status: "ok"|"insufficient", days,
                      smallEstimatedCny, smallBilledCny, deltaPct } }
   // 金额单位元（库内为 micro-CNY 整数，1 元 = 1e6，出参保留 6 位小数）
   // endDate 服务端强制钳到「昨日」（Asia/Shanghai），startDate 随之不超过 endDate，
   //   clamped/range 回显实际区间；区间上限 366 天，超限或日期非法/倒置 400
   // 拿不到数据 ≠ ¥0：账单缺日 smallCny=null（前端断点），主模型当天全未计价 mainCny=null，
   //   缺源时 totals.partial=true，前端必须标注「合计不完整」
   // mainAccuracy：exact=当天全部行有缓存命中数；upper_bound=全缺（金额是上界，实测可高估十几倍）；
   //   mixed=部分缺；null=当天无已计价行
   // sources.aliyun.status=unconfigured（未配凭证）/no_data（配了但区间内无账单行）时小模型金额全为 null
   // modelSplit=false 表示账单解析不出模型名 → 小模型口径降级为「百炼账号合计」，message 说明
   // month 块跟随「昨日所在账期」，与请求区间解耦：toDateCny 是本月至今，projectedEndCny 按
   //   有数据天数 run-rate 外推，prevSamePeriodCny 为上月 1 日至同一日
   // month 的拿不到数据 ≠ ¥0 是逐字段判定的：账期内无账单行 → toDateSmallCny=null；无已计价
   //   主模型行 → toDateMainCny=null；两者都无 → toDateCny/prevSamePeriodCny/projectedEndCny=null。
   //   反之「有数据源但金额为 0」（如全额被代金券抵扣）必须仍是 0，不得退化成 null
   // month.partial 与 totals.partial 同一套口径（缺账单或缺主模型埋点即 true），但窗口是
   //   「昨日所在账期」而非请求区间，两者可能不一致，各自描述自己的窗口
   // sources.deepseek.cacheTokenAvailable = 「区间内是否有行拿到缓存命中数」（cacheHitRows>0）。
   //   pricedRows=0 时它必然为 false，但那时一行都没计价、不存在估算，消费方不得据此判定「上界」；
   //   判上界请用 pricedRows>0 && (mainAccuracy 含 upper_bound/mixed)
   // reconciliation 只比已终账（settled=true）的账单日：小模型 token 估算 vs 账单真值；
   //   无已终账日 → status=insufficient、deltaPct=null；账单为 0 时 deltaPct=null（不除零）
   // unitEconomics.tokenActiveDevices 是「有 token 埋点的去重设备数」（llm_usage_logs.deviceId），
   //   不等于活跃设备数；cnyPerDevicePerDay 的分母是该模型有调用的天数
   // pricing.lines 是官网定价明细（唯一来源 llm-cost.util.ts，前端参考线不得另写价格常量）

POST /analytics/llm/cost/sync
→ { status: "ok"|"unconfigured"|"error", latestBillDate, syncedAt, message,
    days: [{ billDate, status, upserted, message }] }
   // 写操作例外（同「设备运维」节）：手工触发阿里云账单补拉 T-1..T-N，按 dedupeKey 幂等 upsert，
   // 重复调用不会追加行、不会放大金额；未配置凭证返回 unconfigured 且不写库
```

`llm_usage_logs.turn_id`（可空，带索引）：对话链路的 turnId 由 `VendorService.handleTextIn`
在入口生成并贯穿同轮全部 LLM 调用与消息落库；冒险状态机超时推送等非对话场景不落 turnId。

（原 `GET /analytics/quality/llm-usage` 501 占位接口已随本批下线。）

### 费用口径（cost-daily 的数据来源）

两条源，语义不同，页面上必须区分标注：

| 口径       | 来源                                                          | 精度                                             |
| ---------- | ------------------------------------------------------------- | ------------------------------------------------ |
| 小模型金额 | 阿里云 BSS `DescribeInstanceBill` → `llm_cost_daily`（应付 PretaxAmount） | 账单真值；延迟 24h 出账，当月为暂估，次月 3 日 12 点后终账 |
| 主模型金额 | `llm_usage_logs.costMicroCny`（写库时按当时定价快照）          | 估算；缺缓存命中数时是上界                       |

- 埋点：`LlmService.logUsage()` 落 `cacheHitInputTokens` 与 `costMicroCny`。DeepSeek 实测
  `prompt_cache_hit_tokens + prompt_cache_miss_tokens === prompt_tokens`（命中数已含在 prompt_tokens 内），
  故计价按 miss × 未命中价 + hit × 命中价；对 prompt_tokens 整体套未命中价会重复计费，实测高估约 15.8 倍。
- 计价常量在 `src/modules/llm/llm-cost.util.ts`（`PRICING_VERSION`），刻意不放 env：口径要可追溯。
  调价即升版本并发版；已落库的历史金额不变，需要时用 `scripts/backfill-llm-cost.ts --force` 重算。
- 峰谷按北京时间工作日 9:00-12:00 / 14:00-18:00 判定，法定节假日表未维护 → 节假日按高峰计（略微高估）。
- 账单同步：`BillingSyncService`（`LLM_COST_SYNC_ENABLED=true` 开启，默认关），每 6h 补拉 T-1..T-3；
  历史一次性灌入用 `scripts/backfill-aliyun-bill.ts`（`--probe` 可探测百炼 ProductCode）。
  凭证：`ALIYUN_BSS_ACCESS_KEY_ID/SECRET`（本地/staging）或 `ALIYUN_BSS_USE_RAM_ROLE=true`（生产走 ECS 实例角色，密钥不落盘）。
- `cacheHitInputTokens IS NULL` 即「上界估算」标记；回填脚本对历史行只能按未命中价算，
  因此老数据的 `mainAccuracy` 多为 `upper_bound`，前端用虚线 + Tag 区分。

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
非设备真实事件）：新一轮对话开始时，若该设备上一轮 assistant 回复的估算播放窗口
（content 字数 × 120ms，封顶 60s）尚未结束，则把上一轮标记为 interrupted。
vendor（/vendor/text）与 llm-adapter（百度 RTC 直连）两条链路入口均已接入，
fire-and-forget 不阻塞首音；孩子话密/家长插话都会计入，dashboard 展示须标注「疑似」。

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
- ~~`llm_usage_logs`：token 落库~~ 已上线（见「模型监控」）。~~DeepSeek 主网关流式是否返回 usage 待复验~~ 已复验（2026-11-12）：主模型 87/87 行均有 token，且回传 `prompt_cache_hit_tokens`，费用口径见「模型监控 → 费用口径」。
- `admin_users` 表替换 env 白名单；activation 快照表冻结历史 cohort。
