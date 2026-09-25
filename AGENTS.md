````markdown
# Deda Server — Agent 入口

这是 **deda-server**（后端仓库）。前端仓库是 **deda-wechat-app**。

跨仓联调以 `docs/integration.md` 为准；接口契约以本仓库实现 + Swagger 为准。

## Overview

NestJS + Prisma 后端 API。不要按全栈仓处理，不要猜测或修改前端实现。
运行时与包管理器以本仓 `package.json` / `.nvmrc` 为准。
改接口：先改本仓契约与实现，再说明前端应对齐 `docs/integration.md` 哪一节。

## Commands

只运行下面列出的命令；不要发明不存在的 npm script。

```bash
# 安装依赖
npm install

# 本地开发（watch，端口 3000）
npm run start:dev

# 单元测试（全量）
npm run test

# 单元测试（单文件）
npm run test -- path/to/foo.spec.ts

# e2e
npm run test:e2e

# Lint / 类型检查（若 package.json 无对应脚本，则跳过并注明，不要编造）
npm run lint
npm run typecheck

# 数据库迁移（非交互环境用 deploy）
npx prisma migrate deploy --schema=src/prisma/schema.prisma
```
````

本地开发默认 pino 输出到 stdout；`LOG_LEVEL=info` 在 `.env` 中配置。
不要把 lockfile、构建产物、`node_modules`、覆盖率产物读进上下文。

## 工作规则（必读）

1. 先读 `docs/integration.md`，再只读当前链路相关文件。
2. 禁止扫描整个仓库；单次任务最多打开 8 个业务文件。
3. 改接口先改本仓库契约/实现，再说明前端应对齐 `docs/integration.md` 哪一节。
4. 不要猜测前端状态管理、路由守卫、组件内部实现。
5. 先列出将读取/修改的文件，确认后再改代码。
6. 不要把 lockfile、构建产物、依赖目录读进上下文。
7. **任何改动都不会自动 commit / push，除非用户明确申明。**
8. 改已有 util、service 方法、DTO、endpoint 前，必须先评估调用方与兼容性（见 Compatibility）。

## Plan Mode（每次进入都必须遵守）

触发：当前是 Plan / 规划 / 先出方案 / 不要改代码；或任务将改接口契约、Prisma、跨模块、公共 util、已有 endpoint、或 ≥3 个业务文件。

硬约束：

- 只读。禁止 Write / Edit / 会改仓库状态的命令。禁止「先改一点再补计划」。
- 未列出将读取的文件并得到确认前，只打开当前链路相关文件；单次任务业务文件仍 ≤ 8。
- 先读 `docs/integration.md` 对应节。契约以本仓库实现 + Swagger 为准。
- 不要猜测前端状态管理、路由守卫、组件内部实现。前端只标注应对齐 `docs/integration.md` 哪一节。
- 上一轮批准不自动带到本轮。用户新消息 = 新计划，除非用户写「按上次 plan 执行」。
- 计划未获用户明确批准（「按此执行」/ `LGTM` / `build`）前，不得进入实现。
- 实现时必须按已批准 plan 的文件表逐项改；新增文件或偏离 plan 时先停，更新 plan，再等确认。

### 不确定就问（禁止擅自定需求）

必须先问、禁止自己选「最佳实现」的情况：

- 需求、验收标准、错误码/状态码、字段含义或默认值不明确
- 兼容策略不明确（兼容旧调用方 vs breaking）
- 是否改 Prisma / 统一响应 / JWT / 已发布契约不明确
- 测试范围或「是否要 e2e」不明确

可以自己定、不必问的情况：

- 符合本仓现有分层、命名、DTO、测试文件摆放的写法
- 局部变量、函数拆分、与现有 spec 同样风格的断言

问的时候给选项（A/B）和推荐，不要先写代码。

### TDD（批准之后才执行）

顺序固定，不允许颠倒：

