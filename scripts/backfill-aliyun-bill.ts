/**
 * 回填阿里云 BSS 账单到 llm_cost_daily（小模型金额的真值来源）。
 *
 * 凭证从 process.env 读（与 scripts/local-user-journey-db.ts 同约定），不落盘、不打印：
 *   set -a; . ./.env; set +a
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-aliyun-bill.ts --probe
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-aliyun-bill.ts --dry-run
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-aliyun-bill.ts --from=2026-10-01 --to=2026-11-11
 *
 * 默认区间：截至昨日（北京时间）的近 30 天。官方只保留近 18 个月账单，且相对实际消耗延迟 24h
 * （实例信息 48h），因此昨日可能为空——空日记为 empty，不补 0。
 * 幂等：写入走 BillingSyncService.syncDay（dedupeKey upsert），重复回填不追加行、不放大金额。
 * --dry-run 只调只读接口打印汇总，不写库；--probe 只打印当天出现的 ProductCode，用于确认百炼编码。
 */
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  reportDateInTimezone,
  shiftReportDate,
} from "../src/modules/learning-stats/parent-report-date.util";
import { MICRO_PER_CNY } from "../src/modules/llm/llm-cost.util";
import { AliyunBillClient } from "../src/modules/analytics/aliyun-bill.client";
import {
  BillingSyncService,
  recentBillDates,
  tierOfModel,
  type SyncDayResult,
} from "../src/modules/analytics/billing-sync.service";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DAYS = 30;
/** 官方限流 10 笔/秒，逐日之间留间隔，避免回填触发 Throttling.User */
const DEFAULT_DELAY_MS = 300;

interface Args {
  from?: string;
  to?: string;
  dryRun: boolean;
  probe: boolean;
  delayMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, probe: false, delayMs: DEFAULT_DELAY_MS };
  for (const raw of argv) {
    if (raw === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (raw === "--probe") {
      args.probe = true;
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
    if (flag === "--delay-ms") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10000) {
        throw new Error(
          `--delay-ms 需为 0..10000 的整数，收到：${value ?? "(空)"}`,
        );
      }
      args.delayMs = parsed;
      continue;
    }
    throw new Error(`未知参数：${raw}`);
  }
  if (args.from && args.to && args.from > args.to) {
    throw new Error("--from 不能晚于 --to");
  }
  return args;
}

/** 待回填的账单日（升序）：显式区间优先，否则近 DEFAULT_DAYS 天截至昨日 */
function billDates(args: Args, now: Date): string[] {
  if (args.from || args.to) {
    const yesterday = shiftReportDate(
      reportDateInTimezone(now, DEFAULT_REPORT_TIMEZONE),
      -1,
    );
    const end = args.to ?? yesterday;
    if (end > yesterday) {
      throw new Error(`--to 不能晚于昨日（${yesterday}）：当日账单尚未出账`);
    }
    const start = args.from ?? shiftReportDate(end, -(DEFAULT_DAYS - 1));
    const dates: string[] = [];
    for (
      let cursor = start;
      cursor <= end;
      cursor = shiftReportDate(cursor, 1)
    ) {
      dates.push(cursor);
    }
    return dates;
  }
  return recentBillDates(now, DEFAULT_DAYS).reverse();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dryRunDay(
  client: AliyunBillClient,
  billDate: string,
): Promise<void> {
  const rows = await client.fetchBillingItems(billDate);
  const byTier = new Map<string, { rows: number; payableMicroCny: number }>();
  for (const row of rows) {
    const tier = tierOfModel(row.model);
    const bucket = byTier.get(tier) ?? { rows: 0, payableMicroCny: 0 };
    bucket.rows += 1;
    bucket.payableMicroCny += row.payableMicroCny;
    byTier.set(tier, bucket);
  }
  const summary = [...byTier.entries()]
    .map(
      ([tier, bucket]) =>
        `${tier}: rows=${bucket.rows} payable=¥${(bucket.payableMicroCny / MICRO_PER_CNY).toFixed(4)}`,
    )
    .join(" | ");
  const unknownModels = rows.filter((row) => row.model === "unknown").length;
  console.log(
    `[dry-run] ${billDate} rows=${rows.length} ${summary || "(无账单行)"} ` +
      `modelUnknown=${unknownModels}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const config = new ConfigService();
  const client = new AliyunBillClient(config);

  if (!client.isConfigured()) {
    throw new Error(
      "未配置阿里云 BSS 凭证：需导出 ALIYUN_BSS_ACCESS_KEY_ID/SECRET，" +
        "或设 ALIYUN_BSS_USE_RAM_ROLE=true（ECS 实例 RAM 角色）",
    );
  }

  if (args.probe) {
    const probeDate =
      args.to ??
      shiftReportDate(reportDateInTimezone(now, DEFAULT_REPORT_TIMEZONE), -1);
    const configured = config.get<string>("ALIYUN_BSS_PRODUCT_CODE");
    if (configured) {
      console.warn(
        `[backfill-aliyun-bill] ALIYUN_BSS_PRODUCT_CODE=${configured} 已设置，探测结果只含该产品；` +
          `要看全部产品请临时取消该变量`,
      );
    }
    const products = await client.probeProducts(probeDate);
    console.log(
      `[backfill-aliyun-bill] ${probeDate} 出现的产品（用于确认百炼 ProductCode）：`,
    );
    for (const product of products) {
      console.log(
        `  ${product.productCode}\t${product.productName ?? "(无名称)"}`,
      );
    }
    if (products.length === 0) {
      console.log("  (无产品行：当日账单可能尚未出账，换一天再探)");
    }
    return;
  }

  const dates = billDates(args, now);
  console.log(
    `[backfill-aliyun-bill] dryRun=${args.dryRun} range=${dates[0]}..${dates[dates.length - 1]} ` +
      `days=${dates.length} delayMs=${args.delayMs}`,
  );

  const prisma = new PrismaService();
  if (!args.dryRun) await prisma.$connect();
  const sync = new BillingSyncService(prisma, client, config);
  const results: SyncDayResult[] = [];

  try {
    for (const billDate of dates) {
      if (args.dryRun) {
        try {
          await dryRunDay(client, billDate);
        } catch (error) {
          console.error(
            `[dry-run] ${billDate} 失败：${error instanceof Error ? error.message : String(error)}`,
          );
          results.push({ billDate, status: "error", upserted: 0 });
        }
      } else {
        const result = await sync.syncDay(billDate, now);
        results.push(result);
        console.log(
          `[backfill-aliyun-bill] ${billDate} ${result.status} upserted=${result.upserted}` +
            `${result.message ? ` message=${result.message}` : ""}`,
        );
      }
      await sleep(args.delayMs);
    }
  } finally {
    await prisma.$disconnect();
  }

  const counts = results.reduce<Record<string, number>>((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1;
    return acc;
  }, {});
  const upserted = results.reduce((sum, result) => sum + result.upserted, 0);
  console.log(
    `[backfill-aliyun-bill] done days=${results.length} upserted=${upserted} ${JSON.stringify(counts)}`,
  );
  if (args.dryRun) {
    console.log("[backfill-aliyun-bill] dry-run：未写入任何数据");
  }
  if (counts.error) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
