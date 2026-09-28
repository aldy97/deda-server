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
| 设备列表/绑定/解绑 | `GET /devices`<br>`POST /devices/bind`<br>`DELETE /devices/:id`                                                                  | `pages/device-list/device-list.ts`<br>`pages/device-bind/device-bind.ts`                               | `src/modules/devices/devices.controller.ts`                                                                                    | 空列表时前端自动绑定 DEV001         |
| 查询设备当前配置   | `GET /device-configs/:deviceId/current`                                                                                          | `pages/device-list/device-list.ts` 等                                                                  | `src/modules/device-configs/device-configs.controller.ts`                                                                      | 多页面共用                          |
| 切换对话模式       | `POST /device-configs/:deviceId/mode`                                                                                            | `pages/switch-mode/switch-mode.ts`                                                                     | `src/modules/device-configs/device-configs.controller.ts`                                                                      | 点分类仅跳转子页,不在此页保存;mode-only 载荷 400 |
| 选择自由对话子模式 | `GET /conversation-modes?categoryKey=free_chat`<br>`POST /device-configs/:deviceId/mode`                                         | `pages/choose-free-chat-mode/choose-free-chat-mode.ts`                                                 | `src/modules/conversation-modes/conversation-modes.controller.ts`<br>`src/modules/device-configs/device-configs.controller.ts` | 子页提交完整载荷（mode+conversationModeKey） |
| 选择教材单元       | `GET /textbooks`<br>`GET /textbooks/:id/units`<br>`POST /device-configs/:deviceId/apply`                                         | `pages/textbook-learning/textbook-learning.ts`<br>`pages/choose-textbook-unit/choose-textbook-unit.ts` | `src/modules/textbooks/textbooks.controller.ts`<br>`src/modules/device-configs/device-configs.controller.ts`                   | apply 保存 textbookId + unitId      |
| 查询对话记录       | `GET /conversations?page&pageSize&deviceId`                                                                                      | `pages/chat-history/chat-history.ts`                                                                   | `src/modules/conversations/conversations.controller.ts`                                                                        | 一条 item=一条消息（turnId 关联成轮）；page=1 为最新一页，页内时间正序（顶老底新），前端勿再自行反转；删除接口已移除；URL 无语境参数时前端按设备当前配置推导过滤（后端只认显式传参、不读配置） |
| 孩子档案查询/更新  | `GET /child-profiles/device/:deviceId`<br>`PATCH /child-profiles/device/:deviceId`                                               | `pages/owner-info/owner-info.ts`                                                                       | `src/modules/child-profiles/child-profiles.controller.ts`                                                                      | 一个设备对应一个孩子档案            |
| 学习全览 MVP       | `GET /learning-stats/dashboard`<br>`GET /learning-stats/daily`<br>`GET /learning-stats/topics`<br>`GET /learning-stats/timeline` | `pages/learning-data/learning-data.ts`                                                                 | `src/modules/learning-stats/learning-stats.controller.ts`<br>`src/modules/learning-stats/learning-stats.service.ts`            | 仪表盘/趋势/主题/时间线             |
| 智能分析（单设备） | `GET /learning-stats/dashboard?range=`<br>`GET /learning-stats/daily`<br>`GET /learning-stats/activities`<br>`GET /learning-stats/unit-progress/:deviceId` | `pages/device-analysis/device-analysis.ts`                                                             | 同上                                                                                                                            | 顶部语境选择器：查看任何教材/单元/自由对话均为只读,**不修改设备配置**（家长看不打断孩子练习）;缺省=当前配置模式族;指标卡/趋势/动态随 tab 走 range（自然历）且随语境过滤;趋势今日=摘要卡/本月=周聚合;topics 全量（教材族带 avgScore,free_chat 按子模式不评分）;单元进度全量,free_chat 语境下隐藏 |

## 设备配置入参校验

`POST /device-configs/:deviceId/mode` 与 `POST /device-configs/:deviceId/apply` 对 `mode` / `textbookId` / `unitId` / `conversationModeKey` 做服务端强校验：

| mode | textbookId | unitId | conversationModeKey |
| ---- | ---------- | ------ | ------------------- |
| `free_chat` | 禁止 | 禁止 | **必填**，须为启用中的 free_chat 分类子模式 |
| `textbook_learning` | **必填** | 可选 | 可选，若给须为 textbook_learning 分类子模式 |
| `locked_unit` | **必填** | **必填** | 可选，若给须为 textbook_learning 分类子模式 |
| `free_textbook` | **必填** | 禁止 | 可选，若给须为 textbook_learning 分类子模式 |

错误语义：

- `400`：mode 不在枚举内、违反上表必填/禁止规则、`conversationModeKey` 不存在/未启用/分类与 mode 不匹配。
- `404`：提供的 `textbookId` 不存在，或 `unitId` 不属于该教材。

前端对齐：`pages/switch-mode/switch-mode.ts`、`pages/choose-free-chat-mode/choose-free-chat-mode.ts`、`pages/textbook-learning/textbook-learning.ts`、`pages/choose-textbook-unit/choose-textbook-unit.ts` 需保证按上表带齐必填字段、不带禁止字段，否则会被 400 拒绝。

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
- **字段命名**：后端用 camelCase（如 `deviceId`、`textbookId`），数据库存储也是 camelCase。
- **时间格式**：后端返回 ISO 8601 字符串（如 `2026-09-25T09:11:00.657Z`）。
- **401/403**：token 过期或设备不属于当前用户；前端应重新登录或提示无权限。
- **代理配置**：小程序开发版直连 `127.0.0.1:3000`；真机需 HTTPS 域名或开启「不校验合法域名」。
- **前端请求封装**：`deda-wechat-app/miniprogram/utils/request.ts` 当前 Authorization header 有语法错误，联调前需修复。

## 单次联调最小文件集示例

以「切换自由对话子模式」为例：

- 后端：`src/modules/device-configs/device-configs.controller.ts`、`src/modules/device-configs/device-configs.service.ts`、`src/modules/conversation-modes/conversation-modes.controller.ts`。
- 前端：`deda-wechat-app/miniprogram/pages/choose-free-chat-mode/choose-free-chat-mode.ts`、`deda-wechat-app/miniprogram/api/api.ts`。