1. 按 plan 先写/改会失败的测试：模块内 `*.spec.ts`（unit）。触及跨模块鉴权/契约时再加 e2e（`npm run test:e2e`），不要发明仓里不存在的测试体系。
2. 先跑测试，确认新断言为红（或明确写为什么没法先红，例如只补已有用例）。
3. 再写实现。
4. 再跑同一批测试，必须变绿。
5. 覆盖率只计**本次改动的源码文件**（不含 `*.spec.ts`、生成物）。用仓库已有 coverage 命令测量；没有该脚本就跑相关测试并注明「无法测覆盖率」，禁止口算 90%。
6. 有 coverage 命令时，改动文件行覆盖率目标 90%。达不到：先补测试；仍达不到则列出未覆盖分支和原因，Ask first，不得假装达标。

Plan 第 4 节必须列出将写的测试文件、要锁的行为（成功 / 鉴权失败 / 校验失败 / 旧调用方兼容），并计入 8 个业务文件上限。

每次 Plan 必须按下面模板输出，缺任一块视为未完成：

### 1. 目标与非目标

- 要做成什么（可验收的一句话）
- 明确不做的事

### 2. 现状（必须有文件路径）

- 相关现有行为，引用 `path`
- 已读文件列表（路径 + 为什么读）
- 公共符号的引用搜索结果（util / service 方法 / DTO / 路由）

### 3. 方案对比

至少 2 个方案，除非真的只有一种合法改法。
每个方案写：改动面、对契约 / DB / 已有调用方 / 前端联调的影响、风险。
然后给出推荐方案 + 理由 + 淘汰理由。
默认选向后兼容方案；选 breaking 必须写清理由并放入「待确认」。

### 4. 完整代码修改方案（必须穷尽）

| 文件    | 动作           | 具体改什么                                        | 理由                 | 风险 / 回滚 |
| ------- | -------------- | ------------------------------------------------- | -------------------- | ----------- |
| src/... | 改 / 新增 / 删 | 函数、DTO、路由、字段级说明，禁止只写「调整逻辑」 | 为什么必须动这个文件 | 影响面      |

另外必须写清：

- 不改的文件，以及为什么不改
- 接口契约是否变化；若变，对齐 `docs/integration.md` 哪一节、Swagger 哪条
- 是否需要 migration；若需要，schema 字段级说明
- 调用方影响：本仓引用点（路径 + 符号）；是否被 Swagger / `docs/integration.md` 暴露；其他端是否必须同步；兼容策略（加可选字段 / 新 endpoint / 默认参数 / 弃用期 / breaking）
- 测试计划：改 / 补哪些 `*.spec.ts` 或 e2e，以及手动验证步骤
- 文件总数是否 ≤ 8 个业务文件；超出则拆任务或先问用户

### 5. 执行顺序

编号步骤，每步写依赖和完成标准（例如「相关单测绿」「Swagger 字段与实现一致」「旧调用方仍能用」）。

### 6. 待确认问题

有歧义先提问，不要把猜测写进「将修改」表。
没有问题则写：「无，可批准执行。」

结束语必须是：

> 以上为完整修改方案，等待确认后再改代码。

计划不合格时（缺文件表、缺理由、缺测试计划、缺调用方影响、缺方案对比）：停止，按模板重出，不要改代码。

## Compatibility（后端改动适配性）

改已有 util、service 方法、DTO、enum、endpoint 时：

1. 先在本仓搜索该符号 / 路由的全部引用，再决定怎么改。只看见当前任务的一处调用，不得改公共签名或语义。
2. 默认向后兼容：
   - 可以：新增可选字段、新 endpoint、util 新参数且有默认值、只扩展不删减的枚举（仍需确认序列化侧）
   - 不可以直接做：删字段、改字段类型或含义、改 URL / HTTP 方法、改状态码或错误码、把可选变必填、收窄入参、改统一响应信封
3. 做不到兼容则标为 **breaking**：列出本仓引用点，以及 `docs/integration.md` / Swagger 中受影响的节；Ask first，未批准不得改。
4. 不要猜测前端代码怎么改。只写前端应对齐哪一节、哪个字段、旧值是否仍合法。
5. 引用点加上计划内文件将超过 8 个业务文件：拆任务或先问，禁止为「顺便适配」扩大扫描和改动面。
6. 禁止为当前任务顺手删除仍被引用的字段、重载或兼容分支。

