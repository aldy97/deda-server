/**
 * 回填 llm_usage_logs.costMicroCny（历史行没有缓存命中数据，只能按未命中价＝上界）。
 *
 * 用法：
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-llm-cost.ts --dry-run
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-llm-cost.ts --from=2026-10-01 --to=2026-11-11
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-llm-cost.ts --force   # 调价后按新定价重算全部
 *
 * 幂等：默认只处理 costMicroCny IS NULL 的行；--force 才重算已定价行。
 * 只更新 costMicroCny 一列，不删除、不改其他字段；上游 token 缺失的行跳过并计数。
 */
import { PrismaClient } from "@prisma/client";
import {
  DEFAULT_REPORT_TIMEZONE,
  reportDayRange,
} from "../src/modules/learning-stats/parent-report-date.util";
import {
  PRICING_VERSION,
  costMicroCnyOf,
  usageFromLogRow,
} from "../src/modules/llm/llm-cost.util";

const prisma = new PrismaClient();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Args {
  dryRun: boolean;
  force: boolean;
  from?: string;
  to?: string;
  batch: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, force: false, batch: 500 };
  for (const raw of argv) {
    if (raw === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (raw === "--force") {
      args.force = true;
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
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5000) {
        throw new Error(
          `--batch 需为 1..5000 的整数，收到：${value ?? "(空)"}`,
        );
      }
      args.batch = parsed;
      continue;
    }
    throw new Error(`未知参数：${raw}`);
  }
  if (args.from && args.to && args.from > args.to) {
    throw new Error("--from 不能晚于 --to");
  }
  return args;
}

type Row = {
  id: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheHitInputTokens: number | null;
  costMicroCny: number | null;
  createdAt: Date;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // 日期边界与 analytics 同口径（Asia/Shanghai 自然日）
  const gte = args.from
    ? reportDayRange(args.from, DEFAULT_REPORT_TIMEZONE).start
    : undefined;
  const lt = args.to
    ? reportDayRange(args.to, DEFAULT_REPORT_TIMEZONE).end
    : undefined;

  console.log(
    `[backfill-llm-cost] pricingVersion=${PRICING_VERSION} dryRun=${args.dryRun} force=${args.force} ` +
      `range=${args.from ?? "(begin)"}..${args.to ?? "(end)"} batch=${args.batch}`,
  );

  const stats = {
    scanned: 0,
    priced: 0,
    skippedNoTokens: 0,
    unpriced: 0,
    unchanged: 0,
  };
  const unpricedByModel = new Map<string, number>();
  let cursorId: string | undefined;

  for (;;) {
    const rows: Row[] = (await prisma.llmUsageLog.findMany({
      where: {
        ...(gte || lt
          ? { createdAt: { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) } }
          : {}),
        ...(args.force ? {} : { costMicroCny: null }),
      },
      select: {
        id: true,
        model: true,
        promptTokens: true,
        completionTokens: true,
        cacheHitInputTokens: true,
        createdAt: true,
        costMicroCny: true,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: args.batch,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    })) as unknown as Row[];
    if (rows.length === 0) break;
    cursorId = rows[rows.length - 1].id;

    const updates: Array<{ id: string; costMicroCny: number }> = [];
    for (const row of rows) {
      stats.scanned += 1;
      const usage = usageFromLogRow(row);
      if (!usage) {
        stats.skippedNoTokens += 1;
        continue;
      }
      const cost = costMicroCnyOf({
        model: row.model,
        usage,
        at: row.createdAt,
      });
      if (cost === null) {
        stats.unpriced += 1;
        unpricedByModel.set(
          row.model,
          (unpricedByModel.get(row.model) ?? 0) + 1,
        );
        continue;
      }
      if (row.costMicroCny === cost) {
        stats.unchanged += 1;
        continue;
      }
      updates.push({ id: row.id, costMicroCny: cost });
    }

    if (!args.dryRun && updates.length > 0) {
      await prisma.$transaction(
        updates.map((update) =>
          prisma.llmUsageLog.update({
            where: { id: update.id },
            data: { costMicroCny: update.costMicroCny },
          }),
        ),
      );
    }
    stats.priced += updates.length;
    console.log(
      `  ...scanned=${stats.scanned} priced=${stats.priced} ` +
        `skippedNoTokens=${stats.skippedNoTokens} unpriced=${stats.unpriced}`,
    );
    if (rows.length < args.batch) break;
  }

  console.log(`[backfill-llm-cost] done ${JSON.stringify(stats)}`);
  if (unpricedByModel.size > 0) {
    const top = [...unpricedByModel.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([model, count]) => `${model}:${count}`)
      .join(", ");
    console.log(
      `[backfill-llm-cost] 未定价模型（金额留 null，接口计入未计价）：${top}`,
    );
  }
  if (args.dryRun) {
    console.log("[backfill-llm-cost] dry-run：未写入任何数据");
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
