# LLM 监控契约（/llm 页）

deda-dashboard `/llm` 页（`src/pages/Llm/`）与 `src/api/analytics.ts` 引用的模型监控契约。
**本文件只定义口径与枚举，不重复字段级 schema** —— 接口出入参以 `docs/analytics-api.md`
的「模型监控（LLM）」「费用口径」「判定质量监控（decisions）」三节为准，实现以本仓库代码 + Swagger 为准。

## 四个监控维度

`/llm` 页按 tab 拆分，四个维度回答的是四个不同的问题，不可混在一页：

| tab  | 回答的问题           | 数据源                              | 接口前缀                                         | 契约文档                                |
| ---- | -------------------- | ----------------------------------- | ------------------------------------------------ | --------------------------------------- |
| 性能 | 模型调用健康吗       | `llm_usage_logs`                    | `/analytics/llm/*`                               | analytics-api.md → 模型监控（LLM）      |
| 价格 | 花了多少钱、单价多少 | `llm_cost_daily` + `llm_usage_logs` | `/analytics/llm/cost-*`                          | analytics-api.md → 费用口径             |
| 安全 | 该拦的拦住了吗       | `turn_decision_logs`                | `/analytics/decisions/safety-*`、`/review-queue` | analytics-api.md → 判定质量监控         |
| 意图 | 路由到对的模式了吗   | `turn_decision_logs`                | `/analytics/decisions/intent-*`                  | docs/conversation-routing.md → 决策来源 |

> 安全与意图两个 tab **必须按 `safetySource` / `intentSource` 分桶**，不能只看
> `safetyCategory` / `intent`。原因见 analytics-api.md 的 `safetySource` 表：
> 「模型判 safe」和「小模型挂了裸奔」在 category 上都是放行，只有 source 能区分。

## scene 枚举（llm_usage_logs.scene）

小模型与主模型的全量调用都按 scene 打标，性能 tab 的分场景汇总以此为行：

| scene                   | tier  | 用途                         |
| ----------------------- | ----- | ---------------------------- |
| `safety_l2`             | small | L2 语义安全分类              |
| `intent_classify`       | small | 七标签意图路由               |
| `filler`                | small | 首音前的拖延话术（防死空气） |
| `adventure_interaction` | small | 冒险互动作答                 |
| `memory_extract`        | small | 长期记忆抽取                 |
| `sleep_config_extract`  | small | 哄睡设置的语音改配置抽取     |
| `sleep_story_generate`  | main  | 哄睡故事生成                 |
| `chat_main`             | main  | 主对话回答                   |
| `parent_report`         | main  | 家长日报生成                 |

代码真相：`src/modules/llm/llm.service.ts` 的 `LLM_SCENES`。
dashboard 侧的中文名与着色在 `src/pages/Llm/scenes.ts`，新增 scene 时两处必须同步。

## failureReason 枚举

`timeout` / `rate_limit` / `parse_error` / `upstream_error` / `empty_response`。
空响应视为失败（`empty_response`），不计入成功率分子。

## 比率与空值口径

- **分母为 0 一律返回 `null`，不返回 0。** 前端必须渲染成「—」，不能渲染成 `0%`：
  「今天没有调用」和「今天零拦截」是两件完全不同的事。
- 比率保留 4 位小数（`round4`），前端自行转百分比。
- 分位数用 `percentile_cont` 口径（线性插值），空样本返回 `null`。
- `firstTokenMs` 仅流式调用有值，非流式恒 `null`。
- trend 类接口对区间内无数据的桶**补零**（计数 0、比率 null），保证折线不断。

## 时区

所有日期区间按 `Asia/Shanghai` 切日（`DEFAULT_REPORT_TIMEZONE`），
`startDate=endDate=D` 表示北京时区 D 日 00:00:00 至 D+1 日 00:00:00（左闭右开）。
`granularity=week` 为**周一起始**，桶 key 是那一周的周一日期。

## 轮次串联

`turnId` 贯穿一轮问答的全部调用：`safety_l2` / `intent_classify` / `filler` / `chat_main` /
`memory_extract` 共用同一个 ID，`turn_decision_logs` 也以它为幂等键。
排查单轮问题时用 `/analytics/llm/by-turn?turnId=` 看调用链路，
用 `/analytics/decisions/review-queue` 看这一轮的安全与意图判定。

> 例外：后台任务（`parent_report` / `sleep_*` 定时触发）无轮次上下文，`turnId` 恒 null。
> 另：sleep_config 短链路的 `persistTurn` 目前未透传 turnId（既有实现），
> 故该轮在消息明细里查不到 turnId，但判定记录本身有。

## 数据留存

| 表                   | 留存策略                                                                   |
| -------------------- | -------------------------------------------------------------------------- |
| `llm_usage_logs`     | 明细保留，按 `[createdAt, scene]` 索引查询                                 |
| `llm_cost_daily`     | 按 `dedupeKey` 幂等 upsert，账单缺日为 null 不补 0                         |
| `turn_decision_logs` | **永久保留**，不设 TTL、不做预聚合；`asrText` 只在拦截或非 safe 类别时写入 |