| 改动                                              | 默认       | 条件                             |
| ------------------------------------------------- | ---------- | -------------------------------- |
| 新增可选字段 / 新 endpoint                        | 可以       | Plan 中注明旧客户端可忽略        |
| util 新参数且有默认值                             | 可以       | 已搜引用，无按参数个数的特殊调用 |
| 模块内、已确认无外部引用的 private 函数改签名     | 可以       | Plan 写明「已确认无外部引用」    |
| 删字段、改类型 / 枚举值、改 URL、改鉴权、改错误码 | 禁止直接做 | Plan 标 breaking，等批准         |
| 改统一响应 / 全局 filter / JWT 守卫               | 禁止直接做 | 见 Boundaries Ask first          |

## Boundaries

### Always

- 改动保持在任务范围内；先列将读 / 改的文件，确认后再动手。
- 接口改动先改本仓契约 / 实现，再指出 `docs/integration.md` 对应节。
- 改 controller / service 时同步补或改对应 `*.spec.ts`。
- 改已有公共符号前先搜引用，默认保持向后兼容。
- 命令失败则报告失败，然后停下。

### Ask first

- 新增或升级依赖
- 改 Prisma schema / 跑 migration
- 改统一响应、JWT 守卫、全局 interceptor / filter
- 任何 breaking change（删字段、改类型/枚举值、改 URL、改鉴权、改错误码、收窄 util 入参）
- 任何 commit / push / 打 tag / amend
- 改 `docs/integration.md` 里已发布字段的含义
- 单次任务将超过 8 个业务文件
- 对外部 vendor / 真实网络的写操作

### Never

- 提交 `.env*`、密钥、pem、credentials
- 打开或修改真实 `.env` 并把内容写进回复（只参考 `.env.example` 的键名）
- 把 lockfile、`node_modules`、`dist`、覆盖率产物读进上下文
- `git push`、`--force`、`reset --hard`、`rm -rf`（除非用户明文要求）
- 自动 commit / push
- 猜测并修改前端仓代码或前端内部实现
- 手改 Prisma Client 生成物（只改 `schema.prisma`，生成步骤先问）
- 擅自改 lockfile（除非这次就是已批准的加依赖）
- 只改一处调用就改公共 util / 公共 DTO 的签名或语义
- 为当前任务顺手「清理」仍被引用的字段或兼容逻辑
- 把「没跑测试 / 测试红了 / 不确定」说成「已验证通过」

## Testing — 完成定义

- 单测：优先改 / 补与改动同模块的 `*.spec.ts`。
- e2e：涉及跨模块接口或鉴权链路时跑 `npm run test:e2e`。
- 改 controller / service：至少覆盖成功路径、鉴权失败、校验失败。
- 改公共 util / DTO / endpoint：补旧调用方仍可用的用例（缺字段、旧枚举、旧错误码若仍应成立）。
- 外部 vendor / 微信 / 机芯厂：mock，禁止打真实网络。
- 手工验证（如需要）：`curl` 调 `/users/login` 拿 token，再带 `Authorization: Bearer <token>` 调目标接口。

完成标准（全部满足才算做完）：

1. 已批准 plan 中的文件都已改完，没有计划外文件（除非已再次确认）。
2. 相关单测已跑且为绿；该跑而没跑的，必须写明「未跑 + 原因」。
3. lint / typecheck：有脚本就跑；没有脚本就注明「仓库无此脚本」，不要假装跑过。
4. 契约若有变：Swagger 与实现对齐，并写明 `docs/integration.md` 应对齐的节。
5. 兼容性：旧调用路径未在未批准的情况下被破坏；breaking 已在 plan 中标明并获批。

## When things fail

- 命令失败：报告退出码和关键日志，停止继续实现或编造结果。
- 不确定：提问。不要把猜测写成已证实行为。
- 发现必须改计划外文件或额外调用方：先停，更新文件表，等确认。
- 禁止用「应该没问题」「按惯例可以通过」代替实际命令输出。

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
