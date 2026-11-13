# Deda Dashboard 内部分析接口契约（analytics 模块）

> 适用范围：deda-dashboard（内部数据看板），与小程序 C 端接口物理隔离。
> 实现：deda-server `src/modules/analytics/`，路由前缀 `/analytics/*`。
> 统一约定：响应信封 `{ code, message, data }`，`code=0` 成功；camelCase；ISO 8601 时间；
> 日期参数一律 `YYYY-MM-DD`、闭区间、Asia/Shanghai；**分析类接口均为 GET**
> （写操作只出现在「设备运维」与「冒险内容管理」两节，各自在节首声明）。
> 口径标注：`estimated` = 估算（每条 user 消息 × 0.5 分钟）；`proxy` = 代理指标；未标注 = 精确计数。

## 鉴权

管理员 JWT 与小程序 JWT 物理隔离：独立 secret（`ANALYTICS_JWT_SECRET`）、payload 必须带 `scope: "analytics"`。
一期账号来源为环境变量白名单 `ANALYTICS_ADMIN_USERS`（JSON 数组，scrypt 哈希，格式见 `.env.example`）。

`ANALYTICS_ADMIN_USERS` 里每个账号可带可选的 `scopes` 数组，声明该账号能碰哪些**专项模块**；
签发时写入 JWT 的 `scopes` 声明，缺省为 `["analytics"]`。目前唯一的专项作用域是
`adventure-content`（冒险内容管理台）——没有它的账号对 `/analytics/adventure-admin/*`
**连读都是 403**。本次改动之前签发的 token 没有 `scopes` 字段，会被补成 `["analytics"]`，
即「重新登录之前拿不到内容权限」。

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
              devicesPoweredOn, powerOnRate, onlineNow },           // onlineNow=实时在线台数（Redis 15s 窗口）；devicesPoweredOn=当日开机台数、powerOnRate=开机数/已激活数（源自 device_presence_daily）
    retention: { d1, d7, d30 },          // 激活日为 date-N 的 cohort 在 date 的活跃率；分母为 0 时 null
    funnel: { shipped, activated, firstConversation, active7d }     // shipped 一期恒 null
  }
```

- 激活率分母：无出货数据时退化为已入库设备数（devices 全量）。
- `devicesPoweredOn` / `powerOnRate` 取自 `device_presence_daily`（**天级**）：早于该表落库首日的日期返回 **null（无数据）** 而非 0（零台开机），避免把功能未上线误读成设备全离线；`powerOnRate` 分母为已激活设备数，分母为 0 时为 null。
- `onlineNow` 是**实时**口径（Redis `lastSeenAt` 落在 15 秒窗口内），与天级的 `devicesPoweredOn` 不是同一口径，二者不可互相校验。

```
GET /analytics/overview/trend?startDate=&endDate=&granularity=day&metrics=dau,avgDuration,newActivated&characterKey=
→ { startDate, endDate, granularity, series: [{ date, dau, avgDurationSeconds, devicesPoweredOn, newActivatedDevices, newUsers }] }
```

- metrics 可选值：`dau, avgDuration, poweredOn, newActivated, newUsers`，逗号分隔多选，缺省全量；非法值 400。
- 无数据日期补零；week 粒度按 ISO 周（周一）聚合，month 按自然月。
- `devicesPoweredOn` 取自 `device_presence_daily`，按桶内**去重设备数**聚合；早于落库首日的桶为 null（非 0），故跨上线时点的 week/month 桶数值会偏小。
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

| 口径       | 来源                                                                      | 精度                                                       |
| ---------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 小模型金额 | 阿里云 BSS `DescribeInstanceBill` → `llm_cost_daily`（应付 PretaxAmount） | 账单真值；延迟 24h 出账，当月为暂估，次月 3 日 12 点后终账 |
| 主模型金额 | `llm_usage_logs.costMicroCny`（写库时按当时定价快照）                     | 估算；缺缓存命中数时是上界                                 |

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

## 判定质量监控（decisions）

数据源 `turn_decision_logs`：`LlmAdapterService.streamReply()` 在每个编排出口埋点
（fire-and-forget upsert on `turnId`，写库失败只记日志不影响对话）。

与「模型监控（LLM）」的分工：`llm_usage_logs` 回答**模型调用健康吗**（成功率/延迟/token/费用），
本组接口回答**模型的判定可信吗**（拦了多少、放行里有多少其实没审、意图有多少是关键词兜底兜出来的）。
两者按 `turnId` 可互查。

`safetySource` 枚举（**看板必须按它分桶，不能按 safetyCategory**，否则 safe 与 fail-open 混成一桶）：

| 值                 | 含义                                              | 是否放行 | 处置                           |
| ------------------ | ------------------------------------------------- | -------- | ------------------------------ |
| `l1_regex`         | L1 正则闸命中                                     | 否       | 看 `safetyMatched` 查误伤      |
| `l2_model`         | 小模型给出合法标签（含 `safe`）                   | 视类别   | 正常                           |
| `l2_invalid_label` | 小模型有响应但标签不在契约内 → 放行               | 是       | **静默降级**，升高=prompt 退化 |
| `l2_fail_open`     | 小模型调用异常 → 放行，靠 L3 大模型 prompt 兜底   | 是       | **静默降级**，升高=模型不可用  |
| `not_evaluated`    | 本轮根本没做 L2（冒险状态机在编排上早于 L2 接管） | 是       | **已知盲区**，见下方警示       |

> ⚠️ 盲区警示：编排顺序是 L1 → 冒险接管 → `Promise.all([L2, intent])`，
> 所以**冒险互动轮次完全绕过 L2**，只有 L1 正则兜着，而 L1 刻意不收「杀/打/揍/枪/刀/去死」
> 这类孩子的气话（见 `child-safety.service.ts` 头部校准原则）。本期按熊总决定**只监控不改行为**：
> `not_evaluated` + `adventure_takeover` 的占比就是这块盲区的暴露面。

> 口径警示：埋点在每个 `return` 之前而非 `finally`——`streamReply` 是 async generator，
> 消费方直接丢弃迭代器时 `finally` 不保证执行。代价是未捕获异常中断的轮次没有判定记录，
> 因此**判定记录数 ≤ 对话轮次数**，页面文案必须写明，不能把差值解读成「漏审」。

```
GET /analytics/decisions/safety-summary?startDate=&endDate=
→ { total, blockedCount, blockRate,
    byCategory: [{ category, count, blockedCount }],   // category 可为 null（未能判定），按严重度排序不按计数
    byLayer:    [{ layer, count }],                    // L1 / L2 / null
    bySource:   [{ source, count }],
    failOpenCount, invalidLabelCount, notEvaluatedCount,
    emotionalHarmCount,                                // 不拦截但注入共情引导，是行为改变点，单独可见
    reviewableCount }                                  // 留有原文、可进复核队列的条数
   // 分母 0 时 blockRate=null；emotional_harm 计入 total 但不计入 blockedCount

