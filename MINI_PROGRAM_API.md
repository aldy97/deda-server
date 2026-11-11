# Deda 微信小程序 API 接口文档

> 文档版本：1.1.0  
> 适用范围：微信小程序业务接口  
> 接口总数：38  
> 契约依据：当前后端 Controller、DTO、Service 与统一响应实现

## 1. 通用约定

### 1.1 Base URL

```text
{SCHEME}://{HOST}:{PORT}
```

本地开发默认示例：`http://localhost:3000`。接口路径没有额外的 `/api` 前缀。

### 1.2 请求与响应格式

- 请求和响应均使用 `application/json; charset=utf-8`。
- Query 参数按 URL 编码；请求体使用 JSON。
- 所有时间戳字段均序列化为 ISO 8601 字符串，除非字段说明另有约定。
- `deviceId` 路径或查询参数均指设备业务 ID，不是数据库内部 UUID；个别响应中的内部 ID 会单独注明。

### 1.3 鉴权

需要鉴权的接口必须在请求头携带：

```http
Authorization: Bearer <token>
Content-Type: application/json
```

`token` 通过 `POST /users/login` 获取。JWT 默认有效期为 7 天，可由服务端配置调整。

鉴权标记：

- **JWT**：必须携带有效 Bearer Token。
- **公开**：当前实现不要求鉴权。

### 1.4 统一成功响应

所有成功响应的 HTTP body 均使用以下信封；各接口文档中的“响应数据”指 `data` 字段。

```json
{
  "code": 0,
  "message": "success",
  "data": {}
}
```

无返回数据时，`data` 为 `null`。

### 1.5 统一异常响应

```json
{
  "code": 400,
  "message": "错误描述",
  "data": null
}
```

参数校验失败时，`message` 也可能是字符串数组：

```json
{
  "code": 400,
  "message": ["birthday must be in YYYY-MM-DD format"],
  "data": null
}
```

常见 HTTP 状态码：

| 状态码 | 含义 |
| --- | --- |
| 200 | GET、PUT、PATCH、DELETE 成功 |
| 201 | POST 成功 |
| 400 | 参数格式、字段组合或业务校验失败 |
| 401 | 未携带 Token、Token 无效或已过期 |
| 403 | 当前用户未绑定目标设备，无权操作 |
| 404 | 目标资源不存在 |
| 409 | 请求基于已变化的数据或发生并发写冲突，需刷新后重试 |
| 500 | 未处理的服务端错误 |

### 1.6 接口清单

| 模块 | 数量 | 接口 |
| --- | ---: | --- |
| 用户账号 | 4 | 登录、绑定手机号、查询资料、更新资料 |
| 设备管理 | 10 | 绑定、列表、详情、状态、成员、控制、WiFi、排序、解绑、配网认领候选 |
| 孩子档案 | 2 | 查询、创建或更新 |
| 设备配置 | 3 | 当前配置、应用配置、切换模式 |
| 对话记录 | 1 | 分页查询 |
| 对话模式 | 3 | 分类、子模式、树形结构 |
| 学习统计 | 10 | 仪表盘、趋势、主题、时间线、动态、洞察、健康度、家长报告、报告反馈、功能统计 |
| 音乐播放 | 3 | 状态、控制、网易云绑定 |
| 哄睡配置 | 2 | 查询、部分更新 |
| 推送订阅 | 1 | 上报订阅消息授权结果 |

---

## 2. 用户账号

### 2.1 微信小程序登录

- **方法／路径**：`POST /users/login`
- **鉴权**：公开
- **成功状态**：201

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `code` | string | 是 | 微信登录凭证，由小程序 `wx.login()` 获取 |

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `token` | string | 后续业务接口使用的 JWT |
| `userInfo.id` | string | 用户 ID |
| `userInfo.openid` | string | 微信用户唯一标识 |
| `userInfo.phone` | string \| null | 已绑定手机号 |

