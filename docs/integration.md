# Deda 前后端联调地图

## 一句话架构

微信小程序（`deda-wechat-app`）调用 NestJS 后端（`deda-server`）；后端同时通过 HTTP/WebSocket 与机芯厂对接。

## 仓库分工

| 仓库 | 职责 |
|------|------|
| `deda-server` | 接口契约、业务逻辑、数据库、机芯厂对接 |
| `deda-wechat-app` | 微信小程序页面、调用后端接口、设备管控与学习内容展示 |

## 本地联调地址

| 项目 | 地址 | 配置位置 |
|------|------|----------|
| 后端 | `http://127.0.0.1:3000` | `deda-server/.env` 中 `APP_PORT` |
| Swagger | `http://127.0.0.1:3000/api/docs` | `src/main.ts` |
| 前端开发版 baseURL | `http://127.0.0.1:3000` | `deda-wechat-app/miniprogram/config/api.config.ts` |
| 前端生产版 baseURL | `https://your-prod-domain.com` | 同上，TODO |

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

| 链路 | API | 前端文件 | 后端文件 | 备注 |
|------|-----|----------|----------|------|
| 微信登录换 JWT | `POST /users/login` | `pages/login/login.ts` | `src/modules/users/users.controller.ts` | code 来自 `wx.login` |
| 设备列表/绑定/解绑 | `GET /devices`<br>`POST /devices/bind`<br>`DELETE /devices/:id` | `pages/device-list/device-list.ts`<br>`pages/device-bind/device-bind.ts` | `src/modules/devices/devices.controller.ts` | 空列表时前端自动绑定 DEV001 |
| 查询设备当前配置 | `GET /device-configs/:deviceId/current` | `pages/device-list/device-list.ts` 等 | `src/modules/device-configs/device-configs.controller.ts` | 多页面共用 |
| 切换对话模式 | `POST /device-configs/:deviceId/mode` | `pages/switch-mode/switch-mode.ts` | `src/modules/device-configs/device-configs.controller.ts` | mode 为顶层分类 |
| 选择自由对话子模式 | `GET /conversation-modes?categoryKey=free_chat`<br>`POST /device-configs/:deviceId/mode` | `pages/choose-free-chat-mode/choose-free-chat-mode.ts` | `src/modules/conversation-modes/conversation-modes.controller.ts`<br>`src/modules/device-configs/device-configs.controller.ts` | 先取子模式再保存 |
| 选择教材单元 | `GET /textbooks`<br>`GET /textbooks/:id/units`<br>`POST /device-configs/:deviceId/apply` | `pages/textbook-learning/textbook-learning.ts`<br>`pages/choose-textbook-unit/choose-textbook-unit.ts` | `src/modules/textbooks/textbooks.controller.ts`<br>`src/modules/device-configs/device-configs.controller.ts` | apply 保存 textbookId + unitId |
| 查询对话记录 | `GET /conversations?page&pageSize&deviceId` | `pages/chat-history/chat-history.ts` | `src/modules/conversations/conversations.controller.ts` | 按当前 active config 隔离，倒序返回 |
| 孩子档案查询/更新 | `GET /child-profiles/device/:deviceId`<br>`PATCH /child-profiles/device/:deviceId` | `pages/owner-info/owner-info.ts` | `src/modules/child-profiles/child-profiles.controller.ts` | 一个设备对应一个孩子档案 |

## 联调顺序

1. 对契约：先看 `docs/api.md` 或 Swagger。
2. 改后端：更新 DTO / Controller / Service / 测试。
3. 跑测试：`npm run test`、`npm run test:e2e`。
4. 改前端：按 `docs/api.md` 对应节调整字段与路径。
5. 联调：微信开发者工具 + 本地后端。

## 常见坑

- **CORS**：后端 `CORS_ORIGIN=*` 仅用于开发；生产需改为小程序域名。
- **字段命名**：后端用 camelCase（如 `deviceId`、`textbookId`），数据库存储也是 camelCase。
- **时间格式**：后端返回 ISO 8601 字符串（如 `2026-09-25T09:11:00.657Z`）。
- **401/403**：token 过期或设备不属于当前用户；前端应重新登录或提示无权限。
- **代理配置**：小程序开发版直连 `127.0.0.1:3000`；真机需 HTTPS 域名或开启「不校验合法域名」。
- **前端请求封装**：`deda-wechat-app/miniprogram/utils/request.ts` 当前 Authorization header 有语法错误，联调前需修复。

## 单次联调最小文件集示例

以「切换自由对话子模式」为例：

- 后端：`src/modules/device-configs/device-configs.controller.ts`、`src/modules/device-configs/device-configs.service.ts`、`src/modules/conversation-modes/conversation-modes.controller.ts`。
- 前端：`deda-wechat-app/miniprogram/pages/choose-free-chat-mode/choose-free-chat-mode.ts`、`deda-wechat-app/miniprogram/api/api.ts`。
