# Prompt 注册表（prompt registry）

> 适用范围：deda-server 全部**系统 prompt / 规则段 / 话术模板**的唯一读写入口。
> 实现：`src/modules/prompt-registry/`（运行时）+ `src/modules/analytics/prompt-admin.*`（后台）。
> Dashboard 契约见 `docs/analytics-api.md` → 「Prompt 管理」。

## 为什么需要

改造前 prompt 以字符串字面量散落在 4 个业务 service 里（`vendor.service.ts`、
`llm-adapter.service.ts`、`llm.service.ts`、`child-safety.service.ts`），
外加 `conversation-session.service.ts` / `child-memories.service.ts` /
`sleep-voice-config.service.ts` 各一份。后果：

- 改一句话术要发一次版，无法灰度、无法回滚；
- 同一份文本在多处复制粘贴后**已经漂移**（见文末「已知漂移」）；
- 没有「谁在什么时候、为什么改了这句话」的审计链。

现在：**17 个可编辑 prompt 集中在 `PROMPT_DEFAULTS`**，运行时经
`PromptRegistryService` 读取，后台经 `/analytics/prompts` 查看 / 编辑 / 发布。

## 运行时架构

```
业务 service（llm / vendor / llm-adapter / child-safety / child-memories / sleep-configs）
        │  只调用**同步**方法：getTemplate / render / getPersona / getStoryPrompt
        ▼
PromptRegistryService ── 内存 Map 缓存（TTL 60s，stale-while-revalidate）
        │                         ▲
        │ 读取优先级               │ 后台重载（不阻塞热路径）
        ▼                         │
   ① DB published 版本 ────── prompt_templates / prompt_template_versions
   ② 代码 PROMPT_DEFAULTS
   ③ 抛 PromptRenderError（属代码 bug，绝不静默把 {{x}} 发给模型）
```

### 为什么对外只有同步方法

`LlmService` 的三个 prompt builder（`buildFillerPrompt`、
`buildAdventureInteractionPrompt`、`buildEnglishTutorPrompt`）都是同步的，
改成 async 会波及全部调用点与 160+ 既有测试。因此注册表用
**启动预载（`onModuleInit`）+ 内存缓存 + 后台刷新**换取热路径零 `await`、零 DB 往返：

- 缓存过期后，同步读取**立即返回旧值**，同时触发一次后台 `reload()`；
- 后台失败只记 warn，并进入 5s 冷却（`FAILURE_RETRY_MS`），不重复撞挂掉的库；
- 并发读取由 `inFlight` 去重成一次 DB 往返。

代价：多实例部署时，一台发布后其余实例最长滞后 60s。
当前是单实例（`docker-compose.prod.yml` 无 replicas、`container_name: deda-server-prod`），
且发布路径会 `await reload()` 原子换入，本机立即生效。

### 为什么变更后是 `reload()` 而不是「清缓存」

清空缓存会让下一次读取在后台重载完成前**回落代码默认值**——
等于刚发布的安全分类器 prompt 有一个窗口期不生效。
`reload()` 是「读到新数据后整体替换」，切换原子，不存在中间态。
（因此注册表**不提供** `invalidate()`：它是个陷阱，已删除。）

## 首次上线行为零变化

启动不 seed 数据库，DB 无 published 版本时全部 key 回落代码默认值，
即改造前那 7 个文件里的原始字面量。等价性由
`src/modules/prompt-registry/__fixtures__/prompt-goldens.json`（46 个用例）+
`prompt-golden.spec.ts` 锁死：fixture 采集自基线 commit `eed5073`，
重构前后 spec 断言**一字未改**且全绿。

数据库行是**惰性创建**的：admin 第一次保存草稿时才建 `prompt_templates` 行；
两个 admin 同时首次建行靠唯一键冲突（P2002）重读收敛。

## 17 个可编辑 key

变量列：`*` = 必填（缺失/空串/纯空白 → 渲染抛错），`?` = 可选（缺省渲染为空串）。