示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "userInfo": {
      "id": "7dc6f0d4-91b2-4f0a-a4ed-43f1fc3d85f0",
      "openid": "openid-value",
      "phone": null
    }
  }
}
```

### 2.2 绑定手机号

- **方法／路径**：`POST /users/phone`
- **鉴权**：JWT
- **成功状态**：201

请求体：当前实现未声明 DTO 或字段级校验规则，也未定义可供依赖的手机号解密字段。

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `phone` | string | 当前实现固定返回 `mock-phone` |

> 当前接口为占位实现，调用方不应将该返回值视为真实已绑定手机号。

### 2.3 查询当前用户资料

- **方法／路径**：`GET /users/profile`
- **鉴权**：JWT
- **成功状态**：200

请求参数：无。

响应数据：用户不存在时为 `null`；否则为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 用户 ID |
| `openid` | string | 微信用户唯一标识 |
| `phone` | string \| null | 手机号 |
| `createdAt` | string | 创建时间，ISO 8601 |

### 2.4 更新当前用户资料

- **方法／路径**：`PATCH /users/profile`
- **鉴权**：JWT
- **成功状态**：200

请求体：JSON 对象。当前实现未声明 DTO、允许更新字段或字段校验规则。

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `userId` | string | 当前用户 ID |
| `dto` | object | 原样返回本次请求体 |

> 当前接口仅回显请求内容，不持久化资料修改。

---

## 3. 设备管理

本模块全部接口需要 JWT。路径中的 `:id` 均为设备业务 `deviceId`。

### 3.1 绑定设备

- **方法／路径**：`POST /devices/bind`
- **鉴权**：JWT
- **成功状态**：201

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `deviceId` | string | 条件必填 | 设备唯一标识；与 `deviceCode` 至少提供一个 |
| `deviceCode` | string | 条件必填 | 设备编码／序列号；与 `deviceId` 至少提供一个 |
| `childProfileId` | string | 否 | 孩子档案 ID；当前绑定逻辑未使用该字段 |

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `success` | boolean | 是否成功 |
| `deviceId` | string | 设备业务 ID |
| `alreadyBound` | boolean | `true` 表示当前用户此前已绑定 |
| `hasChildProfile` | boolean | 该设备当前是否已存在孩子档案（填过任意字段即为 `true`）；与是否本人绑过无关。为 `false` 时前端应在绑定成功后自动引导填写孩子信息 |

### 3.2 查询当前用户设备列表

- **方法／路径**：`GET /devices`
- **鉴权**：JWT
- **成功状态**：200

请求参数：无。

响应数据：设备数组；无绑定时为 `[]`。数组按当前家长已保存的显示顺序返回；未手动排序时使用稳定的默认顺序，新绑定设备排到末尾。不同家长的顺序互不影响。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 设备业务 ID |
| `name` | string | 展示名称，优先使用 `deviceCode` |
| `deviceId` | string | 设备业务 ID |
| `deviceCode` | string \| null | 设备编码 |
| `networkType` | string \| null | 网络类型 |
| `firmwareVersion` | string \| null | 固件版本 |
| `childProfile` | object \| null | 孩子摘要 |
| `childProfile.name` | string \| null | 孩子姓名 |
| `childProfile.englishName` | string \| null | 孩子英文名 |

### 3.3 查询设备详情

- **方法／路径**：`GET /devices/:id`
- **鉴权**：JWT
- **成功状态**：200

路径参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 设备业务 ID |

响应数据：当前用户未绑定该设备时为 `null`；否则为完整设备对象：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 设备内部 UUID |
| `deviceId` | string | 设备业务 ID |
| `characterKey` | string | IP 角色键 |
| `deviceCode` | string \| null | 设备编码 |
| `firmwareVersion` | string \| null | 固件版本 |
| `wifiName` | string \| null | WiFi 名称 |
| `ipAddress` | string \| null | IP 地址 |
| `networkType` | string \| null | 网络类型 |
| `macAddress` | string \| null | MAC 地址 |
| `subnetMask` | string \| null | 子网掩码 |
| `gateway` | string \| null | 网关 |
| `dns` | string \| null | DNS |
| `timezone` | string \| null | 时区 |
| `topicAddress` | string \| null | 设备主题地址 |
| `createdAt` | string | 创建时间 |
| `updatedAt` | string | 更新时间 |

### 3.4 查询设备状态

- **方法／路径**：`GET /devices/:id/status`
- **鉴权**：JWT
- **成功状态**：200

响应数据（2026-11 起接入机芯厂 MQTT 真实状态，字段允许空值）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `deviceId` | string | 设备业务 ID |
| `status` | string | `online`／`offline`；超过 15 秒未收到设备心跳即判定 `offline` |
| `battery` | number \| null | 电量百分比 0–100；设备尚未上报时为 `null` |
| `isCharging` | boolean \| null | 是否充电中；机芯厂协议暂无充电字段，当前固定为 `null`（待协议补充） |
| `lastActiveAt` | string \| null | 最近活跃时间，ISO 8601；设备从未上报时为 `null` |

设备不存在时返回 404。前端需容错 `offline` 与各字段的 `null` 值。

### 3.5 查询设备绑定成员

- **方法／路径**：`GET /devices/:id/members`
- **鉴权**：JWT
- **成功状态**：200

响应数据：成员数组。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `userId` | string | 用户 ID |
| `isOwner` | boolean | 是否为所有者 |
| `boundAt` | string | 绑定时间 |
| `user.id` | string | 用户 ID |
| `user.openid` | string | 用户 OpenID |
| `user.nickname` | string \| null | 用户昵称 |

设备不存在时返回 404。

### 3.6 控制设备

- **方法／路径**：`POST /devices/:id/control`
- **鉴权**：JWT
- **成功状态**：201

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | string | 是 | `volume / power / interrupt / sleep / auto_shutdown` |
| `volume` | number | 条件必填 | 音量 0–100；`action=volume` 时必填，缺失返回 400 |
| `powerOn` | boolean | 条件必填 | `action=power` 时使用；`true` 开机／唤醒，`false` 关机／休眠 |
| `interruptEnabled` | boolean | 条件必填 | `action=interrupt` 时使用 |
| `delayMinutes` | number | 条件必填 | `action=sleep / auto_shutdown` 时使用的延迟分钟数 |

> 2026-11 起：`action=volume` 经机芯厂 MQTT 协议真实下发到设备；`power / interrupt / sleep / auto_shutdown` 四个动作协议尚未支持，服务端暂返回成功但不产生实际效果，待机芯厂补协议后接入。`action=volume` 时设备不存在返回 404。

响应数据：

```json
{
  "success": true,
  "deviceId": "device-business-id",
  "action": "volume"
}
```

### 3.7 下发 WiFi 配置

- **方法／路径**：`POST /devices/:id/wifi`
- **鉴权**：JWT
- **成功状态**：201

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `deviceId` | string | 是 | 设备业务 ID，需与路径设备对应 |
| `ssid` | string | 是 | WiFi SSID，非空 |
| `password` | string | 是 | WiFi 密码，非空 |

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `success` | boolean | 是否成功 |
| `deviceId` | string | 路径中的设备业务 ID |
| `ssid` | string | 已提交的 SSID |

### 3.8 更新设备显示顺序

- **方法／路径**：`PUT /devices/order`
- **鉴权**：JWT
- **成功状态**：200

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `orderedDeviceIds` | string[] | 是 | 当前用户全部已绑定设备的业务 `deviceId`，按期望显示顺序排列；数组不能为空且 ID 不可重复 |

请求示例：

```json
{
  "orderedDeviceIds": ["dev-002", "dev-001"]
}
```

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `orderedDeviceIds` | string[] | 已保存的设备顺序，与本次提交一致 |

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "orderedDeviceIds": ["dev-002", "dev-001"]
  }
}
```

