# 核心接口契约

覆盖 8 条核心链路 + 学习全览 MVP。完整接口见 Swagger：`http://localhost:3000/api/docs`。

统一响应：`{ "code": 0, "message": "success", "data": {} }`。除登录外均需 `Authorization: Bearer <token>`。

---

## 1. 微信登录换 JWT

`POST /users/login` · 无鉴权

请求：`{ "code": "wx-login-code" }`

成功：

```json
{
  "code": 0,
  "data": {
    "token": "eyJ...",
    "userInfo": { "id": "uuid", "openid": "...", "phone": null }
  }
}
```

失败：`{ "code": 401, "message": "WeChat login failed", "data": null }`

---

## 2. 设备列表 / 绑定 / 解绑

- `GET /devices` → `Device[]`
- `POST /devices/bind` · 请求 `{ "deviceId": "dev-local-001" }` → `Device`
- `DELETE /devices/:id` → `{ "success": true }`

`Device` 示例：

```json
{
  "id": "dev-local-001",
  "name": "DEV001",
  "deviceId": "dev-local-001",
  "deviceCode": "DEV001"
}
```

---

## 3. 查询设备当前配置

`GET /device-configs/:deviceId/current`

响应示例：

```json
{
  "deviceId": "dev-local-001",
  "mode": "free_chat",
  "conversationModeKey": "free_chat_casual",
  "conversationModeName": "自由闲聊",
  "language": "bilingual",
  "speechRate": "normal"
}
```

无历史配置时默认 `free_chat + free_chat_casual`。

---

## 4. 切换对话模式

`POST /device-configs/:deviceId/mode`

自由对话请求示例：

```json
{ "mode": "free_chat", "conversationModeKey": "free_chat_casual" }
```

英语对话请求示例：

```json
{ "mode": "english_chat" }
```

响应：`DeviceConfig`

校验规则（详见 `docs/integration.md`「设备配置入参校验」）：

- `400`：mode 非法、`free_chat` 缺少或误传子模式、`english_chat` 携带子模式，或子模式不存在／未启用／分类不匹配。

---

## 5. 选择自由对话子模式

先取子模式：

- `GET /conversation-modes?categoryKey=free_chat` → `ConversationMode[]`

示例：

```json
[
  {
    "id": "...",
    "key": "free_chat_casual",
    "name": "自由闲聊",
    "description": "..."
  }
]
```

再保存：同链路 4，`POST /device-configs/:deviceId/mode` 带 `conversationModeKey`。

---

## 6. 切换英语对话

`POST /device-configs/:deviceId/mode`，请求 `{ "mode": "english_chat" }`。

英语对话是唯一英语学习顶层模式，没有对话子模式，也不需要其他内容配置。

---

## 7. 查询对话记录

`GET /conversations?page=1&pageSize=20&deviceId=dev-local-001`

说明：按设备当前 active config 隔离。**数据模型为细颗粒度消息：一条 item = 一条消息**（孩子的话 `role=user`、AI 回复 `role=device`），一轮问答是共享同一 turnId 的两条消息（id 为裸消息 id，不再有 `-u`/`-d` 后缀）。`total` 按消息条数计。分页锚定最新（`page=1` 为最新一页）；**页内按 `spokeAt` 正序返回（最旧在上、最新在下）**，前端按返回顺序渲染即可，不要再自行反转。

注意：AI 回复可能缺失（LLM 故障时该轮只有 user 消息）或内容为兜底文案；删除接口已移除（`DELETE /conversations/:id` 与 `DELETE /conversations/date/:date` 不再提供，任何人不可删消息）。

响应示例：

```json
{
  "items": [
    {
      "id": "9f1c...",
      "role": "user",
      "content": "Hello",
      "createdAt": "2026-09-25T09:11:00.657Z"
    },
    {
      "id": "7ab2...",
      "role": "device",
      "content": "Hi",
      "createdAt": "2026-09-25T09:11:01.657Z"
    }
  ],
  "total": 2,
  "page": 1,
  "pageSize": 20
}
```

---

## 8. 孩子档案查询/更新

- `GET /child-profiles/device/:deviceId`
- `PATCH /child-profiles/device/:deviceId`

请求/响应示例：

