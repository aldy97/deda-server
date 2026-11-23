/**
 * 回补历史消息的本轮安全判定到 messages.rawPayload.safety。
 *
 * 这是「读侧回补」，不修写入链路：只读 turn_decision_logs + messages，
 * 把能确定的判定写进 rawPayload；没有判定行但 AI 回复命中固定安全句时，
 * 标记 inferred=true，前端必须显示「推断回补」。
 *
 * 用法：
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-message-safety.ts \
 *     --id=<messageId|turnId>                 # 默认 dry-run
 *   ... --id=<uuid> --execute                 # 真正写入
 *   ... --from=2026-11-01 --to=2026-11-22 --execute
 *   ... --from=... --to=... --execute --remove
 *
 * 幂等：已有 safety 且内容相同 → 跳过；--force 才覆盖。
 * --remove 只删带 backfilledAt 的回补快照，不碰未来写入链路的真实快照。
 * 日志不输出孩子原文，只输出 turnId 前缀与字段。
 */
import { Prisma, PrismaClient } from "@prisma/client";
import {
  DEFAULT_REPORT_TIMEZONE,
  reportDayRange,
} from "../src/modules/learning-stats/parent-report-date.util";
import {
  buildMessageSafetySnapshot,
  mergeSafetyIntoRawPayload,
  removeBackfilledSafety,
} from "../src/modules/analytics/message-safety-snapshot";

const prisma = new PrismaClient();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECENT_SKIP_MS = 10 * 60 * 1000;

interface Args {
  execute: boolean;
  force: boolean;
  remove: boolean;
  includeRecent: boolean;
  batch: number;
  from?: string;
  to?: string;
  id?: string;
  turnId?: string;
  messageId?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    execute: false,
    force: false,
    remove: false,
    includeRecent: false,
    batch: 200,
  };
  for (const raw of argv) {
    if (raw === "--execute") {
      args.execute = true;
      continue;
    }
    if (raw === "--force") {
      args.force = true;
      continue;
    }
    if (raw === "--remove") {
      args.remove = true;
      continue;
    }
    if (raw === "--include-recent") {
      args.includeRecent = true;
      continue;
    }
    const [flag, value] = raw.split("=");
    if (flag === "--from" || flag === "--to") {
      if (!value || !DATE_RE.test(value)) {
        throw new Error(
          `${flag} 需要 YYYY-MM-DD 格式，收到：${value ?? "(空)"}`,
        );
      }
      if (flag === "--from") args.from = value;
      else args.to = value;
      continue;
    }
    if (flag === "--batch") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2000) {
        throw new Error(
          `--batch 需为 1..2000 的整数，收到：${value ?? "(空)"}`,
        );
      }
      args.batch = parsed;
      continue;
    }
    if (flag === "--id" || flag === "--turn-id" || flag === "--message-id") {
      if (!value || value.trim() === "") {
        throw new Error(`${flag} 需要非空 UUID`);
      }
      if (flag === "--id") args.id = value.trim();
      else if (flag === "--turn-id") args.turnId = value.trim();
      else args.messageId = value.trim();
      continue;
    }
    throw new Error(`未知参数：${raw}`);
  }
  if (args.from && args.to && args.from > args.to) {
    throw new Error("--from 不能晚于 --to");
  }
  const targets = [args.id, args.turnId, args.messageId].filter(Boolean);
  if (targets.length > 1) {
    throw new Error("--id / --turn-id / --message-id 只能传一个");
  }
  if (!targets.length && !args.from && !args.to) {
    throw new Error(
      "必须指定 --id / --turn-id / --message-id，或 --from/--to 时间范围",
    );
  }
  if (args.remove && !args.execute) {
    throw new Error("--remove 必须与 --execute 一起使用");
  }
  return args;
}

interface MessageRow {
  id: string;
  turnId: string;
  role: string;
  mode: string | null;
  content: string;
  rawPayload: Prisma.JsonValue | null;
  spokeAt: Date;
}

interface Stats {
  turnsScanned: number;
  turnsWithDecision: number;
  turnsInferred: number;
  turnsSkippedNoSignal: number;
  messagesUpdated: number;
  messagesUnchanged: number;
  messagesRemoveCandidates: number;
  replacedNonObject: number;
}