规则与错误：

- 顺序按家长独立保存；重复提交相同顺序为幂等操作，不影响其他家长绑定同一设备的顺序。
- 必须提交完整设备集合，不能只提交发生移动的设备；新绑定设备由服务端自动排到末尾。
- `400`：数组为空、包含重复／空白／非字符串 ID，或请求字段校验失败。
- `401`：未携带有效 JWT。
- `403`：包含已存在但未绑定给当前用户的设备。
- `409`：缺少部分已绑定设备、包含未知设备 ID，或排序期间设备集合发生变化／发生串行化写冲突。
- 收到 `409` 后应重新调用 `GET /devices` 获取最新完整列表，再基于最新列表重排；不要直接重试旧数组。

`GET /devices` 的响应字段保持不变，旧客户端可以忽略本接口。

### 3.9 解绑设备

- **方法／路径**：`DELETE /devices/:id`
- **鉴权**：JWT
- **成功状态**：200

响应数据：

```json
{
  "success": true,
  "deviceId": "device-business-id"
}
```

设备不存在时返回 404；仅删除当前用户与设备的绑定关系。

### 3.10 查询配网认领候选设备

- **方法／路径**：`GET /devices/provision-candidates`
- **鉴权**：JWT
- **成功状态**：200

BLE 配网成功后轮询本接口认领设备：设备连上 WiFi 后会通过机芯厂 `loginMac` 接口完成上线登记，登记后进入认领窗口（默认 120 秒，服务端 `PROVISION_CLAIM_WINDOW_SEC` 可配）。

请求参数：无。

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `devices` | array | 窗口内已上线且未绑定当前用户的设备，按上线时间倒序 |
| `devices[].deviceId` | string | 设备业务 ID（十二位小写 MAC，如 `90fe1de7a1ca`） |
| `devices[].macTail` | string | MAC 后 6 位，多设备并列时供用户辨认 |
| `devices[].lastSeenAt` | string | 上线时间（ISO 8601） |

约定：

- 恰好 1 台候选：小程序可直接调用 `POST /devices/bind` 完成绑定；
- 多于 1 台：必须展示列表让用户选择，禁止自动绑定；
- 0 台：设备可能尚未完成上线，建议每 2 秒轮询、总时长不超过 60 秒，超时提示失败并允许重试。

---

## 4. 孩子档案

本模块接口均需要 JWT，且当前用户必须已绑定目标设备。

### 4.1 查询设备对应的孩子档案

- **方法／路径**：`GET /child-profiles/device/:deviceId`
- **鉴权**：JWT
- **成功状态**：200

响应数据：未创建档案时为 `null`；否则为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 孩子档案 ID |
| `userId` | string | 关联用户 ID |
| `deviceId` | string \| null | **设备内部 UUID**，不是设备业务 ID |
| `name` | string \| null | 孩子姓名 |
| `birthday` | string \| null | 生日，格式 `YYYY-MM-DD` |
| `englishName` | string \| null | 孩子英文名 |
| `gender` | string \| null | 孩子性别：`male / female`；`null` 表示未设置或已清除 |
| `createdAt` | string | 创建时间 |
| `updatedAt` | string | 更新时间 |

