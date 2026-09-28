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
  "mode": "locked_unit",
  "textbookId": "unlock-l1-speaking-listening",
  "textbookName": "Unlock L1 Speaking & Listening",
  "unitId": "unit-1",
  "unitName": "a Nadiya Hussain writes about food.",
  "conversationModeKey": null,
  "conversationModeName": null
}
```

---

## 4. 切换对话模式

`POST /device-configs/:deviceId/mode`

请求示例：

```json
{ "mode": "free_chat", "conversationModeKey": "free_chat_casual" }
```

或

```json
{ "mode": "textbook_learning", "textbookId": "unlock-l1-speaking-listening" }
```

响应：`DeviceConfig`

校验规则（详见 `docs/integration.md`「设备配置入参校验」）：

- `400`：mode 非法、`free_chat` 缺 `conversationModeKey` 或带 `textbookId`/`unitId`、教材类 mode 缺 `textbookId`、`locked_unit` 缺 `unitId`、`free_textbook` 带 `unitId`、`conversationModeKey` 不存在/未启用/分类与 mode 不匹配。
- `404`：`textbookId` 不存在或 `unitId` 不属于该教材。

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

## 6. 选择教材单元

- `GET /textbooks` → `Textbook[]`
- `GET /textbooks/:textbookId/units` → `TextbookUnit[]`
- `POST /device-configs/:deviceId/apply`

请求示例：

```json
{
  "mode": "locked_unit",
  "textbookId": "unlock-l1-speaking-listening",
  "unitId": "unit-1"
}
```

响应：`DeviceConfig`

校验规则同上节：违反 mode 字段矩阵返回 `400`；`textbookId` 不存在或 `unitId` 不属于该教材返回 `404`。

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
- 语境参数 `textbookId`/`unitId`/`mode`/`conversationModeKey`（可选）：显式指定统计语境（只读查看,不影响设备配置）;缺省=设备当前配置的模式族（教材族设备→教材类消息,free_chat 设备→自由对话）。
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

`GET /learning-stats/daily?deviceId=&days=7&textbookId=&unitId=&mode=&conversationModeKey=`

说明：语境参数可选,语义同 9.1（显式 > 当前配置族默认）;不再按单元隔离——教材族跨全部教材全部单元计入。天数由前端按自然历计算（今日=1、本周一至今、本月 1 号至今）。

响应示例：

```json
[
  { "date": "9/19", "durationMinutes": 0, "sessionCount": 0 },
  { "date": "9/25", "durationMinutes": 20, "sessionCount": 2 }
]
```

### 9.3 主题分布

`GET /learning-stats/topics?deviceId=`

说明：返回**全部**学过的语境（不按当前 active config 过滤），`isActive` 标记当前在学项（free_chat 精确到子模式）。教材族按教材×单元分组并解析真实名称;free_chat 按子模式分组（`conversationModeKey/Name`）。`avgScore` 为启发式英文开口分（0-100）：英文占比×70 + 英文丰富度（平均词数/8 封顶）×30；无内容时为 null，前端不显示。待接发音/语法评分管线后替换。

响应示例：

```json
[
  {
    "id": "free_chat|sample-textbook|unit-1",
    "mode": "free_chat",
    "textbookId": "sample-textbook",
    "textbookName": "sample-textbook",
    "unitId": "unit-1",
    "unitName": "unit-1",
    "conversationModeKey": null,
    "conversationModeName": null,
    "count": 3,
    "lastSpokeAt": "2026-09-25T02:15:32.353Z",
    "isActive": false,
    "avgScore": 50
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
      "topicName": "sample-textbook · unit-1",
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

`range` 可选（today/week/month,自然历口径同 9.1）;语境参数可选（语义同 9.1,缺省=当前配置族）。streak/unlock 在所选语境范围内计算。

按日倒序分页（`total` = 活跃日数）。事件类型：

- `study`：某日某教材/单元（或 free_chat）的练习卡，`turnCount` = 当日轮数
- `streak`：连续学习 ≥2 天，卡在连续段最后一天，含 `streakDays`
- `unlock`：某单元首次练习日

说明：动态为全量历史，**不**按当前 active config 过滤（与 timeline/daily 等统计端点不同）。

```json
{
  "items": [
    {
      "date": "2026-09-27",
      "events": [
        {
          "type": "study",
          "mode": "locked_unit",
          "textbookId": "unlock-l1-speaking-listening",
          "textbookName": "Unlock L1 Speaking & Listening",
          "unitId": "unit-1",
          "unitName": "a Nadiya Hussain writes about food.",
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