GET /analytics/decisions/safety-trend?startDate=&endDate=&granularity=day
→ { granularity, series: [{ date, total, blockedCount, blockRate,
                            failOpenCount, invalidLabelCount, notEvaluatedCount,
                            emotionalHarmCount }] }
   // granularity: day/week/month（week 周一起始）；无数据日期补零且比率为 null；
   // 日期边界按 Asia/Shanghai 切日，与其余 analytics 接口同口径

GET /analytics/decisions/intent-summary?startDate=&endDate=
→ { total,
    byIntent: [{ intent, count }],          // intent 为 null = 本轮没走到意图路由，按计数倒序
    bySource: [{ source, count }],
    modelInvokedCount, modelInvokedRate,    // source=model 的占比，跌了说明小模型在失效
    fallbackCount, fallbackRate,            // fallback_invalid_label + fallback_error
    notRoutedCount,                         // 被 L1/L2 拦截，未分类
    adventureTakeoverCount,                 // 冒险接管，未分类（与 not_evaluated 同一批轮次）
    matrix: [{ intent, source, count }] }   // intent × source 交叉，排查「说要听故事却在闲聊」用这张表
   // intentSource 枚举：model / fallback_invalid_label / fallback_error / pre_filter_skip（已停用，仅历史数据）/
   //   continuation / session_sticky / explicit_exit / force_sleep / sleep_window_closed /
   //   adventure_takeover / not_routed / no_device
   // 分母 0 时两个 rate 均为 null；no_device = 匿名链路，无会话状态可依赖，恒定 free_chat
   //
   // ⚠ modelInvokedCount 口径 = 「模型判定被直接采纳的轮次」（只数 source=model），
   //   不是「调用过模型的轮次」：session_sticky（模型判 free_chat 后维持原会话）与
   //   sleep_window_closed（模型判 sleep_story 后被哄睡时段门禁降级）都调过模型却不计入。
   //   小模型真实调用量与费用请看 intent_classify 场景的 LLM 成本指标，不要用本漏斗反推。
   // force_sleep / sleep_window_closed 属哄睡时段治理：前者未调模型直接覆写，
   //   后者是规则推翻模型判定；看板做「规则 vs 模型」分桶时两者都归规则侧，
   //   否则 routed = model + rule + fallback 的恒等式会破。详见 docs/conversation-routing.md。

GET /analytics/decisions/intent-trend?startDate=&endDate=&granularity=day
→ { granularity, series: [{ date, total, modelInvoked, fallbackCount,
                            byIntent: [{ intent, count }] }] }

