import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  isValidReportDate,
  reportDateInTimezone,
  reportDayRange,
  shiftReportDate,
} from "../learning-stats/parent-report-date.util";
import {
  PRICING_VERSION,
  officialPriceLines,
  toCny,
  vendorOfModel,
  type LlmVendor,
  type OfficialPriceLine,
} from "../llm/llm-cost.util";
import { AliyunBillClient } from "./aliyun-bill.client";

/**
 * LLM 费用看板查询服务。
 *
 * 两条数据源，语义不同，绝不混为一谈：
 * - 小模型（百炼 qwen-flash）＝阿里云 BSS 账单真值，读 llm_cost_daily（由 BillingSyncService 落库）；
 * - 主模型（deepseek-flash）＝按 llm_usage_logs.costMicroCny 快照估算，缓存命中数缺失时是上界。
 *
 * 硬约束：
 * 1) endDate 一律钳到「昨日」（北京时间）——账单延迟 24h 出账，今日数字必然偏低，上页面会误导决策；
 * 2) 拿不到数据 ≠ ¥0：账单未接入/未出账一律 null，并由 sources.*.status 说明原因；
 * 3) 金额在库内是 micro-CNY 整数，聚合用 SUM(Int)，只在出参时换算成元（6 位小数）。
 *
 * 埋点日聚合走 $queryRaw：Prisma groupBy 无法按 Asia/Shanghai 自然日分桶（createdAt 是 UTC 的
 * timestamp(3)），而逐日 aggregate 要发 N 次查询。SQL 已对拍验证与 reportDateInTimezone 的 JS
 * 分桶逐格一致（scripts 之外的口径由 e2e 用真实库守住）。
 */

/** 区间上限：逐日枚举 + series 出参都随天数线性增长，366 天足够看板使用 */
const MAX_RANGE_DAYS = 366;

const UNCONFIGURED_MESSAGE =
  "未配置阿里云 BSS 凭证（ALIYUN_BSS_ACCESS_KEY_ID/SECRET 或 ALIYUN_BSS_USE_RAM_ROLE），小模型金额不可用";
const NO_DATA_MESSAGE =
  "区间内没有账单行：账单可能尚未同步或当日账单未出（官方延迟 24h）";
const MODEL_SPLIT_MESSAGE =
  "账单无法按模型拆分（解析不出模型名），小模型口径降级为「百炼账号合计」，可能混入同账号其他消费";
const PEAK_NOTE =
  "高峰＝北京时间周一至周五 9:00-12:00、14:00-18:00；法定节假日未维护，节假日按高峰计（略微高估）";

export interface LlmCostQuery {
  startDate: string;
  endDate: string;
}

export type AliyunSourceStatus = "ok" | "no_data" | "unconfigured";
/** exact＝全部行有缓存命中数；upper_bound＝全部没有；mixed＝部分有部分没有 */
export type MainAccuracy = "exact" | "upper_bound" | "mixed";

export interface LlmCostSeriesItem {
  date: string;
  smallCny: number | null;
  mainCny: number | null;
  /** 账单里既不是小模型也不是主模型的行（如其他百炼产品）；拆不出模型时为 0 */
  otherCny: number | null;
  totalCny: number | null;
  smallTokens: number;
  mainTokens: number;
  smallCnyPerMillionTokens: number | null;
  mainCnyPerMillionTokens: number | null;
  smallSource: "bill" | "none";
  mainSource: "estimated" | "none";
  mainAccuracy: MainAccuracy | null;
  /** 该日账单是否已终账；无账单行为 null */
  settled: boolean | null;
}

export interface LlmUnitEconomicsRow {
  model: string;
  tier: "small" | "main" | "unknown";
  source: "bill" | "estimated";
  cny: number;
  tokens: number;
  pricedTokens: number;
  cnyPerMillionTokens: number | null;
  /** 有 token 埋点的去重设备数（口径：llm_usage_logs.deviceId，非「活跃设备」） */
  tokenActiveDevices: number;
  daysWithData: number;
  cnyPerDevicePerDay: number | null;
  unpricedRows: number;
  noTokenRows: number;
}