function emptyStats(): Stats {
  return {
    turnsScanned: 0,
    turnsWithDecision: 0,
    turnsInferred: 0,
    turnsSkippedNoSignal: 0,
    messagesUpdated: 0,
    messagesUnchanged: 0,
    messagesRemoveCandidates: 0,
    replacedNonObject: 0,
  };
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

async function resolveTarget(args: Args): Promise<{
  turnId: string;
  resolvedAs: "message" | "turn";
  messageId?: string;
} | null> {
  const explicit = args.turnId ?? args.id;
  if (args.messageId) {
    const message = await prisma.message.findUnique({
      where: { id: args.messageId },
      select: { id: true, turnId: true },
    });
    if (!message) throw new Error(`message not found: ${args.messageId}`);
    return {
      turnId: message.turnId,
      resolvedAs: "message",
      messageId: message.id,
    };
  }
  if (!explicit) return null;

  const byMessage = await prisma.message.findUnique({
    where: { id: explicit },
    select: { id: true, turnId: true },
  });
  if (byMessage) {
    return {
      turnId: byMessage.turnId,
      resolvedAs: "message",
      messageId: byMessage.id,
    };
  }
  const byTurn = await prisma.message.findFirst({
    where: { turnId: explicit },
    select: { turnId: true },
  });
  if (byTurn) return { turnId: byTurn.turnId, resolvedAs: "turn" };
  throw new Error(
    `UUID ${explicit} 既不是 Message.id 也不是 turnId（没有对应消息）`,
  );
}

async function processTurn(
  turnId: string,
  args: Args,
  stats: Stats,
  cutoff: Date,
): Promise<void> {
  const messages: MessageRow[] = await prisma.message.findMany({
    where: { turnId },
    orderBy: { spokeAt: "asc" },
    select: {
      id: true,
      turnId: true,
      role: true,
      mode: true,
      content: true,
      rawPayload: true,
      spokeAt: true,
    },
  });
  if (messages.length === 0) return;

  if (!args.includeRecent && messages.some((m) => m.spokeAt > cutoff)) {
    return;
  }

  stats.turnsScanned += 1;

  const decision = await prisma.turnDecisionLog.findUnique({
    where: { turnId },
    select: {
      safetyLayer: true,
      safetyCategory: true,
      safetyBlocked: true,
      safetySource: true,
      safetyMatched: true,
    },
  });

  if (args.remove) {
    const updates: Prisma.PrismaPromise<unknown>[] = [];
    for (const message of messages) {
      const removed = removeBackfilledSafety(message.rawPayload);
      if (!removed.changed) {
        stats.messagesUnchanged += 1;
        continue;
      }
      stats.messagesRemoveCandidates += 1;
      if (args.execute) {
        updates.push(
          prisma.message.update({
            where: { id: message.id },
            data: {
              rawPayload: removed.payload as Prisma.InputJsonValue,
            },
          }),
        );
      }
    }
    if (updates.length > 0) await prisma.$transaction(updates);
    return;
  }

  if (decision) stats.turnsWithDecision += 1;

  const mode = messages.find((m) => m.mode)?.mode ?? null;
  const assistantTexts = messages
    .filter((m) => m.role === "assistant")
    .map((m) => m.content);
  const snapshot = buildMessageSafetySnapshot({
    decision,
    mode,
    assistantTexts,
  });
  if (!snapshot) {
    stats.turnsSkippedNoSignal += 1;
    return;
  }
  if (snapshot.inferred) stats.turnsInferred += 1;

  const updates: Prisma.PrismaPromise<unknown>[] = [];
  for (const message of messages) {
    const merged = mergeSafetyIntoRawPayload(message.rawPayload, snapshot, {
      force: args.force,
    });
    if (!merged.changed) {
      stats.messagesUnchanged += 1;
      continue;
    }
    stats.messagesUpdated += 1;
    if (merged.replacedNonObject) stats.replacedNonObject += 1;
    if (args.execute) {
      updates.push(
        prisma.message.update({
          where: { id: message.id },
          data: {
            rawPayload: merged.payload as Prisma.InputJsonValue,
          },
        }),
      );
    }
  }
  if (updates.length > 0) await prisma.$transaction(updates);
}

async function processRange(
  args: Args,
  stats: Stats,
  cutoff: Date,
): Promise<void> {
  const gte = args.from
    ? reportDayRange(args.from, DEFAULT_REPORT_TIMEZONE).start
    : undefined;
  const lt = args.to
    ? reportDayRange(args.to, DEFAULT_REPORT_TIMEZONE).end
    : undefined;

  let cursorId: string | undefined;
  const processed = new Set<string>();

  for (;;) {
    const rows = await prisma.message.findMany({
      where: {
        ...(gte || lt
          ? { spokeAt: { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) } }
          : {}),
        ...(cursorId ? { id: { gt: cursorId } } : {}),
      },
      orderBy: { id: "asc" },
      take: args.batch,
      select: { id: true, turnId: true },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      if (processed.has(row.turnId)) continue;
      processed.add(row.turnId);
      await processTurn(row.turnId, args, stats, cutoff);
    }
    cursorId = rows[rows.length - 1]?.id;
    if (rows.length < args.batch) break;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.execute ? (args.remove ? "remove" : "execute") : "dry-run";
  const cutoff = new Date(Date.now() - RECENT_SKIP_MS);

  console.log(
    `[backfill-message-safety] mode=${mode} force=${args.force} ` +
      `includeRecent=${args.includeRecent} ` +
      `range=${args.from ?? "(begin)"}..${args.to ?? "(end)"}`,
  );

  const stats = emptyStats();
  const target = await resolveTarget(args);
  if (target) {
    console.log(
      `[backfill-message-safety] target resolvedAs=${target.resolvedAs} ` +
        `turnId=${shortId(target.turnId)}…`,
    );
    await processTurn(target.turnId, args, stats, cutoff);
  } else {
    await processRange(args, stats, cutoff);
  }

  console.log(`[backfill-message-safety] done ${JSON.stringify(stats)}`);
  if (!args.execute) {
    console.log("[backfill-message-safety] dry-run：未写入任何数据");
  }
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[backfill-message-safety] failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