GET /analytics/decisions/review-queue?startDate=&endDate=&category=&deviceId=&page=1&pageSize=20&sort=createdAt_desc
→ { total, page, pageSize,
    items: [{ turnId, deviceId, channel, createdAt, safetyLayer, safetyCategory,
              safetySource, safetyMatched, asrText, intent, intentSource }] }
   // 人工复核队列。恒定附加 asrText IS NOT NULL（服务端强制，调用方无法绕过）：
   //   只有「拦了」或「判成非 safe 类别」的轮次才留原文，正常轮次不积累儿童语料。
   // category 走白名单（sexual/self_harm/violence/emotional_harm/safe），拼错 400 而非静默返回空；
   // deviceId 是内部 UUID；sort 只允许 createdAt_desc/createdAt_asc；pageSize ≤ 100。
   // 本期只读：reviewLabel / reviewedAt 两列已建，写接口留待二期（见「二期预告」）。
   // asrText 是儿童语音转写 → 前端默认打码、点击展开，禁止直接投屏。
```

### 判定记录的留存策略

- **明细永久保留**，不设 TTL、不做预聚合表（安全审计与申诉回溯需要原始逐轮记录）。
- `asrText` 列宽 `VARCHAR(200)`，超长截断；任何日志（含落库失败的 warn）都不得携带。
- `deviceId` **刻意不设外键**：安全审计要保留设备标识，不随设备 wipe 级联删除。
- summary 走 Prisma `groupBy`（DB 侧聚合）；trend 走 `findMany` + 内存分桶，但 `select` 只取
  聚合必需的四列。不用 `$queryRaw` 做 DB 侧日期分桶：时区截断的正确性只有 e2e 能验证，
  而本期不为 analytics 增加 e2e，内存分桶可以纯单测覆盖。放开长区间前应先补 e2e。

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

## Fleet（舰队管理）

向运营/管理员提供全量设备舰队视图。详细规范见 `docs/fleet-analytics-spec.md`。

```
GET /analytics/fleet/summary?date=
→ { date, totalDevices, activatedDevices, devicesPoweredOn, powerOnRate,
    onlineNow, lowBatteryNow, lowBatteryThreshold, presenceSince }

GET /analytics/fleet/presence-trend?startDate=&endDate=
→ { startDate, endDate, presenceSince,
    series: [{ date, devicesPoweredOn, powerOnRate, reportCount }] }
   // 区间上限 62 天；每一天都出现

GET /analytics/fleet/firmware-distribution
→ { total, buckets: [{ firmwareVersion, devices }] }
   // null/空字符串 → "unknown"；unknown 排最后

GET /analytics/fleet/churn-risk?days=7
→ { days, asOf, count, devices: [{ deviceId, characterKey, firmwareVersion,
    lastActiveAt, daysInactive, basis }] }
   // days 范围 1–90；basis: presence | message | createdAt

GET /analytics/fleet/devices?keyword=&page=1&pageSize=20
→ { page, pageSize, total,
    items: [{ deviceId, deviceUuid, characterKey, deviceCode, firmwareVersion,
              macAddress, createdAt, boundUsers, realtime, presenceDays7d,
              lastPresenceDate, turns7d }] }
   // keyword ≤ 50 字符；pageSize 最大 100 静默 clamp；createdAt 降序

GET /analytics/fleet/devices/:deviceId?days=30
→ { deviceId, deviceUuid, characterKey, deviceCode, firmwareVersion,
    macAddress, wifiName, ipAddress, networkType, timezone, createdAt,
    realtime, boundUsers: [{ userId, isOwner, boundAt }],
    presence: [{ date, reportCount, firstSeenAt, lastSeenAt }],
    dailyTurns: [{ date, turns }],
    totals: { presenceDays, turns } }
   // days 范围 1–90；404 on missing；boundUsers 不含 PII
