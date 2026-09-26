# Deda Server — Agent 入口

AGENTS.md 已被调用。

这是 **deda-server**（后端仓库）。前端仓库是 **deda-wechat-app**。
跨仓联调以 `docs/integration.md` 为准；接口契约以本仓库实现 + Swagger 为准。

## Agent 速查（TL;DR）

1. 先读 `docs/integration.md` 对应节，再只读当前链路相关文件。
2. 优先用 grep/glob；禁止通读目录、大文件、lockfile、dist、node_modules。
3. 单次任务读 + 改 + 新增测试 ≤ 8 个业务文件；超出必须拆分或询问。
4. 改接口先改本仓库契约/实现，再说明前端应对齐 `docs/integration.md` 哪一节。
5. 单次任务默认只改一个仓库；不要猜测或修改前端内部实现。
6. 直接访问公开 URL 搜索/查证无需每次询问。
7. 任何改动不会自动 commit/push，除非用户明确申明。

## 项目上下文

NestJS + Prisma 后端 API。运行时与包管理器以 `package.json` / `.nvmrc` 为准。只用 npm。

## 命令速查

```bash
npm install
npm run start:dev
npm run test
npm run test -- path/to/foo.spec.ts
npm run test:e2e
npm run lint
npm run typecheck
npx prisma migrate deploy --schema=src/prisma/schema.prisma
```

- `lint` / `typecheck` / coverage：无对应脚本则跳过并注明，不要编造。
- `prisma generate` / `prisma migrate dev` / 写库命令：Ask first。
- 未批准不得 `npm install` 新包。

## Token 与效率规则

- 优先用 grep/glob，禁止 `find` / `cat` / 通读整个文件。
- 需要读多段时，一次 response 内并行调用多个 view。
- 单次回复尽量 ≤100 字；不要复述 AGENTS.md 全文（除本声明）。
- 搜索结果只列前 5 个；禁止为「全面」而 dump 大量代码。
- 同一符号不要重复搜索；搜到后先读再决定下一步。
- 公开 URL 搜索/查证直接访问，无需询问。
- 命令失败即报告退出码和关键日志，停止编造结果。

## 跨仓联调规则

- 后端是接口契约唯一真相。
- 改接口先改本仓库 DTO / Controller / Service / 测试，再指前端对齐 `docs/integration.md` 哪一节。
- 单次任务默认只改一个仓库；同时改两侧必须用户明确说。
- 不要猜测前端状态管理、路由守卫、组件内部实现。

## 工作规则

1. 先列出将读取/修改的文件，确认后再改代码。
2. 改 controller / service 时同步补或改对应 `*.spec.ts`。
3. 最小 diff：不格式化无关文件，不重构计划外模块，不删仍被引用的兼容逻辑。
4. 改已有 util / service / DTO / endpoint / Prisma / 错误码前，先定向搜引用并评估兼容性（见 Compatibility）。
5. 日志与测试禁止输出 token、密码、手机号、证件号等真实 PII。

## Plan Mode

触发：Plan / 规划 / 先出方案 / 不要改代码；或改接口契约、Prisma、跨模块、公共 util、已有 endpoint、合计触及 ≥3 个业务文件。

进入 Plan Mode 后，完整模板见 `docs/agent-plan-template.md`。硬约束摘要：

- 只读，禁止先改再补计划。
- 计划获批前不落测试文件、不写实现。
- 读 + 改 + 新增测试 ≤ 8；超出拆分或询问。
- 上一轮批准不自动带到本轮，除非用户写「按上次 plan 执行」。

## Compatibility

改已有公共符号时默认向后兼容。

| 改动                                            | 默认 | 条件                          |
| ----------------------------------------------- | ---- | ----------------------------- |
| 新增可选字段 / 新 endpoint                      | 可以 | Plan 注明旧客户端可忽略       |
| util 新参数且有默认值                           | 可以 | 已搜引用，无按参数个数调用    |
| 模块内 private 函数改签名                       | 可以 | Plan 写明「已确认无外部引用」 |
| 删字段、改类型/枚举值、改 URL、改鉴权、改错误码 | 禁止 | Plan 标 breaking，Ask first   |
| 改统一响应 / 全局 filter / JWT 守卫             | 禁止 | Ask first                     |
| 改 Prisma 列类型 / 删列 / 改唯一约束            | 禁止 | breaking + Ask                |
| 改分页默认、ID/时间格式、WS 事件名              | 禁止 | breaking + Ask                |

## Boundaries

### Always

- 改动保持在任务范围内；先列文件再动手。
- 命令失败则报告失败，然后停下。
- 沿用 Nest 分层：controller → service → prisma；入参走 DTO / ValidationPipe；响应走 interceptor；错误走 filter。

### Ask first

- 新增或升级依赖。
- 改 Prisma schema / `prisma generate` / migration。
- 改统一响应、JWT 守卫、全局 interceptor / filter。
- 任何 breaking change。
- 改全局 prefix、端口、CORS、Swagger 公开范围。
- 任何 commit / push / tag / amend。
- 单次任务将超过 8 个业务文件。
- 对外部 vendor / 真实网络的写操作。
- 同一测试连续修 3 次仍红。
- 覆盖率有脚本但改动文件达不到 90%，补测后仍不够。

