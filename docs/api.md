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
{ "mode": "textbook_learning" }
```

响应：`DeviceConfig`

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

---

## 7. 查询对话记录

`GET /conversations?page=1&pageSize=20&deviceId=dev-local-001`

说明：按设备当前 active config 隔离，按 `spokeAt` 倒序返回。

响应示例：

```json
{
  "items": [
    {
      "id": "...-u",
      "role": "user",
      "content": "Hello",
      "createdAt": "2026-09-25T09:11:00.657Z"
    },
    {
      "id": "...-d",
      "role": "device",
      "content": "Hi",
      "createdAt": "2026-09-25T09:11:01.657Z"
    }
  ],
  "total": 1,
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

`GET /learning-stats/dashboard?deviceId=`（deviceId 可选）

响应示例：

```json
{
  "totalDurationMinutes": 120,
  "totalSessions": 15,
  "activeDeviceCount": 1,
  "boundDeviceCount": 2,
  "continuousDays": 5,
  "topicCount": 3,
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

`GET /learning-stats/daily?deviceId=&days=7`

响应示例：

```json
[
  { "date": "9/19", "durationMinutes": 0, "sessionCount": 0 },
  { "date": "9/25", "durationMinutes": 20, "sessionCount": 2 }
]
```

### 9.3 主题分布

`GET /learning-stats/topics?deviceId=`

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
