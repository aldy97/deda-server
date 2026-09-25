# Deda Server — Agent 入口

这是 **deda-server**（后端仓库）。前端仓库是 **deda-wechat-app**。

跨仓联调以 `docs/integration.md` 为准；接口契约以本仓库实现 + Swagger 为准。

## 工作规则（必读）

1. 先读 `docs/integration.md`，再只读当前链路相关文件。
2. 禁止扫描整个仓库；单次任务最多打开 8 个业务文件。
3. 改接口先改本仓库契约/实现，再说明前端应对齐 `docs/integration.md` 哪一节。
4. 不要猜测前端状态管理、路由守卫、组件内部实现。
5. 先列出将读取/修改的文件，确认后再改代码。
6. 不要把 lockfile、构建产物、依赖目录读进上下文。
7. **任何改动都不会自动推送 commit and push，除非我申明。**

## 快速启动

```bash
# 安装依赖
npm install

# 本地开发（watch，端口 3000）
npm run start:dev

# 单元测试
npm run test

# e2e 测试
npm run test:e2e

# 数据库迁移（非交互环境用 deploy）
npx prisma migrate deploy --schema=src/prisma/schema.prisma
```

## 验证改动

- 接口改动：优先补/改对应 `*.spec.ts`，再跑 `npm run test`。
- 端到端：跑 `npm run test:e2e`。
- 手动验证：用 curl 调 `/users/login` 拿 token，再带 `Authorization: Bearer <token>` 调目标接口。

## 关键路径

| 用途 | 文件 |
|------|------|
| 入口/端口/Swagger | `src/main.ts` |
| 统一响应/异常 | `src/common/interceptors/response.interceptor.ts`、`src/common/filters/http-exception.filter.ts` |
| JWT 鉴权 | `src/modules/users/strategies/jwt.strategy.ts`、`src/modules/users/guards/jwt-auth.guard.ts` |
| 登录 | `src/modules/users/users.controller.ts` |
| 设备 | `src/modules/devices/devices.controller.ts` |
| 设备配置 | `src/modules/device-configs/device-configs.controller.ts` |
| 对话记录 | `src/modules/conversations/conversations.controller.ts` |
| 孩子档案 | `src/modules/child-profiles/child-profiles.controller.ts` |
| 对话模式 | `src/modules/conversation-modes/conversation-modes.controller.ts` |
| 教材单元 | `src/modules/textbooks/textbooks.controller.ts` |
| 机芯厂对接 | `src/modules/vendor/vendor.controller.ts`、`src/modules/vendor/vendor.gateway.ts` |

## 日志

本地开发默认 pino 输出到 stdout；`LOG_LEVEL=info` 在 `.env` 中配置。