```

全局口径：
- **实时**：`onlineNow` / `realtime` — Redis 15s 窗口；失败 → null
- **天级**：`devicesPoweredOn` / `presenceDays7d` — `device_presence_daily` 表
- 低电量阈值固定 20（仅在线设备）
- `null` ≠ `0`：前端 `null` 渲染 `-`

## 冒险内容管理（Adventure Studio）

> 例外：本节大量为写操作（POST），不适用「分析类接口均为 GET」的约定。
> 实现：deda-server `src/modules/adventure-admin/`，路由前缀 `/analytics/adventure-admin/*`。
> 挂在这个前缀下是刻意的：dashboard 的 vite proxy 与 nginx 已整段转发 `/analytics`，
> 新增能力**不需要改任何部署配置**。

内容创作者在这里写「冒险故事」的每一集：草稿 → 校验 → 试播 → 发布 → 出问题回滚 → 彻底不用了下架。
孩子侧播放引擎（`src/modules/adventure/`）只读**已发布的版本快照**，两者不互相注入服务。

### 两道正交的权限闸

| 闸 | 跟着谁走 | 由什么决定 | 不满足时 |
| --- | --- | --- | --- |
| scope | 人 | JWT 的 `scopes` 是否含 `adventure-content` | 读写一律 403 |
| profile | 环境 | `CONTENT_ADMIN_PROFILE=authoring` | 只读；所有写操作 403 |

两者必须同时满足才能写。即使 prod 的账号白名单被误配成和 staging 一样，prod 依然写不动。
`CONTENT_ADMIN_PROFILE` **缺省 / 拼错 / 大小写不对一律按 readonly 处理**（fail-safe）：
漏配的后果是「作者被挡住」，不是「prod 意外可写」。

「写操作」按 HTTP 方法判定，**非 GET/HEAD/OPTIONS 一律视为写**。新增一个 POST 路由时忘记标注，
后果是它在只读环境被挡住，而不是 prod 上多出一个能改内容的口子。确实不写库的 POST
（`lint` / `simulate` / `import/preview`）用 `@ContentReadOnly()` 显式豁免——目前只有这三个，
`export` **不在其中**（它会落一条 `export` 审计）。

### 内容形状

```
identity = { characterKey: "elly"|"polly", season: 1, episodeNumber: number }
businessKey = "elly/1/3"        // 人可读、可手输确认，也是破坏性操作 confirmText 的比对目标

content = {
  title, recap?,
  segments: [{
    order,                      // 必须严格 0..n-1 连续，引擎用 order >= segments.length 判完集
    kind,                       // "narration" | "interaction"
    text,
    interactionType?,           // open_question | two_choice | repeat_after_me | reward
    options?,                   // two_choice 用 choices[{key,text,reply}]；repeat_after_me 用 praise
    fallbackText?, exitText?,   // 需要孩子开口的三种原语必须有兜底与退出话术
    rewardStar?
  }]
}
```

身份字段**不进内容哈希**，否则同样的内容在 staging 与 prod 会算出不同的 hash，导入就永远判成 replace。

### 读接口

```
GET /analytics/adventure-admin/capabilities
→ { season, characterKeys, interactionTypes, replyWaitingInteractionTypes, segmentKinds,
    lintThresholds, simulationThresholds, profile, authoring }
   // 编辑器启动时先拿这个：枚举、阈值、能不能写，全部由服务端说了算，前端不硬编码

GET /analytics/adventure-admin/episodes?characterKey=&published=&includeRetired=&search=&page=&pageSize=
→ { items: [EpisodeSummary], total }
   // EpisodeSummary: { id, characterKey, season, episodeNumber, businessKey, title, recap,
   //   published, retiredAt, currentVersionId, currentVersion, publishedAt,
   //   hasDraft, draftVersionId, draftVersion, draftUpdatedAt, draftUpdatedBy, createdAt, updatedAt }
   // 默认不含已 retire 的集；pageSize 最大 200

GET /analytics/adventure-admin/episodes/:episodeId
→ { summary, content, contentSource: "draft"|"published"|"empty", baseVersionId,
    baseDraftUpdatedAt, lint, impact }
   // content 是编辑器该加载的那一份：草稿优先，其次当前发布版，最后是空壳
   // baseVersionId + baseDraftUpdatedAt 是乐观锁基线（双令牌），存草稿时必须原样带回。
   //   baseDraftUpdatedAt 是当前草稿行的 updatedAt（ISO 串），没有草稿时为 null。
   //   之所以要两个：草稿是**可变行**，原地保存后 id 与 version 都不变，只比 id
   //   检测不到「我加载之后别人往同一行里又存了一次」，那种情况会静默互相覆盖。

GET /analytics/adventure-admin/episodes/:episodeId/versions
→ [VersionSummary]
   // { id, version, status: draft|published|superseded|discarded, contentHash, changeNote,
   //   createdBy, createdByName, publishedAt, publishedBy, supersededById,
   //   createdAt, updatedAt, title, segmentCount, isCurrent }

GET /analytics/adventure-admin/episodes/:episodeId/versions/:versionId
→ { meta: VersionSummary, content }

GET /analytics/adventure-admin/episodes/:episodeId/diff?left=&right=
→ { left, right, titleChanged, recapChanged, added, removed, changed, segmentDiffs }

GET /analytics/adventure-admin/episodes/:episodeId/impact
→ { devicesPlayingToday,        // 今日已分配且仍在播：retire 不会打断它们
    devicesStaleCrossDay,      // 跨天陈旧的在播设备：retire 会收走，下次开机换一集
    devicesPinnedToOlderVersions,  // 仍锁在旧快照上的在播设备：说明历史发布确实造成了并行版本
    totalDevicesEverStarted, publishedVersionCount }

GET /analytics/adventure-admin/audit?episodeId=&actorUsername=&action=&from=&to=&page=&pageSize=
→ { items: [{ id, action, entityType, episodeId, episodeVersionId, businessKey,
              actorUsername, actorDisplayName, profile, reason, detail,
              sourceBundleHash, createdAt }], total }
   // action: create | create_draft | update_draft | publish | revert | retire | restore
   //         | discard_draft | discard | export | import | import_noop | self_check_failed
```

### 校验与试播（不写库，只读环境同样可用）

```
POST /analytics/adventure-admin/lint
body { episodeId?, identity?, content, forPublish? }
→ LintReport { ok, issues, errors, warnings }
   // issue: { severity, code, message(中文), businessKey, segmentOrder?, path? }
   // path 形如 segments[2].options.choices[0].text，前端据此把错误定位到具体表单字段
   // forPublish=true 额外要求 1..n-1 集都已发布（PREDECESSOR_NOT_PUBLISHED）

POST /analytics/adventure-admin/simulate
body { identity, content }
→ { businessKey, recap, beats, totalSpokenChars, estimatedSeconds, awaitsReplyCount,
    totalStars, problems }
   // beats: [{ says, stopsAtOrder, waitsForReply, interactionType, starsAwarded,
   //          choices, praise, outcome }]
   // 时长估算按 4 字/秒；超过 maxAwaitPoints / maxSessionSeconds 会进 problems
```

阈值全部可用环境变量覆盖（`ADVENTURE_LINT_*` / `ADVENTURE_SIM_*`，见 `.env.example`），
`capabilities` 会把生效值回给前端。

### 写接口

所有写操作都要求 `reason`（**至少 8 个字**）：半年后别人（包括你自己）只能靠审计看懂当时为什么这么改。
破坏性操作额外要求 `confirmText`——原样输入业务键，抄错就是 400 `CONFIRM_TEXT_MISMATCH`。
理由与确认文本的错误一律由领域层给出，带 `code` 与中文说明，不是 class-validator 的通用 400。

```
POST /analytics/adventure-admin/episodes
body { identity, content, reason }
→ { episodeId, versionId, version, businessKey, contentHash, lint }
   // 只落草稿，不发布。业务键已被占用 → 400 CONTENT_REJECTED（lint code BUSINESS_KEY_TAKEN）；
   //   两个人并发抢同一集号、绕过 lint 撞上数据库唯一约束时 → 409 BUSINESS_KEY_TAKEN。
   // 集号被永久占用（见 discard）。

POST /analytics/adventure-admin/episodes/:episodeId/draft
body { content, reason, baseVersionId?, baseDraftUpdatedAt?, force? }
→ { episodeId, versionId, version, businessKey, contentHash, lint, created, draftUpdatedAt }
   // 乐观锁（双令牌）：baseVersionId 与库里草稿 id 不符，**或** baseDraftUpdatedAt 与库里
   //   草稿的 updatedAt 不符 → 409 DRAFT_CONFLICT，data 带 currentDraft{id, version,
   //   updatedBy, updatedAt}，前端提示「谁在你之前改过」。令牌解析不出来也算不符（fail closed）。
   //   force=true 才覆盖（UI 上是单独的红色按钮）。两个令牌都不带 = 明确不参与并发保护
   //   （只有导入链路这样：它在 import/preview 阶段有自己更强的闸——目标集存在别人
   //     未发布且内容不同的草稿时直接判 reject，不静默覆盖）。
   // 响应里的 draftUpdatedAt 是**下一次保存该带的新令牌**：编辑器必须改用它，
   //   否则会被自己刚存的那一次顶成 409（自己锁死自己）。

POST /analytics/adventure-admin/episodes/:episodeId/publish
body { reason }
→ { episodeId, versionId, version, businessKey, contentHash, segmentCount, lint,
    impact, selfCheckDrift }
   // 生成新的 published 快照并切换 currentVersion，旧快照转 superseded（历史不删）。
   // 已 retire 的集不能直接发布，必须先 restore。
   // selfCheckDrift: [] = 发布后自检无漂移；非空 = 库里的段与刚发布的内容不一致（只告警，
   //   不回滚，同时落一条 self_check_failed 审计）；null = 自检本身失败（已记日志）。

POST /analytics/adventure-admin/episodes/:episodeId/revert
body { targetVersionId, reason, confirmText }
→ { episodeId, versionId, newVersion, businessKey, revertedToVersionId, revertedToVersion,
    draftStillPending, lint, impact, selfCheckDrift }
   // 「快速回滚」= 把目标快照的内容复制成一个**新版本**再发布，历史一行都不改。
   // 目标必须是 published / superseded；跨集回滚 → 404。
   // 回滚不动未发布草稿，draftStillPending=true 时前端必须提醒创作者「你的草稿还在」。
   // 允许对已 retire 的集回滚（先修内容再决定要不要 restore）。

POST /analytics/adventure-admin/episodes/:episodeId/retire
body { reason, confirmText }
→ { episodeId, businessKey, retiredAt, impact, staleDailyCount, abandonedProgressCount, message }
   // 墓碑，不是删除。**当日在播的孩子完全不动**；只把 assignedDate < today 且仍 in_progress
   // 的当日记录收成 abandoned，对应设备进度也收成 abandoned，下次开机换一集。

POST /analytics/adventure-admin/episodes/:episodeId/restore
body { reason }
→ { episodeId, businessKey, abandonedProgressNotRestored, message }
   // 只撤销墓碑。当初被收成 abandoned 的进度**不会**被拉回来——那些孩子已经换到别的集了，
   // 硬拉回去等于让他们重听一遍开场。

POST /analytics/adventure-admin/episodes/:episodeId/discard-draft
body { reason }
→ { episodeId, businessKey, discardedVersionId, version }

POST /analytics/adventure-admin/episodes/:episodeId/discard
body { reason, confirmText }
→ { episodeId, businessKey, discardedDraftCount, message }
   // 只能作废**从未发布过**的集；发布过的集请走 retire。
   // 实现为墓碑 + 草稿转 discarded，业务键**永久占用**，不能拿同一个集号重来。
```

**本节没有任何 DELETE 路由**，服务层也没有 delete 方法（有结构性单测钉住这一点）。
staging 与 prod 的安全要求一致：内容只能被 retire / discard 成墓碑，不能物理删除——
审计、版本、以及可能还 pin 在旧快照上的进度都要有可追溯的落点。

### staging → prod 搬运

prod 是只读环境，内容只能在 staging 改好、验证过，再整包搬过去。

```
POST /analytics/adventure-admin/export
body { episodeIds?, characterKey?, includeRetired? }
→ { bundle, bundleHash, confirmToken, episodeCount, skipped: [{ businessKey, reason }] }
   // 只导**当前已发布快照**（currentVersionId 指向且 status=published）；草稿不进 bundle。
   // bundle.episodes[] 是扁平形状：{characterKey, season, episodeNumber, title, recap, segments}。
   // 什么都没导到 → 400 NOTHING_TO_EXPORT，data 带 skipped 说明每一集为什么被跳过。
   // bundleHash 只由 bundleSchemaVersion + episodes 决定，不含 exportedAt / sourceProfile，
   //   所以同一份内容在两个环境算出的 hash 一致。

POST /analytics/adventure-admin/import/preview        // dry-run，不写库、不审计
body { bundle }
→ { ok, bundleHash, confirmToken, parseErrors, parseWarnings, message,
    plan: { ok, bundleHash, items, adds, replaces, upToDate, rejects } }
   // items[]: { businessKey, action: add|replace|already_up_to_date|reject,
   //            incomingHash, existingHash, episodeId?, reason?, diff? }

POST /analytics/adventure-admin/import
body { bundle, reason, confirmText /* = confirmToken */, expectedBundleHash? }
→ { bundleHash, confirmToken, plan, written: [{ businessKey, action, episodeId, versionId, version }],
    skipped, message }