### 4.2 创建或更新孩子档案

- **方法／路径**：`PATCH /child-profiles/device/:deviceId`
- **鉴权**：JWT
- **成功状态**：200

请求体：

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `name` | string | 否 | 最长 50 字符 |
| `birthday` | string | 否 | 必须匹配 `YYYY-MM-DD` |
| `englishName` | string | 否 | 最长 50 字符 |
| `gender` | string \| null | 否 | 仅允许 `male / female`；显式传 `null` 表示清除已填性别 |

响应数据：完整的 `ChildProfile`，字段同 4.1。按设备一对一 upsert；**省略的字段保留原值**，不会写为 `null`；仅 `gender` 支持显式传 `null` 清除。

---

## 5. 设备配置

本模块接口均需要 JWT，且当前用户必须已绑定目标设备。

### 5.1 通用模型与配置规则

`DeviceConfigResponse`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `deviceId` | string | 设备业务 ID |
| `mode` | string | `free_chat / english_chat` |
| `conversationModeKey` | string \| null | 自由对话子模式 key；`english_chat` 固定为 `null` |
| `cefrLevel` | string \| null | CEFR 等级 |
| `language` | string \| null | 语言，如 `zh / en / bilingual` |
| `speechRate` | string \| null | 语速，如 `slow / normal / fast` |

配置组合规则：

| `mode` | `conversationModeKey` |
| --- | --- |
| `free_chat` | 必填，且属于启用的 `free_chat` 分类 |
| `english_chat` | 禁止，必须省略或为 `null` |

### 5.2 查询当前生效配置

- **方法／路径**：`GET /device-configs/:deviceId/current`
- **鉴权**：JWT
- **成功状态**：200

响应数据：`DeviceConfigResponse`。

无历史配置时默认 `mode=free_chat`、`conversationModeKey=free_chat_casual`、`language=bilingual`、`speechRate=normal`。

### 5.3 应用完整设备配置

- **方法／路径**：`POST /device-configs/:deviceId/apply`
- **鉴权**：JWT
- **成功状态**：201

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mode` | string | 是 | `free_chat / english_chat` |
| `conversationModeKey` | string | 条件必填 | 仅自由对话必填 |
| `cefrLevel` | string | 否 | CEFR 等级 |
| `language` | string | 否 | 缺省为 `bilingual` |
| `speechRate` | string | 否 | 缺省为 `normal` |

响应数据：新创建的生效 `DeviceConfigResponse`。旧生效配置会被置为失效。

### 5.4 切换对话模式／子模式

- **方法／路径**：`POST /device-configs/:deviceId/mode`
- **鉴权**：JWT
- **成功状态**：201

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mode` | string | 是 | `free_chat / english_chat` |
| `conversationModeKey` | string | 条件必填 | 仅自由对话必填 |
| `language` | string | 否 | 缺省为 `bilingual` |
| `speechRate` | string | 否 | 缺省为 `normal` |

响应数据：新创建的生效 `DeviceConfigResponse`，其中 `cefrLevel` 为 `null`。

---

## 6. 对话记录

### 6.1 分页查询对话记录

- **方法／路径**：`GET /conversations`
- **鉴权**：JWT
- **成功状态**：200

Query 参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `page` | number | 否 | 1 | 页码，小于 1 时按 1 处理 |
| `pageSize` | number | 否 | 20 | 每页条数，小于 1 时按 1 处理 |
| `deviceId` | string | 否 | — | 仅查询当前用户绑定的指定设备 |
| `conversationModeKey` | string | 否 | — | 按对话子模式过滤 |

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | array | 当前页消息，页内按时间正序 |
| `items[].id` | string | 消息 ID |
| `items[].role` | string | `user / device`；数据库 `assistant` 映射为 `device` |
| `items[].content` | string | 消息正文；设备消息为实际播报全文 |
| `items[].createdAt` | string | 消息发生时间，ISO 8601 |
| `total` | number | 符合条件的总消息数 |
| `page` | number | 当前页码 |
| `pageSize` | number | 当前页大小 |

---

## 7. 对话模式

本模块接口当前均为公开接口，仅返回启用中的分类和模式。默认分类为 `free_chat` 和 `english_chat`；仅自由对话包含 `free_chat_casual / free_chat_roleplay / free_chat_qa` 三个子模式。

### 7.1 通用模型

`ConversationModeCategory`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 分类 ID |
| `key` | string | 分类业务键 |
| `name` | string | 展示名称 |
| `description` | string \| null | 描述 |
| `sortOrder` | number | 排序值 |
| `isActive` | boolean | 是否启用 |