| category | key | scene | 名称 | 变量 |
| --- | --- | --- | --- | --- |
| small_model | `safety_l2_system` | safety_l2 | L2 儿童安全分类器 | - |
| small_model | `intent_classify_system` | intent_classify | 对话意图分类器 | - |
| small_model | `memory_extract_system` | memory_extract | 长期记忆提取器 | - |
| small_model | `sleep_config_extract_system` | sleep_config_extract | 哄睡配置解析器 | - |
| small_model | `filler_system` | filler | 首响承接层（打哈哈） | `contextSection?`, `bannedSection?` |
| small_model | `filler_retry_instruction` | filler | filler 头部违规重试指令 | - |
| small_model | `adventure_interaction_system` | adventure_interaction | 冒险故事接话层 | `characterPersona*`, `segmentText*`, `redirectRule*` |
| main_rules | `main_english_tutor_rules` | chat_main | 英语陪练规则段 | - |
| main_rules | `main_free_chat_rules` | chat_main | 自由对话规则段 | - |
| main_rules | `main_story_mode_rules` | chat_main | 故事模式规则段 | - |
| story | `story_prompt_english` | chat_main | 英语故事话术 | - |
| story | `story_prompt_idiom` | chat_main | 成语故事话术 | - |
| story | `story_prompt_sleep` | chat_main | 哄睡故事话术 | - |
| story | `story_prompt_free` | chat_main | 自由创作故事话术 | - |
| story | `story_favorite_type_suffix` | chat_main | 偏好题材追加段 | `favoriteStoryType*` |
| persona | `persona_elly` | - | 角色人设：小象 Elly | - |
| persona | `persona_polly` | - | 角色人设：小马 Polly | - |

故事意图 → 话术 key 的映射在 `STORY_PROMPT_KEY_BY_INTENT`：
`english_story`/`idiom_story`/`sleep_story` 各对应一个；
`adventure_story` 与 `free_story` **共用** `story_prompt_free`
（走到这里说明冒险未真正开始，统一用「自由创作、不承诺冒险」的降级话术）。
未知意图返回 `undefined`，由调用方走既有 default 分支。

## 变量契约：代码是唯一真相

渲染用自写的 `{{name}}` 替换（`prompt-render.util.ts`，未引入模板引擎），规则：

- 模板里出现**未声明**的占位符 → 抛错。这是防 admin 写入代码不提供的变量；
- 渲染结果里仍残留 `{{` / `}}` → 抛错。这是防「变量值自带占位符」造成二次展开注入；
- 变量值不是字符串（且非 `null`/`undefined`）→ 抛错，不静默 `String()` 转换；
- DB 内容渲染失败 → 记 warn 并**回落代码默认模板重渲染**；
  默认模板本身渲染失败 → 抛 `PromptRenderError`（属代码 bug）。

DB 的 `renderSchema` 列**只供 dashboard 展示**，渲染时一律以
`PROMPT_DEFAULTS[key].variables` 为准。改契约 = 改代码 + 补测试，不能在后台改。

正文上限 `PROMPT_CONTENT_MAX_CHARS = 20000`；变更说明上限 `CHANGE_NOTE_MAX_CHARS = 500`。

## 状态与版本语义

**不存 status 枚举**。草稿 / 已发布完全由 `prompt_templates` 上的两个指针派生：

| draftRevision | publishedRevision | dashboard 显示 |
| --- | --- | --- |
| null | null | 未编辑（生效值 = 代码默认） |
| n | null | 有草稿未发布 |
| null | n | 已发布 r n |
| n | m (n≠m) | 已发布 r m，另有草稿 r n |

三条不可妥协的规则：

1. **版本号单调递增、历史不可变**。`prompt_template_versions` 只增不改（发布时只回填
   `publishedAt` 与 `changeNote`）。
2. **回滚 = 以目标版本正文新建 revision 并发布**（git revert 语义），
   绝不改写或删除既有版本，审计链完整。
3. **禁止删模板行**，也没有 delete 接口。key 被代码引用，删行只会静默回落默认值，
   制造「以为改了其实没改」的错觉。「恢复代码默认值」同样以新版本形式留痕。

保存草稿带 `expectedRevision` **乐观锁**：与服务端当前 `draftRevision` 不一致即 409，
防止两个 admin 互相覆盖。

## 永久硬编码红线（不开放后台编辑）

以下文本刻意**不进注册表**，改动必须走代码 + 评审 + 发版：

- `childSafetyRules`（L3 儿童安全兜底，恒定追加在主模型规则段之后）；
- `personaSection` 身份包装文本（防身份漂移 guardrail，性质同 L3）；
- L1 敏感词表；
- `CANNED_REPLIES`、`EMOTIONAL_HARM_GUIDANCE`；
- filler 静态模板池、`UPSTREAM_FALLBACK_TEXTS`、`buildFillerHandoffMessage`；
- `buildChildProfileSection`、`buildFillerContextSection`（含真实儿童档案拼接逻辑）；
- 冒险链路的本地 `CHARACTER_PERSONAS`（`adventure.service.ts`）。

判据：**这段文本一旦写错会不会直接造成儿童安全风险或身份漂移**。
会 → 硬编码；不会 → 可以进注册表。

## 与已废弃的 `ConversationMode.promptTemplate` 的边界

