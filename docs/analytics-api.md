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

GET /analytics/quality/llm-usage
→ 501 一期未落库；二期（llm_usage_logs）上线
```

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

GET /analytics/messages/:id
→ 整行全部字段，含 rawPayload 原样 JSON；id 不存在 → 404
```

## 二期预告（需 schema 审批）

- `device_presence_daily`：MQTT DEVICE_STATUS 旁路落库 → 开机率 / onlineNow / fleet 接口。
- `llm_usage_logs`：token 落库。已验证 DashScope(qwen-flash) 流式支持 `stream_options.include_usage`（末 chunk 返回真实 token 数）；DeepSeek 主网关验证时返回 internal_error（网关侧故障，与参数无关），待恢复后复验。
- `admin_users` 表替换 env 白名单；activation 快照表冻结历史 cohort。