`ConversationMode`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 模式 ID |
| `categoryId` | string | 所属分类 ID |
| `key` | string | 模式业务键 |
| `name` | string | 展示名称 |
| `description` | string \| null | 描述 |
| `sortOrder` | number | 排序值 |
| `isActive` | boolean | 是否启用 |
| `configSchema` | object \| null | 前端配置 schema |
| `promptTemplate` | string \| null | 提示词模板 |

### 7.2 查询顶层分类

- **方法／路径**：`GET /conversation-modes/categories`
- **鉴权**：公开
- **成功状态**：200

请求参数：无。响应数据为 `ConversationModeCategory[]`，按 `sortOrder` 升序。

### 7.3 查询子模式列表

- **方法／路径**：`GET /conversation-modes`
- **鉴权**：公开
- **成功状态**：200

Query 参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `categoryKey` | string | 否 | 按顶层分类业务键过滤；分类不存在时返回空数组 |

响应数据：`ConversationMode[]`，按 `sortOrder` 升序。

### 7.4 查询分类与子模式树

- **方法／路径**：`GET /conversation-modes/tree`
- **鉴权**：公开
- **成功状态**：200

请求参数：无。

响应数据：分类数组；每项在 `ConversationModeCategory` 基础上增加：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `modes` | ConversationMode[] | 该分类下启用中的子模式；无子模式时为 `[]` |

---

## 8. 学习统计

本模块接口均需要 JWT。未传 `deviceId` 时统计当前用户绑定的全部设备；传入时仅统计该设备。

通用 Query 参数：

| 参数 | 适用接口 | 必填 | 说明 |
| --- | --- | --- | --- |
| `deviceId` | 查询接口 | 否 | 设备业务 ID |
| `range` | dashboard、activities、insights、health | 否 | `today / week / month`；缺省按各接口累计口径 |
| `mode` | dashboard、daily、activities | 否 | 顶层消息模式过滤 |
| `conversationModeKey` | dashboard、daily、activities | 否 | 自由对话子模式过滤 |

### 8.1 查询学习仪表盘

- **方法／路径**：`GET /learning-stats/dashboard`
- **鉴权**：JWT
- **成功状态**：200

Query：`deviceId`、`range`、`mode`、`conversationModeKey`，均可选。

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `totalDurationMinutes` | number | 学习时长（分钟） |
| `totalSessions` | number | 总会话数 |
| `activeDeviceCount` | number | 在线设备数 |
| `boundDeviceCount` | number | 绑定设备数 |
| `continuousDays` | number | 家庭连续学习天数 |
| `maxContinuousDays` | number | 各设备连续天数的最大值；无设备空结果时可能缺省 |
| `topicCount` | number | 主题数量 |
| `practiceCount` | number \| null | 范围内对话轮数；仅携带 `range` 时返回 |
| `devices` | array | 各设备指标 |

`devices[]`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `deviceId` | string | 设备业务 ID |
| `deviceName` | string | 设备展示名 |
| `childName` | string \| null | 孩子姓名 |
| `childEnglishName` | string \| null | 孩子英文名 |
| `status` | string | `online / offline / sleeping` |
| `totalDurationMinutes` | number | 累计时长（分钟） |
| `totalSessions` | number | 累计会话数 |
| `continuousDays` | number | 连续学习天数 |
| `topicCount` | number | 主题数量 |
| `todayDurationMinutes` | number | 今日时长（分钟） |
| `weekDurationMinutes` | number | 本周时长（分钟） |

### 8.2 查询每日学习趋势

- **方法／路径**：`GET /learning-stats/daily`
- **鉴权**：JWT
- **成功状态**：200

Query：`deviceId`、`mode`、`conversationModeKey` 可选；另支持：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `days` | number | 否 | 7 | 返回最近多少天的数据；非有效数字按 7 处理 |
| `scope` | string | 否 | — | 传入 `all` 时不按设备当前配置过滤，统计全部用户交互 |

`scope=all` 用于“更懂 TA”：时长按每条用户消息 0.5 分钟估算，`sessionCount` 为当日用户交互数，并与同日家长报告的 `durationMinutes` 保持一致。单设备使用设备时区；多设备汇总使用默认报告时区。未传 `scope=all` 时按显式语境或设备当前顶层模式过滤。

响应数据：按日期升序排列的数组，无数据的日期也返回零点。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `date` | string | 完整日期，格式 `YYYY-MM-DD` |
| `durationMinutes` | number | 使用时长（分钟） |
| `sessionCount` | number | 会话数；`scope=all` 时为用户交互数 |

### 8.3 查询主题分布

- **方法／路径**：`GET /learning-stats/topics`
- **鉴权**：JWT
- **成功状态**：200

Query：`deviceId` 可选。

响应数据：按 `mode + conversationModeKey` 分组的主题数组。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主题语境标识 |
| `mode` | string | 顶层对话模式 |
| `conversationModeKey` | string \| null | 自由对话子模式 key |
| `conversationModeName` | string \| null | 自由对话子模式名称 |
| `count` | number | 对话数量 |
| `lastSpokeAt` | string | 最近对话时间 |
| `isActive` | boolean | 是否为设备当前配置语境 |
| `avgScore` | number \| null | 启发式开口分；自由对话为 `null` |

