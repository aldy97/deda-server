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

## PR 正文规范（模板是唯一事实来源）

6. 段落骨架只写在 `.github/PULL_REQUEST_TEMPLATE/` 里，本节只写「何时用哪个」：
   base=staging → `feature-to-staging.md`；base=main → `release-to-main.md`。
   **两条创建路径，都要显式指名模板**（仓库内有多个模板时 gh 非交互模式不会自动选）：
   - agent 自己写正文：`gh pr create --body-file <已按骨架填好的正文>`；
   - 人工/交互式创建：`gh pr create --template <file>` 取骨架再填。
   `--template` 与 `--body`/`--body-file` 是两条路径，不要同时传。
7. 「需要人工测试的地方」按责任人分子段，**子段清单由模板决定**（本仓 feature 模板是三段：
   作者已实测（合并前）／合并到 staging 后需要人工点／上线 prod 后需要人工点（批准 production 之后））。
   每项必须带期望结果，勾上的必须带取证；确实无需人工测试 → 写「无」+ 一句理由。
   **禁止留空、禁止删段**：空 = 歧义，`无 + 理由` = 可审计。
8. `ci.yml` 的 `pr-hygiene` job 跑 `.github/scripts/pr-hygiene.mjs`。**段表不写在脚本里，而是从模板
   派生**：base → 模板的映射在 `.github/pr-hygiene.json`（`default` 必填，`byBase` 可省略）。派生规则：
   模板最浅一级标题 = 必需段；若最浅一级只有 1 个标题且下面还有更深一级（包裹 H2 + H3 的习惯），必需段
   取深一级那批、包裹标题不判定；必需段下再深一级 = 该段的必需子段（所以人工测试三段子段是自动裁剪的，
   模板只写两段闸口就只查两段）。段落内容含 `<!-- optional -->` → 该段可整段缺席，但写了标题仍须非空。
   正文侧对层级宽容（H2/H3 都认），「平铺 H2」与「包裹 H2 + H3」两种写法都放行。**改模板即改闸口，不
   需要同步改脚本段表**；只有改派生规则时才动脚本与 `src/common/workflows/pr-hygiene-gate.spec.ts`。
   闸口 fail-open：`PR_BODY` 未注入、配置／模板读不到或畸形、脚本自身异常，一律 exit 0 并在 stdout 打印
   含 `fail-open` 的原因；只有明确缺段／空段才 exit 1。它**不进**分支保护 required checks，但按铁律 6
   「CI 全绿才允许 merge」，红了就不许合。
   `.github/scripts/pr-hygiene.mjs` 是三仓（deda-server / deda-dashboard / deda-wechat-app）**逐字节
   相同**的副本：改它必须三仓同改并用 `shasum -a 256` 比对一致；仓库差异只允许落在
   `.github/pr-hygiene.json` 与 `PULL_REQUEST_TEMPLATE/` 两处。
9. PR 有未勾的「合并到 staging 后需要人工点」项时，创建时带 `--label 人工验证`。

## 子任务验收命令（多代理协作协议第 3 条锚点）

主代理审查子代理产出时，必须亲自运行：
`tsc --noEmit` 全绿 + 相关 `*.spec.ts` 全部通过。