```

导入的闸门按顺序全部通过才写，任一不过**整批不写**：

1. `reason` 至少 8 个字；
2. 服务端**重新解析并重算** bundle（不信客户端传来的 plan / hash）；
3. `parseErrors` 非空 → 400 `BUNDLE_INVALID`；
4. `expectedBundleHash` 与重算结果不符 → 409 `BUNDLE_HASH_MISMATCH`（防「预览的是 A、提交的是 B」）；
5. `confirmText` 不等于本次 `confirmToken` → 400 `CONFIRM_TEXT_MISMATCH`；
6. `plan.ok` 为假（存在 reject）→ 400 `IMPORT_PLAN_REJECTED`。

会被判 reject 的情况：bundle 内业务键重复；目标集已 retire；目标集有**别人未发布的本地草稿**
且内容既不等于草稿也不等于当前发布版（错误消息会点名是谁的草稿）；**这一集一段可用段落都没有**
（bundle 里本来就是空的，或所有段落都因 `order`/`kind`/`text` 非法在解析时被丢弃，见 `parseWarnings`）；
内容过不了 lint 或会丢段。

拒绝空壳集是刻意的：空壳集自己发布不出去（lint `NO_SEGMENTS` 挡着），但一旦落地就成了
「目标环境有未发布草稿」，会让**之后每一次正常导入都卡住**，而且拒绝理由指向一个根本没人在写的草稿。
`already_up_to_date` 不算 reject，只是跳过——这让导入天然幂等：中途断了重跑一遍即可。

导入**只落草稿，永不自动发布**。prod 上的最后一步「让内容面对孩子」必须是人手动点发布，
搬运工具不该有能力悄悄改变线上播放内容。

### 自愈与兜底（recovery）

孩子那一侧的兜底分五层，越往后越「不依赖前一层还活着」：

| 层 | 触发点 | 行为 |
| --- | --- | --- |
| L0 | vendor gateway / controller 的任一异常 | 先发一句降级话术再发错误帧，孩子永远听得到一句话 |
| L1 | 引擎 `startToday` / `handleChildReply` / `checkTimeout` 抛错 | 记引擎失败 → `recoverToNextEpisode` → 返回下一集或最后一道兜底话术 |
| L2 | LLM 主链路（流式 / 非流式）抛错 | 零 chunk 才补兜底话术；已播半句只优雅收尾，绝不插话 |
| L3 | 恢复熔断器 | 10 分钟内 5 次兜底失败 → 标记 tripped + 告警，**不自动改任何内容** |
| L4 | 定时巡检（默认 60s） | 找出「连孩子开口那一刻都走不通」的静默病态并修成可自愈状态 |

```
GET  /analytics/adventure-admin/recovery              // 只读，只读环境同样可用
→ { breaker: { enabled, tripped, failureCount, degraded, trippedAt, windowMs,
               threshold, recentReasons, error },
    config: { enabled, sweepIntervalMs, staleAwaitMs, staleAwaitAction,
              breakerWindowMs, breakerThreshold, breakerTrippedTtlSeconds },
    sweeps: [SweepReport] /* 最近 20 份，新在前 */,
    engineFailures: [{ deviceId, phase, reason, recovered, at }] /* 最近 50 条 */ }

