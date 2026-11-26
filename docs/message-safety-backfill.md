# 历史消息安全判定回补（messages.rawPayload.safety）

本 runbook 只解决**历史消息展示**：把 `turn_decision_logs` 已存在的本轮安全判定，
或从 AI 回复内容能确定的固定安全话术，回补进 `messages.rawPayload.safety`。
不修改写入链路、不新增数据库列、不碰 `turn_decision_logs`。

## 快照形状

```json
{
  "safety": {
    "layer": "L2",
    "category": "violence",
    "blocked": true,
    "source": "l2_model",
    "matched": null,
    "reply": "canned_block",
    "inferred": false,
    "backfilledAt": "2026-11-23T10:00:00.000Z"
  }
}
```

- `reply`：`canned_block` / `unsafe_line_echo` / `caution_injected` / `none` / `unknown`。
- `inferred=true`：没有判定行，只从 assistant 内容命中 `ADVENTURE_UNSAFE_LINE` 推断；
  前端必须显示「推断回补」，不能伪装成模型原始判定。
- `backfilledAt`：回补脚本写入的标记；`--remove` 只删带此字段的快照。

## 回补规则

| 输入 | 写出 |
|---|---|
| `turn_decision_logs.blocked=true` | 保留 layer/category/source/matched，`reply=canned_block` |
| fail-open / 非法标签，assistant 含固定安全句 | `reply=unsafe_line_echo` |
| fail-open / 非法标签，`mode=adventure_story` 且无安全句 | `reply=caution_injected` |
| `category=emotional_harm` | 写出判定，`reply=none` |
| `safe` / `not_evaluated` 且无安全句 | 不回补 |
| 无判定行，assistant 含固定安全句 | `source=inferred_from_reply`，`inferred=true` |
| 无判定行且无安全句 | 跳过 |

## 使用

```bash
# 默认 dry-run；先确认目标
npx ts-node -r tsconfig-paths/register scripts/backfill-message-safety.ts \
  --id=<messageId|turnId>

# 执行
npx ts-node -r tsconfig-paths/register scripts/backfill-message-safety.ts \
  --id=<messageId|turnId> --execute

# 批量按 spokeAt 范围
npx ts-node -r tsconfig-paths/register scripts/backfill-message-safety.ts \
  --from=2026-11-01 --to=2026-11-22 --execute

# 回滚（只删带 backfilledAt 的快照）
npx ts-node -r tsconfig-paths/register scripts/backfill-message-safety.ts \
  --from=2026-11-01 --to=2026-11-22 --execute --remove
```

- 默认跳过最近 10 分钟的消息，避免与在线写入竞争；`--include-recent` 可覆盖。
- 已有 `safety` 默认不覆盖；`--force` 才覆盖。
- 脚本日志只输出 turnId 前缀与字段，不输出孩子原文。
- 一个 turn 的 user/assistant 两条消息写同一个快照，保证从孩子那条打开也能看到。

## 验证

```sql
SELECT "turnId", role, mode, "rawPayload"->'safety' AS safety
FROM messages
WHERE "turnId" = '<真实 turnId>';
```

看板：`/messages?turnId=<真实 turnId>` → 消息详情 → 「本轮安全判定」。
`inferred=true` 时必须出现「推断回补」标记。

## 明确不在本 runbook 范围

- 不修未来写入链路（`safetyReply` 列、recorder、llm-adapter 出口）。
- 不修改 `turn_decision_logs`。
- 不处理 vendor 老 WS 链路（无真实流量）。
- 不回填 `asrText`；复核队列的原文留存规则不变。
