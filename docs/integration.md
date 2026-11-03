# Deda 前后端联调地图

## 一句话架构

微信小程序（`deda-wechat-app`）调用 NestJS 后端（`deda-server`）；后端同时通过 HTTP/WebSocket 与机芯厂对接。

## 仓库分工

| 仓库              | 职责                                                 |
| ----------------- | ---------------------------------------------------- |
| `deda-server`     | 接口契约、业务逻辑、数据库、机芯厂对接               |
| `deda-wechat-app` | 微信小程序页面、调用后端接口、设备管控与学习内容展示 |

## 本地联调地址

| 项目               | 地址                             | 配置位置                                           |
| ------------------ | -------------------------------- | -------------------------------------------------- |
| 后端               | `http://127.0.0.1:3000`          | `deda-server/.env` 中 `APP_PORT`                   |
| Swagger            | `http://127.0.0.1:3000/api/docs` | `src/main.ts`                                      |
| 前端开发版 baseURL | `http://127.0.0.1:3000`          | `deda-wechat-app/miniprogram/config/api.config.ts` |
| 前端生产版 baseURL | `https://your-prod-domain.com`   | 同上，TODO                                         |

## 鉴权

- 登录：`POST /users/login`，请求 `{ code }`（微信 `wx.login` 返回的 code）。
- 响应：`{ data: { token, userInfo } }`。
- 后续请求：前端从 `wx.getStorageSync('token')` 读取，放入 header `Authorization: Bearer <token>`。
- 后端 JWT 解析：`src/modules/users/strategies/jwt.strategy.ts`。

## 响应与错误格式

统一格式：

```json
{ "code": 0, "message": "success", "data": {} }
```

- 成功：`code === 0`。
- 业务失败：`code !== 0` 或 HTTP 非 2xx，`message` 为错误信息。
- 401/403：token 缺失/过期/无效，前端应引导重新登录。

## 核心链路表

| 链路               | API                                                                                                                              | 前端文件                                                                                               | 后端文件                                                                                                                       | 备注                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| 微信登录换 JWT     | `POST /users/login`                                                                                                              | `pages/login/login.ts`                                                                                 | `src/modules/users/users.controller.ts`                                                                                        | code 来自 `wx.login`                |
| 设备列表/绑定/排序/解绑 | `GET /devices`<br>`POST /devices/bind`<br>`PUT /devices/order`<br>`DELETE /devices/:id`                                                                  | `pages/device-list/device-list.ts`<br>`pages/device-bind/device-bind.ts`                               | `src/modules/devices/devices.controller.ts`                                                                                    | 空列表时前端自动绑定 DEV001；拖拽后提交完整顺序 |
| 查询设备当前配置   | `GET /device-configs/:deviceId/current`                                                                                          | `pages/device-list/device-list.ts` 等                                                                  | `src/modules/device-configs/device-configs.controller.ts`                                                                      | 多页面共用                          |
| 切换对话模式       | `POST /device-configs/:deviceId/mode`                                                                                            | `pages/switch-mode/switch-mode.ts`                                                                     | `src/modules/device-configs/device-configs.controller.ts`                                                                      | 顶层模式仅 `free_chat / english_chat` |
| 选择自由对话子模式 | `GET /conversation-modes?categoryKey=free_chat`<br>`POST /device-configs/:deviceId/mode`                                         | `pages/choose-free-chat-mode/choose-free-chat-mode.ts`                                                 | `src/modules/conversation-modes/conversation-modes.controller.ts`<br>`src/modules/device-configs/device-configs.controller.ts` | 子页提交完整载荷（mode+conversationModeKey）；`english_chat` 无子模式 |
| 查询对话记录       | `GET /conversations?page&pageSize&deviceId`                                                                                      | `pages/chat-history/chat-history.ts`                                                                   | `src/modules/conversations/conversations.controller.ts`                                                                        | 一条 item=一条消息（turnId 关联成轮）；page=1 为最新一页，页内时间正序（顶老底新），前端勿再自行反转；删除接口已移除；URL 无语境参数时前端按设备当前配置推导过滤（后端只认显式传参、不读配置） |
| 孩子档案查询/更新  | `GET /child-profiles/device/:deviceId`<br>`PATCH /child-profiles/device/:deviceId`                                               | `pages/owner-info/owner-info.ts`                                                                       | `src/modules/child-profiles/child-profiles.controller.ts`                                                                      | 一个设备对应一个孩子档案；`gender` 可选值为 `male/female`，`null` 表示未设置或清除，PATCH 省略时保留原值 |
| 学习全览 MVP       | `GET /learning-stats/dashboard`<br>`GET /learning-stats/daily`<br>`GET /learning-stats/topics`<br>`GET /learning-stats/timeline` | `pages/learning-data/learning-data.ts`                                                                 | `src/modules/learning-stats/learning-stats.controller.ts`<br>`src/modules/learning-stats/learning-stats.service.ts`            | 仪表盘/趋势/主题/时间线             |
| 智能分析（单设备） | `GET /learning-stats/dashboard?range=`<br>`GET /learning-stats/daily`<br>`GET /learning-stats/activities` | `pages/device-analysis/device-analysis.ts`                                                             | 同上                                                                                                                            | 顶部语境选择器只读，不修改设备配置；缺省按当前顶层模式过滤；自由对话可继续按子模式过滤；topics 按 `mode + conversationModeKey` 全量分组 |