POST /analytics/adventure-admin/recovery/sweep        // 写操作：只读环境 403
body { reason }
→ { report: SweepReport, audited: boolean }

POST /analytics/adventure-admin/recovery/reset        // 写操作：只读环境 403
body { reason }
→ { ok: true, audited: boolean }
```

`SweepReport`：`{ startedAt, finishedAt, durationMs, skipped, reason, scanned:
{ progresses, dailyRecords, episodes }, repairs: [{ code, deviceId, ... }],
alerts: [{ code, detail, ... }], errors: [string] }`。

两个 POST 都会写一条审计（`action` = `recovery_sweep` / `recovery_breaker_reset`，
`entityType` = `recovery`，`businessKey` = `adventure/recovery`，`episodeId` 为空——
它们不针对某一集）。`reason` 与内容变更共用同一条规则：至少 8 字，否则 400
`REASON_REQUIRED`。`detail` 里的 `repairs` / `alerts` 各截断到 50 条，同时带
`repairCount` / `alertCount` 真实总数。审计写入是尽力而为：动作已经生效时不会因为
审计失败而把结果丢掉，改为回 `audited: false` 并记 error 日志，由前端显式提示「这次没留痕」。

熔断器是**授权回滚**：它只标记与告警，绝不自动改内容、绝不自动切版本。
`reset` 是人的动作——确认上游已恢复之后手动解除降级。`degraded: true` 表示
Redis 不可用，此时熔断器**故意不工作**（宁可漏报，也不能因为读不到计数就把
所有设备判成故障）。

巡检的安全边界（比「修得全」更重要）：**绝不改写内容**，**绝不调用
`recoverToNextEpisode`**（那会在孩子不在场时烧掉当日额度），只把病态标成
`exited` / `abandoned` / `failed_over` 这类「下次孩子开口就能自然恢复」的状态。
kill switch 关掉时连手动 `sweep` 也一并拒绝（回 `skipped: true` + 原因）——
能被 API 绕过的开关不是开关。

八个 detector：

| code | 动作 |
| --- | --- |
| `STALE_AWAITING_REPLY` | 默认 **off**（`ADVENTURE_RECOVERY_STALE_AWAIT_ACTION=off/alert/exit`）。主链路上孩子停在互动点时 `waitingSince` 刻意保持 null，可能一停几小时，改判 exited 会让「我选第二个」掉进意图分类变闲聊 |
| `AWAITING_NON_INTERACTION` | progress → `exited` + 告警 |
| `VERSION_ROW_MISSING` / `VERSION_PAYLOAD_UNUSABLE` | **仅告警**：引擎已回落 segments 表，改 pin 等于让孩子中途换版本 |
| `SEGMENT_ORDER_OVERFLOW` | 等待态 → `exited`；在播态仅告警（`playFrom` 的 isDone 会自然收口） |
| `DAILY_PROGRESS_STATE_CONFLICT` | daily 镜像 progress 终态；completed 时补 `completedAt`，且 `completedDate` 取进度里的完成日期而不是今天 |
| `RETIRED_STALE_DAILY` | `assignedDate < today` 且该集已 retire → daily 与 progress 双双 `abandoned` |
| `SEGMENT_TABLE_DRIFT` | 仅告警（比对 `currentVersionId` 快照与 segments 表的 order/kind/text） |
| `DAILY_WITHOUT_PLAYABLE_PROGRESS` | 仅告警（下次 `startToday` 自愈） |

环境变量（全部可选，留空用代码内默认值）：

```
#ADVENTURE_RECOVERY_ENABLED=true
#ADVENTURE_RECOVERY_SWEEP_INTERVAL_MS=60000
#ADVENTURE_RECOVERY_STALE_AWAIT_MS=120000
#ADVENTURE_RECOVERY_STALE_AWAIT_ACTION=off
#ADVENTURE_BREAKER_WINDOW_MS=600000
#ADVENTURE_BREAKER_THRESHOLD=5
#ADVENTURE_BREAKER_TRIPPED_TTL_SECONDS=3600
```

告警走日志固定标记，便于在 ARMS / 日志系统上直接建规则：
`ADVENTURE_RECOVERY_BREAKER_TRIPPED`（熔断）、`ADVENTURE_RECOVERY_ALERT`（巡检告警，
按 code 聚合成一行）、`ADVENTURE_ENGINE_FAILURE`（引擎兜底）。

### 错误码约定

线上形状（信封本身与全站一致，`code` 永远是 HTTP 状态码）：

```
{ "code": 409,
  "message": "草稿已被别人改过，请刷新后再试",   // 给人看的中文
  "data": { "code": "DRAFT_CONFLICT",           // 给代码看的领域码
            "currentDraft": { ... } } }          // 附带字段，随领域码而定