```json
{
  "id": "...",
  "name": "小明",
  "englishName": "Ming",
  "birthday": "2020-05-20",
  "deviceId": "dev-local-001"
}
```

---

## 9. 学习全览 MVP

均需要 `Authorization: ******

### 9.1 仪表盘

`GET /learning-stats/dashboard?deviceId=&range=`（deviceId、range 均可选）

- `range` 缺省：全量累计（兼容旧调用方）。
- `range=today|week|month`：`totalDurationMinutes`/`topicCount` 按时间窗统计，并额外返回 `practiceCount`（范围内对话轮数）；`continuousDays` 与 `devices` 保持全量语义。
- 语境参数 `mode`/`conversationModeKey`（可选）：显式指定统计语境（只读查看，不影响设备配置）；缺省按设备当前顶层模式过滤，自由对话可精确到子模式。
- 时间窗为**自然历**：today=当天；week=本周一 00:00 至今；month=本月 1 号 00:00 至今。

响应示例：

```json
{
  "totalDurationMinutes": 120,
  "totalSessions": 15,
  "activeDeviceCount": 1,
  "boundDeviceCount": 2,
  "continuousDays": 5,
  "topicCount": 3,
  "practiceCount": 30,
  "devices": [
    {
      "deviceId": "dev-local-001",
      "deviceName": "DEV001",
      "childName": "小明",
      "status": "online",
      "totalDurationMinutes": 120,
      "totalSessions": 15,
      "continuousDays": 5,
      "topicCount": 3,
      "todayDurationMinutes": 20,
      "weekDurationMinutes": 120
    }
  ]
}
```

### 9.2 学习趋势

`GET /learning-stats/daily?deviceId=&days=7&mode=&conversationModeKey=`

说明：语境参数可选，语义同 9.1；天数由前端按自然历计算（今日=1、本周一至今、本月 1 号至今）。家长报告趋势使用 `scope=all`，统计全部模式。

响应示例：

```json
[
  { "date": "2026-09-19", "durationMinutes": 0, "sessionCount": 0 },
  { "date": "2026-09-25", "durationMinutes": 20, "sessionCount": 2 }
]
```

### 9.3 主题分布

`GET /learning-stats/topics?deviceId=`

说明：返回**全部**学过的语境（不按当前 active config 过滤），按 `mode + conversationModeKey` 分组；`isActive` 标记当前语境，free_chat 精确到子模式。`avgScore` 为启发式英文开口分（0-100），自由对话为 null。

响应示例：

```json
[
  {
    "id": "free_chat|free_chat_casual",
    "mode": "free_chat",
    "conversationModeKey": "free_chat_casual",
    "conversationModeName": "自由闲聊",
    "count": 3,
    "lastSpokeAt": "2026-09-25T02:15:32.353Z",
    "isActive": true,
    "avgScore": null
  }
]
```

### 9.4 学习动态时间线

`GET /learning-stats/timeline?deviceId=&page=1&pageSize=10`

响应示例：

```json
{
  "items": [
    {
      "id": "...",
      "deviceId": "dev-local-001",
      "deviceName": "DEV001",
      "mode": "free_chat",
      "topicName": "自由闲聊",
      "userText": "Hello",
      "aiText": "Hi there!",
      "createdAt": "2026-09-25T02:15:32.353Z"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 10
}
```

### 9.5 学习动态（事件卡）

`GET /learning-stats/activities?deviceId=&page=1&pageSize=10&range=`

`range` 可选（today/week/month，自然历口径同 9.1）；语境参数可选，缺省按当前顶层模式过滤。streak 在所选语境的完整历史上计算，再按 range 过滤展示日期。

按日倒序分页（`total` = 活跃日数）。事件类型：

- `study`：某日某顶层模式的练习卡，`turnCount` = 当日轮数
- `streak`：连续学习 ≥2 天，卡在连续段最后一天，含 `streakDays`

```json
{
  "items": [
    {
      "date": "2026-09-27",
      "events": [
        {
          "type": "study",
          "mode": "english_chat",
          "turnCount": 37
        },
        { "type": "streak", "streakDays": 2 }
      ]
    }
  ],
  "total": 7,
  "page": 1,
  "pageSize": 10
}
```