## 设备排序契约

- 前端拖拽结束后调用 `PUT /devices/order`，请求体为 `{ "orderedDeviceIds": ["dev-002", "dev-001"] }`；数组必须包含当前用户全部已绑定设备，且顺序就是期望显示顺序。
- 成功返回 `data.orderedDeviceIds`；重复提交相同顺序是幂等操作。顺序按家长独立保存，不影响其他绑定同一设备的家长。
- `GET /devices` 按已保存顺序返回，响应字段不变；新绑定设备自动排到末尾，旧客户端无需调用排序接口。
- `400` 表示空数组、重复或非法设备 ID；`403` 表示包含当前用户无权操作的设备；`409` 表示设备集合已变化、包含未知 ID 或发生排序写冲突。
- 前端收到 `409` 后应重新调用 `GET /devices` 拉取最新完整列表，再基于最新列表重排，不要直接重试旧数组。

## 设备配置入参校验

`POST /device-configs/:deviceId/mode` 与 `POST /device-configs/:deviceId/apply` 对 `mode` / `conversationModeKey` 做服务端强校验：

| mode | conversationModeKey |
| ---- | ------------------- |
| `free_chat` | **必填**，须为启用中的 free_chat 分类子模式 |
| `english_chat` | **禁止**，必须省略或为 `null` |

错误语义：

- `400`：mode 不在枚举内、违反上表必填/禁止规则、`conversationModeKey` 不存在/未启用/分类与 mode 不匹配。
- 无配置设备默认 `free_chat + free_chat_casual`。

前端对齐：`pages/switch-mode/switch-mode.ts`、`pages/choose-free-chat-mode/choose-free-chat-mode.ts` 需按上表提交；英语对话直接提交 `mode=english_chat`，不再进入子模式或教材选择页。

## 机芯厂 WS 流式协议（vendor namespace）

语音对话链路：`vendor:text:in`（机芯厂 → 后端入站 WS，ASR 文字）→ 后端双模型流式生成 → **后端作为 WS 客户端按 chunk 流式调用机芯厂上传接口**（`vendor:text:chunk` 增量文字 + `vendor:text:out` 全量兜底）→ 机芯厂做 TTS 后下发设备。入站 `vendor:text:in` 仍以 `vendor:text:out` 作为兼容应答。

**首响加速**：后端并行调用小模型（filler，打哈哈承接话题，如"原来你喜欢上海的天气呀"）与大模型（answer，正式回答）。两者均为 `stream: true`；filler chunk 全部发完后才发 answer chunk，机芯厂按 `seq` 顺序喂 TTS 即保证顺序对齐。

**上传保序**：后端对每个 chunk 的发送等待机芯厂 WS ack 后再发下一个（`src/modules/vendor/vendor-reply.uploader.ts`），因此 WS 接口调用顺序与 `seq` 严格一致；单个 chunk 上传失败只记日志、不阻断本轮剩余回复。上传地址走 `VENDOR_WS_UPLOAD_URL`，未配置时不连真实云服务（内部编排照常运行，发送仅记 debug 日志）；鉴权接入时在 uploader 内补充。