```

领域码在 **`data.code`**，不是 `code`。这一点由管理台专属的
`ContentAdminExceptionFilter` 保证：领域层抛的是
`new BadRequestException({ message, code, ...附带字段 })`，而全局
`HttpExceptionFilter` 只取 `message`，会把领域码与附带字段一起吃掉。
过滤器只挂在 `AdventureAdminController` 上，全站其余路由的响应体逐字不变；
没有附带字段时 `data` 仍是 `null`，不会多出空壳对象。
前端**按 `data.code` 分支，不要匹配中文 message**（文案会改，码不会）。

| `data.code` | 状态 | 含义与 `data` 里的附带字段 |
| --- | --- | --- |
| `REASON_REQUIRED` / `REASON_TOO_LONG` | 400 | 理由字数不合规（至少 8 字，至多 300 字） |
| `CONFIRM_TEXT_MISMATCH` | 400 | 确认文本与业务键不符，带 `expected` |
| `CONTENT_REJECTED` | 400 | 身份 / 禁用词 / 业务键已被占用等 lint 阻断项，带完整 `lint` |
| `SEGMENT_WOULD_BE_DROPPED` | 400 | 规范化会吃掉段落（缺文本 / 段号非法 / 类型非法），带 `lint` |
| `PUBLISH_BLOCKED` | 400 | 还有 lint error 未清，带 `lint` |
| `NO_DRAFT` | 400 | 没有待发布 / 待丢弃的草稿 |
| `EPISODE_RETIRED` | 400 | 已 retire 的集不能直接发布，先 restore |
| `DRAFT_IS_ONLY_CONTENT` | 400 | 草稿是这一集唯一的内容，不能丢弃 |
| `VERSION_NOT_REVERTABLE` | 400 | 回滚目标不是 published / superseded 快照 |
| `TARGET_VERSION_REQUIRED` | 400 | 回滚没给目标版本（不接受「回上一版」这种相对语义） |
| `NOT_PUBLISHED` | 400 | 从未发布的集不能 retire |
| `NOT_RETIRED` | 400 | 没 retire 的集不能 restore |
| `EPISODE_WAS_PUBLISHED` | 400 | 发布过的集不能 discard，请走 retire |
| `NOTHING_TO_EXPORT` | 400 | 没有可导出的已发布快照，带 `skipped` |
| `BUNDLE_REQUIRED` / `BUNDLE_INVALID` | 400 | 没传 bundle / bundle 解析失败（带 `errors`） |
| `IMPORT_PLAN_REJECTED` | 400 | 导入计划里有 reject，整批不写 |
| `BUSINESS_KEY_TAKEN` | 409 | 并发抢同一集号、绕过 lint 撞上数据库唯一约束 |
| `DRAFT_CONFLICT` | 409 | 乐观锁失败（id 或 updatedAt 任一对不上），带 `currentDraft`（可直接拿去刷新编辑器） |
| `BUNDLE_HASH_MISMATCH` | 409 | 提交的 bundle 与预览时不是同一份，带 `previewedHash` 与 `actualHash` |
| `ALREADY_RETIRED` | 409 | 已经 retire 过了，不需要重复下架 |
| （`data` 为 `null`） | 404 | `episodeId` / `versionId` 不存在，或该版本不属于这一集 |

404 只给中文 message、不给领域码（`NotFoundException` 用的是字符串载荷）；
前端按状态码判断即可。参数校验失败（ValidationPipe）的 `message` 是字符串数组、
`data` 为 `null`，沿用全站形状。

## 二期（进行中）

- `device_presence_daily`：已落库（`DeviceLinkService.handleDeviceUp` 心跳旁路，内存聚合、5 分钟批量 flush）。`onlineNow` / `devicesPoweredOn` / `powerOnRate` 及 trend 的 `poweredOn` 均已接通；fleet 接口已上线（见「Fleet」节）。
- ~~`llm_usage_logs`：token 落库~~ 已上线（见「模型监控」）。~~DeepSeek 主网关流式是否返回 usage 待复验~~ 已复验（2026-11-12）：主模型 87/87 行均有 token，且回传 `prompt_cache_hit_tokens`，费用口径见「模型监控 → 费用口径」。
- `admin_users` 表替换 env 白名单；activation 快照表冻结历史 cohort。
- `turn_decision_logs.reviewLabel / reviewedAt` 写接口（人工复核闭环）：两列本期已建、看板只读，
  二期补 `POST /analytics/decisions/review`（复核结论 correct / false_positive / missed），
  才能算出小模型的**真实漏放率与误伤率**——目前只有模型自报的判定，没有人工真值做对照。