### 8.4 查询对话时间线

- **方法／路径**：`GET /learning-stats/timeline`
- **鉴权**：JWT
- **成功状态**：200

Query：

| 参数 | 类型 | 必填 | 默认值 |
| --- | --- | --- | --- |
| `deviceId` | string | 否 | — |
| `page` | number | 否 | 1 |
| `pageSize` | number | 否 | 10 |

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | array | 当前页对话轮次，按时间倒序 |
| `total` | number | 总轮次 |
| `page` | number | 当前页码 |
| `pageSize` | number | 当前页大小 |

`items[]`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 用户消息 ID |
| `deviceId` | string | 设备业务 ID |
| `deviceName` | string | 设备展示名 |
| `mode` | string | 对话模式 |
| `topicName` | string | 主题名称 |
| `userText` | string | 孩子输入文字 |
| `aiText` | string | 同轮 AI 回复；缺失时为空字符串 |
| `createdAt` | string | 对话时间 |

### 8.5 查询学习动态

- **方法／路径**：`GET /learning-stats/activities`
- **鉴权**：JWT
- **成功状态**：200

Query：`deviceId`、`range`、`mode`、`conversationModeKey` 可选；另支持 `page`（默认 1）、`pageSize`（默认 10）。

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items` | array | 按日期分组的动态 |
| `items[].date` | string | 本地日期，`YYYY-MM-DD` |
| `items[].events` | array | 当日动态事件 |
| `total` | number | 动态总数 |
| `page` | number | 当前页码 |
| `pageSize` | number | 当前页大小 |

`events[]`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | string | `study / streak` |
| `mode` | string \| null | `study` 事件的顶层对话模式 |
| `turnCount` | number | `study` 事件的当日对话轮数 |
| `streakDays` | number | `streak` 事件的连续学习天数 |

### 8.6 查询学习洞察

- **方法／路径**：`GET /learning-stats/insights`
- **鉴权**：JWT
- **成功状态**：200

Query：`deviceId`、`range` 可选。

响应数据：洞察数组；无洞察时为 `[]`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 洞察 ID |
| `type` | string | `milestone / strength / weakness / alert / suggestion` |
| `title` | string | 标题 |
| `content` | string | 内容 |
| `metricValue` | number \| null | 关联指标值 |
| `metricUnit` | string \| null | 指标单位 |
| `deviceId` | string \| null | 关联设备业务 ID |
| `deviceName` | string \| null | 关联设备名称 |

### 8.7 查询学习健康度

- **方法／路径**：`GET /learning-stats/health`
- **鉴权**：JWT
- **成功状态**：200

Query：`deviceId`、`range` 可选。

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `score` | number | 综合得分，0–100 |
| `level` | string | `excellent / good / average / attention` |
| `dimensions.activity` | number | 活跃度得分 |
| `dimensions.consistency` | number | 持续性得分 |
| `dimensions.balance` | number | 均衡度得分 |
| `dimensions.engagement` | number | 参与度得分 |
| `suggestion` | string | 学习建议 |

等级边界：`excellent ≥ 85`、`good ≥ 70`、`average ≥ 55`，其余为 `attention`。

### 8.8 查询家长每日报告

- **方法／路径**：`GET /learning-stats/parent-report`
- **鉴权**：JWT
- **成功状态**：200

Query：

| 参数 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `deviceId` | string | 是 | 当前用户已绑定的设备业务 ID |
| `date` | string | 是 | 报告日期，必须匹配 `YYYY-MM-DD`，且为有效日期 |

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `deviceId` | string | 设备业务 ID |
| `reportDate` | string | 报告日期 |
| `durationMinutes` | number | 当日使用时长（分钟），按每条用户消息 0.5 分钟估算 |
| `generationStatus` | string | `pending / generating / completed / failed`；无报告记录时为 `pending` |
| `modeUsage` | array | 各模式使用次数，按次数降序、模式名升序 |
| `modeUsage[].mode` | string | 稳定原始模式 key；无模式消息归为 `unknown` |
| `modeUsage[].label` | string | 中文展示名称；未知新模式为 `其他` |
| `modeUsage[].count` | number | 使用次数 |
| `summary` | object \| null | 仅 `completed` 且至少一项总结非空时返回对象；其余状态及空日报告均为 `null` |
| `summary.expressionObservation` | string \| null | 表达观察 |
| `summary.emotionObservation` | string \| null | 情绪观察 |
| `summary.thinkingObservation` | string \| null | 思考观察 |
| `summary.suggestion` | string \| null | 家长建议 |
| `habits` | array | 进行中习惯计划及完成情况 |
| `habits[].planId` | string | 习惯计划 ID |
| `habits[].title` | string | 习惯名称 |
| `habits[].targetDays` | number | 目标天数 |
| `habits[].completedDays` | number | 已完成天数 |
| `habits[].todayCompleted` | boolean | 报告日期当天是否完成 |
| `feedback` | string \| null | `useful / not_useful / null` |

已知模式展示映射：`free_chat=自由对话`、`english_chat=英语对话`、`adventure_story=每日冒险`、`english_story=英语故事`、`idiom_story=成语故事`、`free_story=自由故事`、`sleep_story=哄睡故事`、`unknown=其他`。

设备未绑定或日期无效时分别返回 404 或 400；响应不包含内部异常堆栈或模型错误。

### 8.9 提交家长报告反馈

- **方法／路径**：`POST /learning-stats/parent-report/feedback`
- **鉴权**：JWT
- **成功状态**：201

请求体：

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `deviceId` | string | 是 | 当前用户已绑定的设备业务 ID |
| `reportDate` | string | 是 | 报告日期，必须匹配 `YYYY-MM-DD` |
| `useful` | boolean | 是 | `true` 为有用，`false` 为无用；必须为 JSON 布尔值 |

响应数据：

```json
{
  "reportDate": "2026-10-31",
  "feedback": "useful"
}
```

`useful=false` 时 `feedback=not_useful`。报告不存在时返回 404。

### 8.10 查询滚动功能使用统计

- **方法／路径**：`GET /learning-stats/mode-usage`
- **鉴权**：JWT
- **成功状态**：200

Query：

| 参数 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `deviceId` | string | 是 | 当前用户已绑定的设备业务 ID，未绑定返回 404 |
| `days` | number | 否 | 滚动窗口天数，默认 `7`；整数 1–31，越界或非整数返回 400 |
| `endDate` | string | 否 | 统计截止日期 `YYYY-MM-DD`；缺省为设备时区当日，未来日期自动回落到当日；格式非法返回 400 |

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `deviceId` | string | 设备业务 ID |
| `startDate` | string \| null | 实际统计起点；窗口内无任何可统计数据时为 `null` |
| `endDate` | string \| null | 实际统计截止日；窗口内无任何可统计数据时为 `null` |
| `actualDays` | number | 实际纳入统计的自然日数（含 0 次互动的天） |
| `totalCount` | number | 窗口内全部互动次数，等于 `modeUsage` 各项之和 |
| `modeUsage` | array | 各模式使用次数，按次数降序、模式名字典序 |
| `modeUsage[].mode` | string | 稳定原始模式 key；无模式消息归为 `unknown` |
| `modeUsage[].count` | number | 使用次数 |

统计口径：窗口为 `endDate` 及前 `days-1` 个自然日（设备时区，非最近 N×24 小时）；起点不早于当前用户绑定该设备的日期，不补绑定前的数据。`modeUsage` 只含 `{ mode, count }`，**不含中文 label**，展示文案由前端自行映射。窗口内无任何用户消息时返回空态：

```json
{
  "deviceId": "d1",
  "startDate": null,
  "endDate": null,
  "actualDays": 0,
  "totalCount": 0,
  "modeUsage": []
}
```

`startDate / endDate / actualDays` 一律以后端返回值为准，前端不得自行推算。

---

## 9. 音乐播放

本模块接口当前均为公开接口。

### 9.1 查询设备音乐播放状态

- **方法／路径**：`GET /music/status`
- **鉴权**：公开
- **成功状态**：200

Query：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `deviceId` | string | 是 | 设备业务 ID |

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `deviceId` | string | 设备业务 ID |
| `playing` | boolean | 是否正在播放；当前实现固定为 `false` |
| `song` | object \| null | 当前歌曲；当前实现固定为 `null` |
| `volume` | number | 音量；当前实现固定为 `50` |
| `source` | string | 音乐来源；当前实现固定为 `netease` |

### 9.2 控制音乐播放

- **方法／路径**：`POST /music/control`
- **鉴权**：公开
- **成功状态**：201

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `deviceId` | string | 是 | 设备业务 ID |
| `action` | string | 是 | `play / pause / resume / stop / next / prev / volume` |
| `songId` | string | 条件必填 | 歌曲 ID 或 URL；`action=play` 时使用 |
| `volume` | number | 条件必填 | 音量 0–100；`action=volume` 时使用 |

响应数据：

```json
{
  "success": true,
  "deviceId": "device-business-id",
  "action": "play"
}
```

### 9.3 绑定网易云音乐账号

- **方法／路径**：`POST /music/netease/bind`
- **鉴权**：公开
- **成功状态**：201

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `deviceId` | string | 是 | 设备业务 ID |
| `authCode` | string | 是 | 网易云音乐用户授权码或 Token，非空 |
| `neteaseUserId` | string | 否 | 网易云音乐用户 ID |

响应数据：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `success` | boolean | 是否成功 |
| `deviceId` | string | 设备业务 ID |
| `bound` | boolean | 当前实现固定为 `true` |
| `neteaseUserId` | string \| null | 网易云用户 ID；未提供时为 `null` |

---

## 10. 哄睡配置

本模块接口均需要 JWT，且当前用户必须已绑定目标设备（否则 403）。配置按设备一对一保存，生命周期跟随设备（解绑/删除设备时级联删除）。

### 10.1 查询设备哄睡配置

- **方法／路径**：`GET /sleep-configs/device/:deviceId`
- **鉴权**：JWT
- **成功状态**：200

响应数据：从未设置过时为 `null`，前端展示默认值（`enabled=false, durationMode="default", durationMinutes=null, contentType="story", sleepTime="21:30", forceSleep=false`）；否则为：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 哄睡配置 ID |
| `deviceId` | string | **设备内部 UUID**，不是设备业务 ID |
| `enabled` | boolean | 哄睡总开关 |
| `durationMode` | string | `default / custom`；`default` 表示由后端决定播放时长 |
| `durationMinutes` | number \| null | 手动哄睡时长（分钟），取值 `10/15/20/25/30`；`durationMode=default` 时恒为 `null` |
| `contentType` | string | 哄睡内容类型：`story / song / mixed` |
| `sleepTime` | string | 每晚定时进入时间，24h 制 `HH:mm`，如 `21:30` |
| `forceSleep` | boolean | 强制哄睡开关 |
| `createdAt` | string | 创建时间 |
| `updatedAt` | string | 更新时间 |

### 10.2 部分更新哄睡配置

- **方法／路径**：`PATCH /sleep-configs/device/:deviceId`
- **鉴权**：JWT
- **成功状态**：200

请求体（所有字段可选，传什么改什么；省略的字段保留原值）：

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `enabled` | boolean | 否 | — |
| `durationMode` | string | 否 | 仅允许 `default / custom` |
| `durationMinutes` | number \| null | 否 | 仅允许 `10/15/20/25/30`；生效 `durationMode=custom` 时必须有值（显式传 `null` 视为无值），否则 400 |
| `contentType` | string | 否 | 仅允许 `story / song / mixed` |
| `sleepTime` | string | 否 | 必须匹配 `^([01]\d\|2[0-3]):[0-5]\d$` |
| `forceSleep` | boolean | 否 | — |

跨字段规则：

- 「生效 `durationMode`」= 本次传入值，未传则取已存值，从未设置过则视为 `default`。
- 生效为 `custom` 且生效 `durationMinutes` 为空 → 400。
- 生效为 `default` 时忽略并清空 `durationMinutes`（存为 `null`）。

响应数据：更新后的完整配置，字段同 10.1。从未设置过的设备首次 PATCH 会按「默认值 + 本次入参」创建记录。

> 说明：定时进入、语音指令进入、强制哄睡拦截及哄睡统计口径为后续批次行为，当前接口仅负责配置读写。

---

## 11. 推送订阅

哄睡服务通知走微信「一次性订阅消息」：小程序端在用户手势上调用 `wx.requestSubscribeMessage`，随后把授权结果上报到本接口；后端按「用户 + 模板」维度累计可推送额度，哄睡时间到点时向设备当前所有绑定家长各消耗 1 点额度推送一次。

约定：

- 额度按「用户 + 模板」维度累计，与设备无关；解绑/wipe 后发送时按当前绑定关系取人，关系不存在即不再推送。
- 同一模板多次 accept 额度累加，单次上报最多 +30；reject 会清零该模板的剩余额度。
- 后端未配置模板白名单（`WECHAT_TMPL_SLEEP_REMINDER`）时本接口一律 400。

### 11.1 上报订阅消息授权结果

- Method：`POST`
- Path：`/push-subscriptions`
- 鉴权：Bearer Token
- Content-Type：`application/json`

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| templateId | string | 是 | 微信订阅消息模板 ID（须在后端白名单内） |
| result | string | 是 | 授权结果：`accept` / `reject` |
| count | number | 否 | 本次新增额度（仅 accept 有效），默认 1，上限 30 |

响应数据：

```json
{
  "templateId": "tmpl-sleep-reminder",
  "quota": 5,
  "status": "active"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| templateId | string | 模板 ID |
| quota | number | 累计后的剩余推送额度 |
| status | string | `active` / `rejected` / `exhausted` |

异常：`templateId` 不在白名单返回 400。

---

## 12. 小程序接入注意事项

1. 除明确标为“公开”的接口外，统一携带 Bearer Token；Token 失效后重新走微信登录。
2. 所有业务写操作均以统一信封中的 `code=0` 和 HTTP 成功状态共同判断，不要只检查 HTTP 200／201。
3. 设备相关业务 ID 与数据库内部 UUID 不可混用，尤其是孩子档案响应中标注的内部 ID。
4. 自由对话配置保存前先读取对话模式树，确保 `conversationModeKey` 属于 `free_chat`；`english_chat` 不传子模式。
5. 标注为“当前实现”的字段或占位行为只代表现有契约；后续实现真实能力时，应保持字段类型与兼容策略明确后再升级调用方。