export interface LlmCostResponse {
  currency: "CNY";
  pricing: {
    version: string;
    peakNote: string;
    lines: OfficialPriceLine[];
  };
  range: {
    startDate: string;
    endDate: string;
    requestedStartDate: string;
    requestedEndDate: string;
    clamped: boolean;
    days: number;
  };
  sources: {
    aliyun: {
      status: AliyunSourceStatus;
      kind: "bill";
      latestBillDate: string | null;
      latestFetchedAt: string | null;
      modelSplit: boolean;
      daysWithData: number;
      message: string | null;
    };
    deepseek: {
      status: "ok";
      kind: "estimated";
      pricingVersion: string;
      rows: number;
      pricedRows: number;
      cacheHitRows: number;
      upperBoundRows: number;
      cacheTokenAvailable: boolean;
    };
  };
  series: LlmCostSeriesItem[];
  totals: {
    smallCny: number | null;
    mainCny: number | null;
    otherCny: number | null;
    totalCny: number | null;
    /** 合计是否不完整（缺账单或缺埋点时为 true，前端必须标注，不能当成真实总额） */
    partial: boolean;
    days: number;
    unpricedRows: number;
    noTokenRows: number;
    unpricedTokens: number;
  };
  month: {
    cycle: string;
    daysInCycle: number;
    daysWithData: number;
    /** 账期内无任何数据源 → null（拿不到数据 ≠ ¥0）；有数据但金额为 0 → 仍是 0 */
    toDateCny: number | null;
    /** 账期内无账单行 → null（未知，不是 0） */
    toDateSmallCny: number | null;
    /** 账期内无已计价主模型行 → null（未知，不是 0） */
    toDateMainCny: number | null;
    projectedEndCny: number | null;
    /** 上月同期无任何数据源 → null */
    prevSamePeriodCny: number | null;
    deltaPct: number | null;
    /** 账期内缺账单或缺主模型埋点 → true；此时 toDateCny 只含已有源，不是真实总额 */
    partial: boolean;
  };
  unitEconomics: LlmUnitEconomicsRow[];
  reconciliation: {
    status: "ok" | "insufficient";
    days: number;
    smallEstimatedCny: number;
    smallBilledCny: number;
    deltaPct: number | null;
  };
}

/** PG 的 bigint 经 Prisma 可能回 string/bigint，一律过 num() 归一 */
type Numeric = number | string | bigint | null;

interface UsageDayRow {
  day: string;
  model: string;
  rows: Numeric;
  priced_rows: Numeric;
  upper_bound_rows: Numeric;
  cache_hit_rows: Numeric;
  cost_micro: Numeric;
  tokens: Numeric;
  priced_tokens: Numeric;
}

interface UsageModelRow {
  model: string;
  rows: Numeric;
  priced_rows: Numeric;
  unpriced_rows: Numeric;
  no_token_rows: Numeric;
  cache_hit_rows: Numeric;
  upper_bound_rows: Numeric;
  tokens: Numeric;
  priced_tokens: Numeric;
  unpriced_tokens: Numeric;
  cost_micro: Numeric;
  devices: Numeric;
}

interface UsageBucket {
  rows: number;
  pricedRows: number;
  upperBoundRows: number;
  cacheHitRows: number;
  costMicro: number;
  tokens: number;
  pricedTokens: number;
}

interface BillDay {
  hasRows: boolean;
  settled: boolean;
  smallMicro: number;
  otherMicro: number;
  /** 仅 modelSplit 时按模型累计（tier=small 的行） */
  byModel: Map<string, number>;
}

function num(value: Numeric): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function emptyBucket(): UsageBucket {
  return {
    rows: 0,
    pricedRows: 0,
    upperBoundRows: 0,
    cacheHitRows: 0,
    costMicro: 0,
    tokens: 0,
    pricedTokens: 0,
  };
}

function enumerateDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (
    let cursor = startDate;
    cursor <= endDate;
    cursor = shiftReportDate(cursor, 1)
  ) {
    dates.push(cursor);
  }
  return dates;
}