`conversation_modes` / `conversation_mode_categories` 两张表已随 mode 平级化迁移
`20261113141812_remove_conversation_mode_key` 删除，「自由对话子模式」概念一并废弃：
`messages.conversationModeKey` 与 `device_configs.conversationModeKey` 两列同时删除，
原 3 行子模式 `promptTemplate` **未迁移**（本地库实测均为 NULL；生产/staging 库取值未核验，
删表前建议先 `pg_dump -t conversation_modes` 备份），`free_chat` 回合回归 prompt registry
的默认主链路模板。

下面这条历史边界保留作为记录，右列已不成立：

| | 归属 | 编辑入口 | 语义 |
| --- | --- | --- | --- |
| 系统 prompt / 规则段 / 话术模板 / 人设 | prompt registry | `/analytics/prompts` | 全局生效，改一次影响所有设备 |
| ~~子模式（对话模式）模板~~ | ~~`conversation_modes` 表~~ | 接口与表均已删除 | 概念已废弃 |

结论：可运营编辑的 prompt 文本现在只有 prompt registry 一个入口，不再存在第二个
「按模式生效」的文本来源，也就不需要再划分两者的生命周期与责任人。

## 配置项

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PROMPT_PUBLISH_CONFIRM_CODE` | `DEDA2025` | 发布/回滚/恢复默认的确认码，服务端 `timingSafeEqual` 校验 |
| `PROMPT_WRITE_ENABLED` | 开 | 设为字面 `false`（大小写不敏感）→ 后台只读，所有写操作 403 |

`PROMPT_WRITE_ENABLED` **只认字面 `false`**：写成 `0`、`no`、`ture` 都视为开启，
避免运维打错值静默禁掉编辑能力（也避免打错值静默**开放**写入）。

确认码是防误操作的闸，**不是访问凭据**——访问控制是 `AnalyticsAuthGuard`。
它通过已鉴权的 `GET /analytics/meta` 下发给前端，仅用于让提示文案与 env 保持一致；
前端**禁止把它预填进输入框**，否则「手动输入」这道闸形同虚设。

> ⚠️ 部署注意：`docker/docker-compose.yml` 的 `environment:` 是**白名单**且没有 `env_file`。
> 想在容器内覆盖上面两个变量，必须同时把它们加进那份白名单，否则一律走代码默认值。

## 新增一个可编辑 prompt 的步骤

1. `prompt-keys.ts`：`PROMPT_KEYS` 加 key，必要时 `PROMPT_CATEGORIES` 加分类；
2. `prompt-defaults.ts`：加一条 `{ key, category, scene, name, description, variables, template }`；
   `template` 直接从业务代码里的字面量原样搬过来（**不要顺手改文案**）；
3. 业务 service：把字面量替换为 `promptRegistry.getTemplate(key)` 或 `.render(key, vars)`，
   构造函数注入 `PromptRegistryService`（模块已 `@Global()`，无需改 imports）；
4. 补测试：给对应 `*.spec.ts` 注入 `prompt-registry.testing.ts` 的
   `PROMPT_REGISTRY_PROVIDER`；
5. **重新采集黄金基线**：确认 `prompt-golden.spec.ts` 在改动前后断言不变；
6. `npx tsc --noEmit && npx eslint "src/**/*.ts" && npx jest`。

## 数据表

```
prompt_templates          key(unique) / category / scene / name / description
                          renderSchema(Json, 仅展示) / draftRevision / publishedRevision
                          publishedAt / publishedBy
prompt_template_versions  templateId + revision(unique) / content(Text) / changeNote
                          authorUsername / authorDisplayName / createdAt / publishedAt
                          FK → prompt_templates (onDelete: Cascade)
```

迁移：`src/prisma/migrations/20261113054747_add_prompt_registry/`。
版本表即审计链，**不另建 AdminAuditLog**。

## 已知漂移（本 PR 不修）

- `CHARACTER_PERSONAS` 双份且已漂移：`llm.service.ts` 版含
  「中文自称固定为「小象 Elly」，不要用「艾莉」「小艾」等其他写法。」，
  `adventure.service.ts` 的本地副本缺这后半句。本次刻意不合并（冒险人设不进注册表）。
- `vendor.service.ts` 与 `llm-adapter.service.ts` 仍有 4 个逐字重复的私有方法
  （`resolveActiveConfig`、`getChildProfile`、`applySleepVoiceConfig`、`resolvePromptTemplate`）
  与双份 `BLOCKED_CATEGORIES`。本次只收敛了 `storyPrompt`。
- `parent_reports_generationStatus_nextRetryAt_idx` **schema 漂移**：索引在真实库里存在，
  但 `schema.prisma` 的 `ParentReport` 未声明 `@@index` → `prisma migrate dev`
  会顺手生成 `DROP INDEX`。本 PR 的迁移里已手工剔除该语句，漂移本身需单独修。