`vendor:text:chunk` 载荷：

| 字段       | 类型                  | 说明                                          |
| ---------- | --------------------- | --------------------------------------------- |
| deviceId   | string                | 设备唯一标识                                  |
| turnId     | string                | 本轮对话 ID，与同轮 `vendor:text:out` 一致     |
| seq        | number                | 轮内全局递增序号，从 0 开始，filler/answer 共用 |
| source     | "filler" \| "answer"  | filler=小模型首响；answer=大模型正式回答       |
| delta      | string                | 增量文字；`isFinal=true` 时为空串             |
| isFinal    | boolean               | 该来源是否结束；filler 结束后才开始发 answer  |

约定：

- 顺序保证：一轮内 `seq` 严格递增；所有 `source=filler` 的 chunk 先于所有 `source=answer` 的 chunk；filler 与 answer 各以一个 `isFinal=true` 的空 delta chunk 收尾；最后上传一次 `vendor:text:out` 全量兜底。
- 小模型失败：跳过 filler 阶段，answer 从 `seq=0` 开始；大模型失败：answer 阶段发单条兜底文案 chunk。
- 落库口径：对话记录只保存大模型 answer 全文，filler 话术不入库、不进多轮上下文。
- 兼容：`LLM_STREAM_ENABLED=false` 时后端整体回落到非流式单模型路径，只经入站连接回 `vendor:text:out`。
- 相关 env：`SMALL_LLM_MODEL`（小模型，默认回落 `OPENAI_MODEL`）、`LLM_STREAM_ENABLED`（默认 true）、`VENDOR_WS_UPLOAD_URL`、`VENDOR_UPLOAD_ACK_TIMEOUT_MS`（默认 5000）。
- 后端实现：`src/modules/vendor/vendor.service.ts`（双模型编排与排序）、`src/modules/vendor/vendor-reply.uploader.ts`（出站 WS 上传与 ack 保序）、`src/modules/llm/llm.service.ts`（流式 LLM 调用）、`src/modules/vendor/vendor.gateway.ts`（入站 ASR 入口）。

## 儿童安全三层防护（vendor 链路）

- L1 正则闸（`src/modules/vendor/child-safety.service.ts`）：显式敏感词（色情/自杀自残/血腥暴力，中英文）零延迟拦截，优先于冒险状态机与一切 LLM 调用；刻意不收裸「杀/打/枪/刀」等字样，孩子的攻击性气话（如「我要杀了我的弟弟」）不在此拦截。
- L2 小模型安全分类：每轮一次 small model 调用（与意图路由并行），标签 `safe / sexual / violence / self_harm / emotional_harm`；前三者拦截，`emotional_harm`（情绪气话）放行并向大模型注入共情引导 system 消息；分类失败 fail-open 放行，由 L3 兜底。
- L3 prompt 硬约束（`llm.service.ts` `buildEnglishTutorPrompt`）：全模式常驻儿童安全规则（不生成/不复述敏感内容、温和转移、气话先共情）。
- 拦截回复：不调 LLM，直接播报类别兜底话术（self_harm 引导告诉家长/信任的大人）；走既有 answer chunk 通道。
- 落库：拦截轮 user 原文 + assistant 兜底话术，`mode=free_chat`，assistant `rawPayload` 含 `safetyCategory / safetyLayer`，供家长端敏感事件时间线与告警（家长端展示与推送为后续工作）。
- 人工验收：`scripts/test-child-safety.sh`（真实链路，需本地后端 + 真实 LLM key，会写入测试对话，不自动运行）。

## “更懂 TA”统计契约

- `GET /learning-stats/daily` 的 `date` 统一为 `YYYY-MM-DD`，按日期升序，无数据日期补零。
- 家长报告趋势使用 `GET /learning-stats/daily?deviceId=<厂商设备编号>&days=7&scope=all`；`scope=all` 不按设备当前配置过滤模式，统计全部用户交互，`sessionCount` 为当日用户交互数。
- 旧学习页面不传 `scope=all` 时保持原模式族过滤和会话数语义。
- `scope=all` 趋势与家长报告统一按每条用户消息 0.5 分钟估算使用时长，同一设备、同一日期的分钟数一致；单设备使用设备时区，多设备汇总使用默认报告时区。