### Never

- 提交 `.env*`、密钥、pem、credentials。
- 打开或修改真实 `.env` 并把内容写进回复。
- 把 lockfile、`node_modules`、`dist`、Prisma Client 生成物、coverage 产物读进上下文或手改提交。
- `git push`、`--force`、`reset --hard`、`rm -rf`（除非用户明文要求）。
- 自动 commit / push；改 git config；amend 非本次自己的 commit。
- 猜测并修改前端仓代码或前端内部实现。
- 只改一处调用就改公共 util / DTO 签名或语义。
- 关闭或绕过 JWT「先打通再补」。
- 为绿测试而删断言或改预期迁就错误实现。
- 测试夹具使用真实用户数据或真实密钥；单测出网。
- 引入 `any` 或 disable lint 来过关。
- 改 CI / Docker / 部署配置（除非任务就是这个）。
- 把「没跑测试 / 测试红了 / 不确定 / 口算覆盖率」说成「已验证通过」。

## Testing — 完成定义

- 单测：优先改 / 补与改动同模块的 `*.spec.ts`。
- e2e：仅跨模块接口或鉴权/契约变化时跑 `npm run test:e2e`。
- 改 controller / service：至少覆盖成功路径、鉴权失败、校验失败。
- 改公共 util / DTO / endpoint：补旧调用方仍可用的用例。
- vendor / 微信 / 机芯厂：mock，禁止真实网络；e2e 只用仓库 test DB。
- 手工验证：`curl` 调 `/users/login` 拿 token，再带 `Authorization: ****** 调目标接口。不要把 token 写进仓库文件。

完成标准：

1. 已批准 plan 中的文件都已改完，没有计划外文件。
2. TDD 顺序已遵守，或属于文档/重命名类豁免并已声明。
3. 相关测试已跑且为绿。
4. lint / typecheck：有脚本就跑；没有注明「仓库无此脚本」。
5. 契约若有变：Swagger 与实现对齐，并写明 `docs/integration.md` 应对齐的节。
6. 兼容性：旧调用路径未在未批准情况下被破坏；breaking 已标明并获批。
7. 有 coverage 脚本则附改动文件行覆盖率；无则明确「未测覆盖率」。

完成报告必须输出：命令原文、pass/fail 计数、覆盖率数字或「无 coverage 脚本」、未跑项 + 原因。

## Git & Style

- 默认不 commit、不 push，除非用户明确说「提交/推送」。
- 一个逻辑一个 commit；信息用约定式，如 `feat(devices): ...`。
- 提交前至少跑相关单测；有 lint/typecheck 脚本则跑。
- 不改 git config，不 amend 别人的 commit，不 `--force`。
- 以仓库 ESLint / Prettier 为准；新增字段/枚举与 Swagger decorator 同步；不引入重复工具库。

## 从哪读起

| 改动类型        | 先读                                                        |
| --------------- | ----------------------------------------------------------- |
| 鉴权            | `jwt.strategy.ts`、`jwt-auth.guard.ts`，再改业务 controller |
| Prisma / 表结构 | `src/prisma/schema.prisma` + 对应 module service            |
| vendor / 机芯厂 | `vendor.controller.ts` 与 `vendor.gateway.ts` 一起看        |
| 统一响应 / 错误 | `response.interceptor.ts`、`http-exception.filter.ts`       |
| 联调字段        | `docs/integration.md` 对应节 + 本仓 DTO / controller        |

目录：`src/modules/` 业务模块；`src/common/` 全局拦截器/异常；`src/prisma/` schema 与迁移。

## 关键路径

| 用途              | 文件                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| 入口/端口/Swagger | `src/main.ts`                                                                                    |
| 统一响应/异常     | `src/common/interceptors/response.interceptor.ts`、`src/common/filters/http-exception.filter.ts` |
| JWT 鉴权          | `src/modules/users/strategies/jwt.strategy.ts`、`src/modules/users/guards/jwt-auth.guard.ts`     |
| 登录              | `src/modules/users/users.controller.ts`                                                          |
| 设备              | `src/modules/devices/devices.controller.ts`                                                      |
| 设备配置          | `src/modules/device-configs/device-configs.controller.ts`                                        |
| 对话记录          | `src/modules/conversations/conversations.controller.ts`                                          |
| 孩子档案          | `src/modules/child-profiles/child-profiles.controller.ts`                                        |
| 对话模式          | `src/modules/conversation-modes/conversation-modes.controller.ts`                                |
| 教材单元          | `src/modules/textbooks/textbooks.controller.ts`                                                  |
| 机芯厂对接        | `src/modules/vendor/vendor.controller.ts`、`src/modules/vendor/vendor.gateway.ts`                |
| Prisma schema     | `src/prisma/schema.prisma`                                                                       |
| 联调契约          | `docs/integration.md`                                                                            |

## AGENTS.md 维护

- 修改本文件前评估 token 影响；保持 ≤200 行。
- 新增规则必须说明理由；禁止堆砌重复约束。
