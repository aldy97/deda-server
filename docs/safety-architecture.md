# 安全中心化架构（Phase 0 契约）

目标：所有对话模块共用同一套 L1/L2/L3 安全机制，由 `src/modules/safety/` 统一提供入口与纯策略；冒险、哄睡只保留各自业务行为。

## 分层与职责

| 层 | 位置 | 职责 |
|---|---|---|
| L1 | `safety/child-safety.service`（Phase 6 前暂在 vendor） | 正则闸，零延迟 |
| L2 | 同上 | 小模型语义分类 |
| L3 | `LlmService.buildEnglishTutorPrompt` 的 `childSafetyRules` | 主模型 system prompt 约束，不是确定性闸口 |
| 策略 | `safety/safety-policy` | 什么算安全事件、是否留原文、消息快照 |
| 入口 | `safety/safety-gate.service`（Phase 2 起） | 唯一 public API，编排 L1/L2、返回 decision |
| 审计 | `TurnDecisionRecorder` + `message.rawPayload.safety` | 只存，不解释策略 |

## mode / intent → profile

真实 message mode：`free_chat / english_chat / english_story / idiom_story / free_story / sleep_story / adventure_story`。
真实 intent：`free_chat / adventure_story / english_story / idiom_story / sleep_story / free_story / sleep_config`。

| 输入 | profile |
|---|---|
| `mode=adventure_story` | `adventure` |
| `mode=sleep_story` | `sleep` |
| `intent=sleep_config`（即使落库 mode=free_chat） | `sleep` |
| 其他真实 mode | `default` |
| `mode=free_story` + `intent=adventure_story`（冒险未真正开始） | `default` |

映射在 `safety-profile.ts` 显式穷举；新增 mode 时 TS 编译失败。

## 不变量

- L1 先于冒险状态机与 L2。
- 冒险确定性分支不调 L2；使用 lazy handle。
- `blocked` 轮次不推进冒险进度。
- `emotional_harm` 不拦截，但注入共情指令并写快照。
- 无 verdict 但实际播出安全话术 → 退化快照 `inferred=true`。
- safe / 未评估且无安全话术 → 不写快照。
- 留原文唯一 owner：`shouldPersistAsrText`。
- 消息 JSON key 固定 `rawPayload.safety.reply`；内部字段名 `safetyReply`。

## 非破坏性阶段

1. **Phase 1a（当前）**：提取类型/纯策略/profile，接线 recorder 与 llm-adapter；行为不变，无 API/schema 变化。
2. **Phase 1b**：删除 `AdventureSafetySignal`，统一 `SafetyVerdict`。
3. **Phase 2**：`SafetyGateService` + 普通聊天 shadow（一次 L2 + 双解释器 diff）。
4. **Phase 3**：哄睡接 gate。
5. **Phase 4**：冒险 lazy handle。
6. **Phase 5**：审计/消息写入收口，回补模块类型复用。
7. **Phase 6**：L3 文本迁入 safety；`ChildSafetyService` 迁入 `safety/`（决定：迁）。

每阶段 flag 默认 `off`/`shadow`，旧路径保留一个发布周期。

## import 守卫

方向一：`src/modules/safety/**` 不得 import `adventure`、`sleep-configs`、`llm-adapter`、`vendor/vendor.service`。
方向二：除 `safety/` 与 `child-safety.service` 自身外，业务模块不得 import `ChildSafetyService` 或冒险安全常量。
允许临时例外：`vendor.service.ts`（无流量，Phase 6 删除）。