## 家长每日报告

- 查询：`GET /learning-stats/parent-report?deviceId=<厂商设备编号>&date=YYYY-MM-DD`；只读取已绑定设备，不触发生成。
- 响应包含 `generationStatus=pending / generating / completed / failed`；无报告记录时为 `pending`。
- 仅 `completed` 且至少一项总结字段非空时返回完整 `summary` 对象；其余状态及空日报告均返回 `summary=null`，不暴露内部生成错误。
- `modeUsage[]` 保留原始 `mode` 并增加中文 `label`；未知新模式保留原始 key，`label=其他`。
- 提交反馈：`POST /learning-stats/parent-report/feedback`，请求体仅含 `deviceId`、`reportDate`、`useful`；`useful` 必须是 JSON 布尔值，成功固定返回 HTTP 200 和 `{ reportDate, feedback }`。
- 反馈按 `(userId, deviceId, reportDate)` 唯一保存；重复提交幂等，改选更新原记录；设备未绑定返回 403 且不写入，报告不存在返回 404。
- 查询报告的 `feedback` 为当前登录用户的 `useful / not_useful / null`，前端据此恢复按钮选中状态。
- 自动生成：配置 `PARENT_REPORT_GENERATION_ENABLED=true` 后，服务启动时补扫一次，之后每 15 分钟扫描；设备当地 01:15 后生成昨天报告，默认时区 `Asia/Shanghai`。
- 空日无用户消息时不调用 LLM；有消息时只将 answer 部分送入主模型，filler 不进入报告 prompt。
- 数据库抢占防止多实例重复生成，失败按 5/15/45 分钟退避，最多 3 次。
- 本地数据库集成测试必须设置 `TEST_DATABASE_URL`，且数据库名必须包含 `test`；测试只写该隔离库并 mock LLM，不使用开发库或真实模型。

## 滚动功能使用统计

- 查询：`GET /learning-stats/mode-usage?deviceId=<厂商设备编号>&days=7&endDate=YYYY-MM-DD`；`deviceId` 必填且必须已绑定当前用户（否则 404），`days` 可选默认 7（整数 1–31，越界 400），`endDate` 可选默认设备时区当日，未来日期自动回落到当日。
- 窗口为 `endDate` 及前 `days-1` 个自然日（设备时区，非最近 N×24 小时）；统计起点不早于当前用户绑定该设备的日期，不补绑定前的数据。
- 统计口径与日报 `modeUsage.count` 一致：窗口内全部 `role=user` 消息按 `mode` 聚合，`mode` 为空归为 `unknown`；`modeUsage` 仅含 `{ mode, count }`（无 `label`），按 count 降序、同数按 mode 字典序；`totalCount` 为各项之和。
- 返回真实 `startDate / endDate / actualDays`，前端不得自行推算；`actualDays` 为窗口内实际纳入统计的自然日数，某天互动为 0 也计入。
- 窗口内无任何用户消息时返回空态：`{ deviceId, startDate: null, endDate: null, actualDays: 0, totalCount: 0, modeUsage: [] }`。

## 哄睡配置

