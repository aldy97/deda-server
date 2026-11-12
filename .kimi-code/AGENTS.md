# deda-server 项目指令（NestJS 后端）

## 联调契约（服务端为唯一真相源）

1. 接口契约唯一真相是本仓库的实现 + Swagger（/api/docs）+ MINI_PROGRAM_API.md；
   跨仓联调口径以 docs/integration.md 为准。
2. 改接口的固定顺序：先改本仓库 DTO/Controller/Service/测试 →
   同步 MINI_PROGRAM_API.md 与 docs/integration.md → 再改消费方前端
   （deda-wechat-app 的 miniprogram/api/api.ts → 页面；
   deda-dashboard 的 API 层 → 组件）。单次任务默认只改一个仓库；
   需要多仓同改时我会明说。
3. 统一响应信封 { code, message, data }，code=0 为成功；
   deviceId 是业务 ID 不是数据库 UUID；时间字段一律 ISO 8601；字段命名 camelCase。

## 后端工程规则

4. 遵守本仓库根目录 AGENTS.md：统一响应/JWT 守卫/全局 interceptor/filter、
   Prisma schema、鉴权、错误码的改动属于 Ask first；breaking change 必须先问。
   新增依赖、prisma migrate、commit/push 同理。
5. 改 controller/service 必须同步补改 *.spec.ts（与 TDD 铁律一致）；
   e2e 只打 TEST_DATABASE_URL 指向的隔离测试库（库名含 test）。