/** 闭区间天数（YYYY-MM-DD 字符串可直接比较） */
function daysInclusive(startDate: string, endDate: string): number {
  const ms =
    Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

function daysInCycle(cycle: string): number {
  const year = Number(cycle.slice(0, 4));
  const month = Number(cycle.slice(5, 7));
  // Date.UTC 月份 0 基：传 1 基月份即「次月第 0 天」＝本月最后一天
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function cycleStartBefore(cycleStart: string): string {
  return `${shiftReportDate(cycleStart, -1).slice(0, 7)}-01`;
}

/** 按 vendor 归并某一天的模型桶；vendor=unknown 归入 other（未定价，金额为 0） */
function foldVendor(
  day: Map<string, UsageBucket> | undefined,
  vendor: LlmVendor,
): UsageBucket {
  const total = emptyBucket();
  if (!day) return total;
  for (const [model, bucket] of day) {
    if (vendorOfModel(model) !== vendor) continue;
    total.rows += bucket.rows;
    total.pricedRows += bucket.pricedRows;
    total.upperBoundRows += bucket.upperBoundRows;
    total.cacheHitRows += bucket.cacheHitRows;
    total.costMicro += bucket.costMicro;
    total.tokens += bucket.tokens;
    total.pricedTokens += bucket.pricedTokens;
  }
  return total;
}

function accuracyOf(bucket: UsageBucket): MainAccuracy | null {
  if (bucket.pricedRows === 0) return null;
  if (bucket.upperBoundRows === 0) return "exact";
  if (bucket.cacheHitRows === 0) return "upper_bound";
  return "mixed";
}

@Injectable()
export class LlmCostService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billClient: AliyunBillClient,
  ) {}

  async getCostDaily(
    query: LlmCostQuery,
    now: Date = new Date(),
  ): Promise<LlmCostResponse> {
    const { startDate, endDate } = query;
    if (!isValidReportDate(startDate) || !isValidReportDate(endDate)) {
      throw new BadRequestException("Invalid date");
    }
    if (startDate > endDate) {
      throw new BadRequestException("startDate must be <= endDate");
    }
    if (daysInclusive(startDate, endDate) > MAX_RANGE_DAYS) {
      throw new BadRequestException(`区间最长 ${MAX_RANGE_DAYS} 天`);
    }

    // 今日账单必然不完整（官方延迟 24h），一律钳到昨日；startDate 也随之不超过 endDate
    const yesterday = shiftReportDate(
      reportDateInTimezone(now, DEFAULT_REPORT_TIMEZONE),
      -1,
    );
    const end = endDate < yesterday ? endDate : yesterday;
    const start = startDate < end ? startDate : end;
    const dates = enumerateDates(start, end);

    // 本月＝昨日所在账期（与请求区间解耦）；环比窗口＝上月 1 日至同一日
    const cycle = yesterday.slice(0, 7);
    const cycleStart = `${cycle}-01`;
    const prevCycleStart = cycleStartBefore(cycleStart);
    const prevDayOfMonth = Math.min(
      Number(yesterday.slice(8, 10)),
      daysInCycle(prevCycleStart.slice(0, 7)),
    );
    const prevCycleEnd = `${prevCycleStart.slice(0, 7)}-${String(prevDayOfMonth).padStart(2, "0")}`;
    const windowLo = start < prevCycleStart ? start : prevCycleStart;

    // 查询只读库、不调 BSS：凭证是否在册不影响出数（历史账单可能已由之前的同步或回填脚本落库）。
    // 凭证状态只用来解释「为什么没有账单数据」，见 buildAliyunSource。
    const configured = this.billClient.isConfigured();
    const [usageByDay, modelRows, bill, billMax] = await Promise.all([
      this.fetchUsageDays(
        reportDayRange(windowLo, DEFAULT_REPORT_TIMEZONE).start,
        reportDayRange(yesterday, DEFAULT_REPORT_TIMEZONE).end,
      ),
      this.fetchUsageModels(
        reportDayRange(start, DEFAULT_REPORT_TIMEZONE).start,
        reportDayRange(end, DEFAULT_REPORT_TIMEZONE).end,
      ),
      this.fetchBillDays(windowLo, yesterday),
      this.fetchBillWatermark(),
    ]);
    const { byDay: billByDay, modelSplit } = bill;
    const billSmallByModel = this.sumBillByModel(billByDay, dates);

    const series = dates.map((date) =>
      this.buildSeriesItem(date, usageByDay.get(date), billByDay.get(date)),
    );

    const totals = this.buildTotals(dates, usageByDay, billByDay, modelRows);
    const month = this.buildMonth({
      cycle,
      cycleStart,
      yesterday,
      prevCycleStart,
      prevCycleEnd,
      usageByDay,
      billByDay,
    });
    const unitEconomics = this.buildUnitEconomics(
      modelRows,
      usageByDay,
      billSmallByModel,
      dates,
      modelSplit,
    );
    const reconciliation = this.buildReconciliation(
      dates,
      usageByDay,
      billByDay,
    );

    return {
      currency: "CNY",
      pricing: {
        version: PRICING_VERSION,
        peakNote: PEAK_NOTE,
        lines: officialPriceLines(),
      },
      range: {
        startDate: start,
        endDate: end,
        requestedStartDate: startDate,
        requestedEndDate: endDate,
        clamped: start !== startDate || end !== endDate,
        days: dates.length,
      },
      sources: {
        aliyun: this.buildAliyunSource({
          configured,
          modelSplit,
          billByDay,
          dates,
          billMax,
        }),
        deepseek: this.buildDeepseekSource(modelRows),
      },
      series,
      totals,
      month,
      unitEconomics,
      reconciliation,
    };
  }

  /** 埋点日分组：一次查询覆盖请求区间 + 本月至今 + 上月同期 */
  private async fetchUsageDays(
    start: Date,
    end: Date,
  ): Promise<Map<string, Map<string, UsageBucket>>> {
    // 时区字面量与 DEFAULT_REPORT_TIMEZONE 一致；createdAt 是存 UTC 的 timestamp(3)，
    // 先 AT TIME ZONE 'UTC' 还原成 timestamptz，再转到北京时间取自然日。
    const rows = await this.prisma.$queryRaw<UsageDayRow[]>`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS day,
             lower("model") AS model,
             COUNT(*)::int AS rows,
             COUNT(*) FILTER (WHERE "costMicroCny" IS NOT NULL)::int AS priced_rows,
             COUNT(*) FILTER (WHERE "costMicroCny" IS NOT NULL AND "cacheHitInputTokens" IS NULL)::int AS upper_bound_rows,
             COUNT(*) FILTER (WHERE "cacheHitInputTokens" IS NOT NULL)::int AS cache_hit_rows,
             SUM(COALESCE("costMicroCny", 0))::bigint AS cost_micro,
             SUM(COALESCE("totalTokens", 0))::bigint AS tokens,
             SUM(COALESCE("totalTokens", 0)) FILTER (WHERE "costMicroCny" IS NOT NULL)::bigint AS priced_tokens
      FROM llm_usage_logs
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;
    const byDay = new Map<string, Map<string, UsageBucket>>();
    for (const row of rows) {
      let day = byDay.get(row.day);
      if (!day) {
        day = new Map<string, UsageBucket>();
        byDay.set(row.day, day);
      }
      day.set(row.model, {
        rows: num(row.rows),
        pricedRows: num(row.priced_rows),
        upperBoundRows: num(row.upper_bound_rows),
        cacheHitRows: num(row.cache_hit_rows),
        costMicro: num(row.cost_micro),
        tokens: num(row.tokens),
        pricedTokens: num(row.priced_tokens),
      });
    }
    return byDay;
  }

  /** 按模型汇总（仅请求区间）：单位经济性、未计价计数、主模型缓存覆盖度都从这里来 */
  private fetchUsageModels(start: Date, end: Date): Promise<UsageModelRow[]> {
    return this.prisma.$queryRaw<UsageModelRow[]>`
      SELECT lower("model") AS model,
             COUNT(*)::int AS rows,
             COUNT(*) FILTER (WHERE "costMicroCny" IS NOT NULL)::int AS priced_rows,
             COUNT(*) FILTER (WHERE "costMicroCny" IS NULL AND "promptTokens" IS NOT NULL AND "completionTokens" IS NOT NULL)::int AS unpriced_rows,
             COUNT(*) FILTER (WHERE "promptTokens" IS NULL OR "completionTokens" IS NULL)::int AS no_token_rows,
             COUNT(*) FILTER (WHERE "cacheHitInputTokens" IS NOT NULL)::int AS cache_hit_rows,
             COUNT(*) FILTER (WHERE "costMicroCny" IS NOT NULL AND "cacheHitInputTokens" IS NULL)::int AS upper_bound_rows,
             SUM(COALESCE("totalTokens", 0))::bigint AS tokens,
             SUM(COALESCE("totalTokens", 0)) FILTER (WHERE "costMicroCny" IS NOT NULL)::bigint AS priced_tokens,
             SUM(COALESCE("totalTokens", 0)) FILTER (WHERE "costMicroCny" IS NULL)::bigint AS unpriced_tokens,
             SUM(COALESCE("costMicroCny", 0))::bigint AS cost_micro,
             COUNT(DISTINCT "deviceId")::int AS devices
      FROM llm_usage_logs
      WHERE "createdAt" >= ${start} AND "createdAt" < ${end}
      GROUP BY 1
      ORDER BY 1
    `;
  }

  /**
   * 账单按日 × tier × 模型 × 是否终账聚合（billDate 是字符串列，走 @@index([billDate])）。
   * settled 也进 group key：同一天被不同批次同步过时取「已终账」为准。
   */
  private async fetchBillDays(
    billDateGte: string,
    billDateLte: string,
  ): Promise<{ byDay: Map<string, BillDay>; modelSplit: boolean }> {
    // by 必须 as const：多字段数组否则被推成联合类型数组，Prisma 的 groupBy 重载解析失败
    const groups = await this.prisma.llmCostDaily.groupBy({
      by: ["billDate", "tier", "model", "settled"] as const,
      _sum: { payableMicroCny: true },
      where: { billDate: { gte: billDateGte, lte: billDateLte } },
    });
    const modelSplit = groups.some(
      (group) => group.tier !== "unknown" && group.model !== "unknown",
    );
    const byDay = new Map<string, BillDay>();
    for (const group of groups) {
      let day = byDay.get(group.billDate);
      if (!day) {
        day = {
          hasRows: false,
          settled: false,
          smallMicro: 0,
          otherMicro: 0,
          byModel: new Map(),
        };
        byDay.set(group.billDate, day);
      }
      day.hasRows = true;
      day.settled = day.settled || group.settled;
      const micro = num(group._sum.payableMicroCny);
      if (!modelSplit) {
        // 拆不出模型：整账号合计都算小模型口径（页面据 modelSplit=false 如实标注）
        day.smallMicro += micro;
        continue;
      }
      if (group.tier === "small") {
        day.smallMicro += micro;
        day.byModel.set(
          group.model,
          (day.byModel.get(group.model) ?? 0) + micro,
        );
      } else {
        day.otherMicro += micro;
      }
    }
    return { byDay, modelSplit };
  }

  /** 账单水位：最新账单日与最近抓取时间（全局，便于区分「没同步」与「同步了但本区间没有」） */
  private async fetchBillWatermark(): Promise<{
    billDate: string | null;
    fetchedAt: Date | null;
  }> {
    const result = await this.prisma.llmCostDaily.aggregate({
      _max: { billDate: true, fetchedAt: true },
    });
    return {
      billDate: result._max.billDate ?? null,
      fetchedAt: result._max.fetchedAt ?? null,
    };
  }

  private sumBillByModel(
    billByDay: Map<string, BillDay>,
    dates: string[],
  ): Map<string, number> {
    const totals = new Map<string, number>();
    for (const date of dates) {
      const day = billByDay.get(date);
      if (!day?.hasRows) continue;
      for (const [model, micro] of day.byModel) {
        totals.set(model, (totals.get(model) ?? 0) + micro);
      }
    }
    return totals;
  }

  private buildSeriesItem(
    date: string,
    usage: Map<string, UsageBucket> | undefined,
    bill: BillDay | undefined,
  ): LlmCostSeriesItem {
    const main = foldVendor(usage, "deepseek");
    const small = foldVendor(usage, "dashscope");
    const hasBill = bill?.hasRows ?? false;
    const hasMainCost = main.pricedRows > 0;
    const smallMicro = hasBill ? bill!.smallMicro : 0;
    const otherMicro = hasBill ? bill!.otherMicro : 0;
    const mainMicro = hasMainCost ? main.costMicro : 0;
    return {
      date,
      smallCny: hasBill ? toCny(smallMicro) : null,
      mainCny: hasMainCost ? toCny(mainMicro) : null,
      otherCny: hasBill ? toCny(otherMicro) : null,
      totalCny:
        hasBill || hasMainCost
          ? toCny(smallMicro + otherMicro + mainMicro)
          : null,
      smallTokens: small.tokens,
      mainTokens: main.tokens,
      // 账单是全部小模型流量的真值 → 分母用全部 token；估算只覆盖已计价行 → 分母用已计价 token
      smallCnyPerMillionTokens:
        hasBill && small.tokens > 0 ? round4(smallMicro / small.tokens) : null,
      mainCnyPerMillionTokens:
        hasMainCost && main.pricedTokens > 0
          ? round4(mainMicro / main.pricedTokens)
          : null,
      smallSource: hasBill ? "bill" : "none",
      mainSource: main.rows > 0 ? "estimated" : "none",
      mainAccuracy: accuracyOf(main),
      settled: hasBill ? bill!.settled : null,
    };
  }

  private buildTotals(
    dates: string[],
    usageByDay: Map<string, Map<string, UsageBucket>>,
    billByDay: Map<string, BillDay>,
    modelRows: UsageModelRow[],
  ): LlmCostResponse["totals"] {
    let billSmallMicro = 0;
    let billOtherMicro = 0;
    let mainMicro = 0;
    let hasBill = false;
    let hasMainRows = false;
    let hasMainCost = false;
    for (const date of dates) {
      const bill = billByDay.get(date);
      if (bill?.hasRows) {
        hasBill = true;
        billSmallMicro += bill.smallMicro;
        billOtherMicro += bill.otherMicro;
      }
      const usage = usageByDay.get(date);
      const main = foldVendor(usage, "deepseek");
      if (main.rows > 0) hasMainRows = true;
      if (main.pricedRows > 0) {
        hasMainCost = true;
        mainMicro += main.costMicro;
      }
    }
    const unpriced = modelRows.reduce(
      (acc, row) => ({
        rows: acc.rows + num(row.unpriced_rows),
        noToken: acc.noToken + num(row.no_token_rows),
        tokens: acc.tokens + num(row.unpriced_tokens),
      }),
      { rows: 0, noToken: 0, tokens: 0 },
    );
    return {
      smallCny: hasBill ? toCny(billSmallMicro) : null,
      mainCny: hasMainCost ? toCny(mainMicro) : null,
      otherCny: hasBill ? toCny(billOtherMicro) : null,
      totalCny:
        hasBill || hasMainCost
          ? toCny(billSmallMicro + billOtherMicro + mainMicro)
          : null,
      partial: !hasBill || !hasMainRows,
      days: dates.length,
      unpricedRows: unpriced.rows,
      noTokenRows: unpriced.noToken,
      unpricedTokens: unpriced.tokens,
    };
  }

  private buildMonth(input: {
    cycle: string;
    cycleStart: string;
    yesterday: string;
    prevCycleStart: string;
    prevCycleEnd: string;
    usageByDay: Map<string, Map<string, UsageBucket>>;
    billByDay: Map<string, BillDay>;
  }): LlmCostResponse["month"] {
    const sumWindow = (from: string, to: string) => {
      let smallMicro = 0;
      let mainMicro = 0;
      let otherMicro = 0;
      let daysWithData = 0;
      let hasBill = false;
      let hasMainRows = false;
      let hasMainCost = false;
      for (const date of enumerateDates(from, to)) {
        const bill = input.billByDay.get(date);
        const usage = input.usageByDay.get(date);
        const main = foldVendor(usage, "deepseek");
        if (bill?.hasRows) hasBill = true;
        if (main.rows > 0) hasMainRows = true;
        if (main.pricedRows > 0) hasMainCost = true;
        const daySmall = bill?.hasRows ? bill.smallMicro : 0;
        const dayOther = bill?.hasRows ? bill.otherMicro : 0;
        const dayMain = main.pricedRows > 0 ? main.costMicro : 0;
        smallMicro += daySmall;
        otherMicro += dayOther;
        mainMicro += dayMain;
        if (bill?.hasRows || main.pricedRows > 0) daysWithData += 1;
      }
      return {
        smallMicro,
        mainMicro,
        otherMicro,
        daysWithData,
        hasBill,
        hasMainRows,
        hasMainCost,
      };
    };

    const current = sumWindow(input.cycleStart, input.yesterday);
    const previous = sumWindow(input.prevCycleStart, input.prevCycleEnd);
    const daysInCurrentCycle = daysInCycle(input.cycle);
    const toDateMicro =
      current.smallMicro + current.mainMicro + current.otherMicro;
    const prevMicro =
      previous.smallMicro + previous.mainMicro + previous.otherMicro;
    // 拿不到数据 ≠ ¥0：只有「窗口内确实有该数据源」才给数，否则一律 null。
    // 反之，有数据源但金额为 0（如全额被代金券抵扣）必须仍是 0，不能退化成 null。
    const hasCurrent = current.hasBill || current.hasMainCost;
    const hasPrev = previous.hasBill || previous.hasMainCost;
    return {
      cycle: input.cycle,
      daysInCycle: daysInCurrentCycle,
      daysWithData: current.daysWithData,
      toDateCny: hasCurrent ? toCny(toDateMicro) : null,
      toDateSmallCny: current.hasBill ? toCny(current.smallMicro) : null,
      toDateMainCny: current.hasMainCost ? toCny(current.mainMicro) : null,
      projectedEndCny:
        current.daysWithData > 0
          ? toCny(
              Math.round(
                (toDateMicro / current.daysWithData) * daysInCurrentCycle,
              ),
            )
          : null,
      prevSamePeriodCny: hasPrev ? toCny(prevMicro) : null,
      deltaPct:
        hasCurrent && prevMicro !== 0
          ? round4(((toDateMicro - prevMicro) / prevMicro) * 100)
          : null,
      // 与 totals.partial 同一套口径，但窗口是「昨日所在账期」而非请求区间，
      // 两者可能不一致（各自描述自己的窗口），前端分别标注。
      partial: !current.hasBill || !current.hasMainRows,
    };
  }

  private buildUnitEconomics(
    modelRows: UsageModelRow[],
    usageByDay: Map<string, Map<string, UsageBucket>>,
    billSmallByModel: Map<string, number>,
    dates: string[],
    modelSplit: boolean,
  ): LlmUnitEconomicsRow[] {
    const daysWithRows = new Map<string, number>();
    for (const date of dates) {
      const usage = usageByDay.get(date);
      if (!usage) continue;
      for (const [model, bucket] of usage) {
        if (bucket.rows > 0)
          daysWithRows.set(model, (daysWithRows.get(model) ?? 0) + 1);
      }
    }
    const rows = modelRows.map((row) => {
      const vendor = vendorOfModel(row.model);
      const tier: LlmUnitEconomicsRow["tier"] =
        vendor === "dashscope"
          ? "small"
          : vendor === "deepseek"
            ? "main"
            : "unknown";
      const tokens = num(row.tokens);
      const pricedTokens = num(row.priced_tokens);
      const devices = num(row.devices);
      const daysWithData = daysWithRows.get(row.model) ?? 0;
      const billMicro = billSmallByModel.get(row.model);
      const fromBill =
        tier === "small" && modelSplit && billMicro !== undefined;
      const costMicro = fromBill ? billMicro! : num(row.cost_micro);
      const denominator = fromBill ? tokens : pricedTokens;
      return {
        model: row.model,
        tier,
        source: (fromBill
          ? "bill"
          : "estimated") as LlmUnitEconomicsRow["source"],
        cny: toCny(costMicro),
        tokens,
        pricedTokens,
        cnyPerMillionTokens:
          denominator > 0 ? round4(costMicro / denominator) : null,
        tokenActiveDevices: devices,
        daysWithData,
        cnyPerDevicePerDay:
          devices > 0 && daysWithData > 0
            ? toCny(Math.round(costMicro / devices / daysWithData))
            : null,
        unpricedRows: num(row.unpriced_rows),
        noTokenRows: num(row.no_token_rows),
      };
    });
    return rows.sort((a, b) => b.cny - a.cny);
  }

  private buildReconciliation(
    dates: string[],
    usageByDay: Map<string, Map<string, UsageBucket>>,
    billByDay: Map<string, BillDay>,
  ): LlmCostResponse["reconciliation"] {
    let days = 0;
    let estimatedMicro = 0;
    let billedMicro = 0;
    for (const date of dates) {
      const bill = billByDay.get(date);
      // 只比已终账的账单日：未终账会随退款/调账/延迟出账变动，比出来的偏差没有意义
      if (!bill?.hasRows || !bill.settled) continue;
      days += 1;
      billedMicro += bill.smallMicro;
      estimatedMicro += foldVendor(usageByDay.get(date), "dashscope").costMicro;
    }
    return {
      status: days > 0 ? "ok" : "insufficient",
      days,
      smallEstimatedCny: toCny(estimatedMicro),
      smallBilledCny: toCny(billedMicro),
      deltaPct:
        billedMicro !== 0
          ? round4(((estimatedMicro - billedMicro) / billedMicro) * 100)
          : null,
    };
  }

  private buildAliyunSource(input: {
    configured: boolean;
    modelSplit: boolean;
    billByDay: Map<string, BillDay>;
    dates: string[];
    billMax: { billDate: string | null; fetchedAt: Date | null };
  }): LlmCostResponse["sources"]["aliyun"] {
    const daysWithData = input.dates.filter(
      (date) => input.billByDay.get(date)?.hasRows,
    ).length;
    const latestBillDate = input.billMax.billDate;
    const latestFetchedAt = input.billMax.fetchedAt?.toISOString() ?? null;
    if (daysWithData > 0) {
      return {
        status: "ok",
        kind: "bill",
        latestBillDate,
        latestFetchedAt,
        modelSplit: input.modelSplit,
        daysWithData,
        message: input.modelSplit ? null : MODEL_SPLIT_MESSAGE,
      };
    }
    // 没有账单数据时用凭证状态区分「没接入」与「接入了但还没同步到」——两者都不是 ¥0
    return {
      status: input.configured ? "no_data" : "unconfigured",
      kind: "bill",
      latestBillDate,
      latestFetchedAt,
      modelSplit: false,
      daysWithData: 0,
      message: input.configured ? NO_DATA_MESSAGE : UNCONFIGURED_MESSAGE,
    };
  }

  private buildDeepseekSource(
    modelRows: UsageModelRow[],
  ): LlmCostResponse["sources"]["deepseek"] {
    const main = modelRows.filter(
      (row) => vendorOfModel(row.model) === "deepseek",
    );
    const sum = (pick: (row: UsageModelRow) => Numeric) =>
      main.reduce((acc, row) => acc + num(pick(row)), 0);
    const cacheHitRows = sum((row) => row.cache_hit_rows);
    return {
      status: "ok",
      kind: "estimated",
      pricingVersion: PRICING_VERSION,
      rows: sum((row) => row.rows),
      pricedRows: sum((row) => row.priced_rows),
      cacheHitRows,
      upperBoundRows: sum((row) => row.upper_bound_rows),
      cacheTokenAvailable: cacheHitRows > 0,
    };
  }
}