- 查询：`GET /sleep-configs/device/:deviceId`；设备未绑定当前用户返回 403；从未设置过返回 `data: null`，前端展示默认值（`enabled=false, durationMode="default", durationMinutes=null, contentType="story", sleepTime="21:30", forceSleep=false`）。
- 更新：`PATCH /sleep-configs/device/:deviceId`，所有字段可选、传什么改什么，返回更新后完整配置；首次 PATCH 按「默认值 + 入参」upsert 创建。
- 跨字段规则：「生效 durationMode」= 入参 ?? 已存值 ?? `default`；生效为 `custom` 时 `durationMinutes` 必须有值（∈ {10,15,20,25,30}，显式 null 视为无值 → 400）；生效为 `default` 时忽略并清空 `durationMinutes`（存 null）。
- `sleepTime` 必须匹配 `^([01]\d|2[0-3]):[0-5]\d$`；`contentType` 仅 `story/song/mixed`；枚举/格式违规返回 400。
- 生命周期跟随设备：`sleep_configs.deviceId` 唯一外键指向设备内部 UUID，删除设备级联删除。
- 定时进入（方式2）：配置 `SLEEP_SCHEDULER_ENABLED=true` 后每分钟扫描 `enabled=true` 的配置，北京时间到达 `sleepTime` 即触发（单一时区约定，忽略 `Device.timezone`）；到点无条件进入，覆写会话为 `sleep_story`（45 分钟 TTL）；每设备每天最多一次（`sleep_configs.lastTriggeredDate` 抢占标记，多实例安全）；设备离线（无已登记 WS socket）或 LLM 失败则跳过当天、不重试不补发。
- 下行为服务端主动推送 `vendor:text:out`（payload 含 `context: { mode: "sleep_story", trigger: "scheduled" }`）；注意机芯厂 socket 目前仅在收到 `vendor:text:in` 后登记，设备整晚未发言时无映射会按离线跳过——联调需与机芯厂确认主动下行支持。
- `song`/`mixed` 在儿歌内容源上线前降级为哄睡故事；`durationMinutes` 仅落库保存，暂不控制播放时长。定时推送不写 `messages` 表，哄睡统计口径待 §3.4 单独决策。
- 语音改配置（sleep_config 意图）：孩子说「以后睡前都听儿歌」「哄睡改成20分钟」「明天九点半哄我睡觉」等修改含义指令时，走独立短链路——小模型抽取字段，白名单校验后确定性话术确认，不进冒险门禁与大模型主链路。孩子语音只能改 `contentType`（`story/song/mixed`）、`durationMinutes`（∈ {10,15,20,25,30}，语音改时长自动置 `durationMode=custom`）、`sleepTime`（`HH:mm`）；`enabled`/`forceSleep` 仅家长端可改。指令一律持久化到 `sleep_configs`（家长端可见），非法值/解析失败回复兜底话术、不落库。该轮 user/assistant 消息 `mode=free_chat`，assistant `rawPayload.sleepConfig` 记录实际修改字段（未生效为 null），回复 `context: { sleepConfig: <field|null> }`。

## 联调顺序

1. 对契约：先看 `docs/api.md` 或 Swagger。
2. 改后端：更新 DTO / Controller / Service / 测试。
3. 跑测试：`npm run test`、`npm run test:e2e`。
4. 改前端：按 `docs/api.md` 对应节调整字段与路径。
5. 联调：微信开发者工具 + 本地后端。

## 测试基座

- 前端页面装配测试：`deda-wechat-app/miniprogram/tests/page-harness.ts`（wx/Page 桩 + mock api）。凡改动**页面入口导航参数、onLoad 兜底逻辑、API 调用载荷**,必须过对应 `*.page.spec.ts`；新入口页必须补装配用例。
- 后端契约：`docs/api.md` 与本文件为准;改契约前必须对照前端调用点代码,不能只对照文档。

## 常见坑

- **CORS**：后端 `CORS_ORIGIN=*` 仅用于开发；生产需改为小程序域名。
- **字段命名**：后端用 camelCase（如 `deviceId`、`conversationModeKey`），数据库存储也是 camelCase。
- **时间格式**：后端返回 ISO 8601 字符串（如 `2026-09-25T09:11:00.657Z`）。
- **401/403**：token 过期或设备不属于当前用户；前端应重新登录或提示无权限。
- **代理配置**：小程序开发版直连 `127.0.0.1:3000`；真机需 HTTPS 域名或开启「不校验合法域名」。
- **前端请求封装**：`deda-wechat-app/miniprogram/utils/request.ts` 当前 Authorization header 有语法错误，联调前需修复。

## 单次联调最小文件集示例

以「切换自由对话子模式」为例：

- 后端：`src/modules/device-configs/device-configs.controller.ts`、`src/modules/device-configs/device-configs.service.ts`、`src/modules/conversation-modes/conversation-modes.controller.ts`。
- 前端：`deda-wechat-app/miniprogram/pages/choose-free-chat-mode/choose-free-chat-mode.ts`、`deda-wechat-app/miniprogram/api/api.ts`。
