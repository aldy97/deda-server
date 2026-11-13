import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  isValidReportDate,
  reportDateInTimezone,
  reportDayRange,
  shiftReportDate,
} from "../learning-stats/parent-report-date.util";

type Granularity = "day" | "week" | "month";

export interface DecisionRangeQuery {
  startDate: string;
  endDate: string;
}

export interface DecisionTrendQuery extends DecisionRangeQuery {
  granularity?: Granularity;
}

export interface ReviewQueueQuery extends DecisionRangeQuery {
  category?: string;
  deviceId?: string;
  page?: number;
  pageSize?: number;
  sort?: "createdAt_desc" | "createdAt_asc";
}

/**
 * 安全类别的展示顺序：按严重度而非计数排。
 * 看板要的是「最该先看的在最上面」，按计数排会让量大的 safe 永远压住
 * 少量但严重的 self_harm。null（未能判定）排最后，与 safe 严格分开。
 */
const CATEGORY_SEVERITY_ORDER: (string | null)[] = [
  "sexual",
  "self_harm",
  "violence",
  "emotional_harm",
  "safe",
  null,
];

const LAYER_ORDER: (string | null)[] = ["L1", "L2", null];

/**
 * 会走关键词兜底的意图来源。这两类都意味着「小模型没给出可用结论」，
 * 是 prompt 退化 / 模型漂移的信号，必须合并成一个可告警的比率。
 */
const FALLBACK_INTENT_SOURCES = ["fallback_invalid_label", "fallback_error"];

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** 分母为 0 返回 null：「没数据」和「比率为 0」在看板上必须是两件事 */
function rateOrNull(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round4(numerator / denominator) : null;
}

/** 与 llm-analytics.service / quality.service 同一口径：week=周一起始，month=YYYY-MM */
function bucketKeyOf(dateKey: string, granularity: Granularity): string {
  if (granularity === "day") return dateKey;
  if (granularity === "month") return dateKey.slice(0, 7);
  const date = new Date(`${dateKey}T00:00:00Z`);
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum);
  return date.toISOString().slice(0, 10);
}

/** 区间内全部桶（逐日枚举后按粒度归并去重，保证无数据桶补零） */
function enumerateBuckets(
  startDate: string,
  endDate: string,
  granularity: Granularity,
): string[] {
  const keys: string[] = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const key = bucketKeyOf(cursor, granularity);
    if (keys[keys.length - 1] !== key) keys.push(key);
    cursor = shiftReportDate(cursor, 1);
  }
  return keys;
}

function rankBy<T>(order: T[], value: T): number {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

/**
 * 判定质量看板读侧（安全拦截 + 意图路由）。
 *
 * 与 LlmAnalyticsService 的分工：那边回答「模型调用健康吗」（成功率、延迟、token），
 * 这边回答「模型的判定可信吗」（拦了多少、放行的里面有多少其实没审、意图有多少是兜底兜出来的）。
 *
 * 实现口径：
 * - summary 走 Prisma groupBy（DB 侧聚合，明细永久保留也不会把行拉进内存）；
 * - trend 走 findMany + 内存分桶，但 select 只取聚合必需的四列。
 *   不用 $queryRaw 做 DB 侧日期分桶：时区截断的正确性只有 e2e 能验证，
 *   而本期不为 analytics 增加 e2e，内存分桶可以纯单测覆盖。
 *   代价：明细永久保留 × 超大区间（如 90 天）会有内存压力，
 *   本期靠窄 select 压低单行体积，并由看板 range picker 限制可选区间；
 *   若将来要放开长区间，应改为 DB 侧日期分桶并补 e2e 验证时区截断。
 */
@Injectable()
export class TurnDecisionAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 判定概览：拦截率 + 类别/层级/来源三种分桶 + 静默降级计数 */
  async getSafetySummary(query: DecisionRangeQuery) {
    const where = this.buildWhere(query);

    // 类别 × 是否拦截一次拿到，避免为 blockedCount 再扫一遍
    const [categoryGroups, layerGroups, sourceGroups, reviewableCount] =
      await Promise.all([
        this.prisma.turnDecisionLog.groupBy({
          by: ["safetyCategory", "safetyBlocked"],
          where,
          _count: { _all: true },
        }),
        this.prisma.turnDecisionLog.groupBy({
          by: ["safetyLayer"],
          where,
          _count: { _all: true },
        }),
        this.prisma.turnDecisionLog.groupBy({
          by: ["safetySource"],
          where,
          _count: { _all: true },
        }),
        // 复核队列的可选范围：只有留了原文的轮次才可人工复核
        this.prisma.turnDecisionLog.count({
          where: { ...where, asrText: { not: null } },
        }),
      ]);

    const byCategoryMap = new Map<
      string | null,
      { count: number; blocked: number }
    >();
    let total = 0;
    let blockedCount = 0;
    for (const group of categoryGroups) {
      const count = group._count._all;
      total += count;
      if (group.safetyBlocked) blockedCount += count;
      const bucket = byCategoryMap.get(group.safetyCategory) ?? {
        count: 0,
        blocked: 0,
      };
      bucket.count += count;
      if (group.safetyBlocked) bucket.blocked += count;
      byCategoryMap.set(group.safetyCategory, bucket);
    }

    const sourceCounts = new Map<string, number>();
    for (const group of sourceGroups) {
      sourceCounts.set(group.safetySource, group._count._all);
    }

    const layerCounts = new Map<string | null, number>();
    for (const group of layerGroups) {
      layerCounts.set(group.safetyLayer, group._count._all);
    }

    return {
      total,
      blockedCount,
      blockRate: rateOrNull(blockedCount, total),
      byCategory: Array.from(byCategoryMap.entries())
        .map(([category, bucket]) => ({
          category,
          count: bucket.count,
          blockedCount: bucket.blocked,
        }))
        .sort(
          (a, b) =>
            rankBy(CATEGORY_SEVERITY_ORDER, a.category) -
              rankBy(CATEGORY_SEVERITY_ORDER, b.category) || b.count - a.count,
        ),
      byLayer: Array.from(layerCounts.entries())
        .map(([layer, count]) => ({ layer, count }))
        .sort(
          (a, b) =>
            rankBy(LAYER_ORDER, a.layer) - rankBy(LAYER_ORDER, b.layer) ||
            b.count - a.count,
        ),
      bySource: Array.from(sourceCounts.entries())
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count),
      // 三类静默降级单独计数：它们都表现为「放行」，但成因和处置完全不同
      failOpenCount: sourceCounts.get("l2_fail_open") ?? 0,
      invalidLabelCount: sourceCounts.get("l2_invalid_label") ?? 0,
      notEvaluatedCount: sourceCounts.get("not_evaluated") ?? 0,
      // emotional_harm 不拦截，但会注入共情引导 system 消息（行为改变点），
      // 判得准不准只能靠人工复核，所以必须单独可见
      emotionalHarmCount: byCategoryMap.get("emotional_harm")?.count ?? 0,
      reviewableCount,
    };
  }

  /** 拦截趋势：无数据桶补零，比率为 null */
  async getSafetyTrend(query: DecisionTrendQuery) {
    const granularity = query.granularity ?? "day";
    const where = this.buildWhere(query);
    const rows = await this.prisma.turnDecisionLog.findMany({
      where,
      // 只取聚合必需列：明细永久保留，宽行全捞会在大区间打爆内存
      select: {
        createdAt: true,
        safetyBlocked: true,
        safetyCategory: true,
        safetySource: true,
      },
    });

    interface Bucket {
      total: number;
      blocked: number;
      failOpen: number;
      invalidLabel: number;
      notEvaluated: number;
      emotionalHarm: number;
    }
    const byBucket = new Map<string, Bucket>();
    for (const row of rows) {
      const key = bucketKeyOf(
        reportDateInTimezone(row.createdAt, DEFAULT_REPORT_TIMEZONE),
        granularity,
      );
      const bucket = byBucket.get(key) ?? {
        total: 0,
        blocked: 0,
        failOpen: 0,
        invalidLabel: 0,
        notEvaluated: 0,
        emotionalHarm: 0,
      };
      bucket.total += 1;
      if (row.safetyBlocked) bucket.blocked += 1;
      if (row.safetySource === "l2_fail_open") bucket.failOpen += 1;
      if (row.safetySource === "l2_invalid_label") bucket.invalidLabel += 1;
      if (row.safetySource === "not_evaluated") bucket.notEvaluated += 1;
      if (row.safetyCategory === "emotional_harm") bucket.emotionalHarm += 1;
      byBucket.set(key, bucket);
    }

    const series = enumerateBuckets(
      query.startDate,
      query.endDate,
      granularity,
    ).map((date) => {
      const bucket = byBucket.get(date);
      if (!bucket) {
        return {
          date,
          total: 0,
          blockedCount: 0,
          blockRate: null,
          failOpenCount: 0,
          invalidLabelCount: 0,
          notEvaluatedCount: 0,
          emotionalHarmCount: 0,
        };
      }
      return {
        date,
        total: bucket.total,
        blockedCount: bucket.blocked,
        blockRate: rateOrNull(bucket.blocked, bucket.total),
        failOpenCount: bucket.failOpen,
        invalidLabelCount: bucket.invalidLabel,
        notEvaluatedCount: bucket.notEvaluated,
        emotionalHarmCount: bucket.emotionalHarm,
      };
    });

    return { granularity, series };
  }

  /** 意图概览：分布 + 决策路径来源 + intent × source 交叉矩阵 */
  async getIntentSummary(query: DecisionRangeQuery) {
    const where = this.buildWhere(query);
    const groups = await this.prisma.turnDecisionLog.groupBy({
      by: ["intent", "intentSource"],
      where,
      _count: { _all: true },
    });

    let total = 0;
    let modelInvokedCount = 0;
    let fallbackCount = 0;
    let notRoutedCount = 0;
    let adventureTakeoverCount = 0;
    const intentCounts = new Map<string | null, number>();
    const sourceCounts = new Map<string | null, number>();
    const matrix: Array<{
      intent: string | null;
      source: string | null;
      count: number;
    }> = [];

    for (const group of groups) {
      const count = group._count._all;
      total += count;
      const source = group.intentSource;
      if (source === "model") modelInvokedCount += count;
      if (source && FALLBACK_INTENT_SOURCES.includes(source)) {
        fallbackCount += count;
      }
      if (source === "not_routed") notRoutedCount += count;
      if (source === "adventure_takeover") adventureTakeoverCount += count;
      intentCounts.set(
        group.intent,
        (intentCounts.get(group.intent) ?? 0) + count,
      );
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + count);
      matrix.push({ intent: group.intent, source, count });
    }

    return {
      total,
      byIntent: Array.from(intentCounts.entries())
        .map(([intent, count]) => ({ intent, count }))
        .sort(
          (a, b) =>
            b.count - a.count ||
            String(a.intent ?? "").localeCompare(String(b.intent ?? "")),
        ),
      bySource: Array.from(sourceCounts.entries())
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count),
      modelInvokedCount,
      modelInvokedRate: rateOrNull(modelInvokedCount, total),
      fallbackCount,
      fallbackRate: rateOrNull(fallbackCount, total),
      // 这两类根本没走到意图路由，单列出来，避免被误读成「模型判成了 free_chat」
      notRoutedCount,
      adventureTakeoverCount,
      matrix: matrix.sort(
        (a, b) =>
          b.count - a.count ||
          String(a.intent ?? "").localeCompare(String(b.intent ?? "")),
      ),
    };
  }

  /** 意图趋势：逐桶给出模型调用数、兜底数与意图分布 */
  async getIntentTrend(query: DecisionTrendQuery) {
    const granularity = query.granularity ?? "day";
    const where = this.buildWhere(query);
    const rows = await this.prisma.turnDecisionLog.findMany({
      where,
      select: { createdAt: true, intent: true, intentSource: true },
    });

    interface Bucket {
      total: number;
      modelInvoked: number;
      fallback: number;
      intents: Map<string | null, number>;
    }
    const byBucket = new Map<string, Bucket>();
    for (const row of rows) {
      const key = bucketKeyOf(
        reportDateInTimezone(row.createdAt, DEFAULT_REPORT_TIMEZONE),
        granularity,
      );
      const bucket = byBucket.get(key) ?? {
        total: 0,
        modelInvoked: 0,
        fallback: 0,
        intents: new Map<string | null, number>(),
      };
      bucket.total += 1;
      if (row.intentSource === "model") bucket.modelInvoked += 1;
      if (
        row.intentSource &&
        FALLBACK_INTENT_SOURCES.includes(row.intentSource)
      ) {
        bucket.fallback += 1;
      }
      bucket.intents.set(row.intent, (bucket.intents.get(row.intent) ?? 0) + 1);
      byBucket.set(key, bucket);
    }

    const series = enumerateBuckets(
      query.startDate,
      query.endDate,
      granularity,
    ).map((date) => {
      const bucket = byBucket.get(date);
      const intents = Array.from(bucket?.intents.entries() ?? [])
        .map(([intent, count]) => ({ intent, count }))
        .sort(
          (a, b) =>
            b.count - a.count ||
            String(a.intent ?? "").localeCompare(String(b.intent ?? "")),
        );
      return {
        date,
        total: bucket?.total ?? 0,
        modelInvoked: bucket?.modelInvoked ?? 0,
        fallbackCount: bucket?.fallback ?? 0,
        byIntent: intents,
      };
    });

    return { granularity, series };
  }

  /**
   * 人工复核队列：只返回留了原文的轮次（拦截 + 非 safe 类别）。
   * asrText IS NOT NULL 恒定附加，不接受调用方绕过——这是儿童语料的最小暴露面。
   * 本期只读；reviewLabel / reviewedAt 两列已建，写接口留待二期。
   */
  async getReviewQueue(query: ReviewQueueQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = {
      ...this.buildWhere(query),
      asrText: { not: null },
      ...(query.category ? { safetyCategory: query.category } : {}),
      ...(query.deviceId ? { deviceId: query.deviceId } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.turnDecisionLog.count({ where }),
      this.prisma.turnDecisionLog.findMany({
        where,
        orderBy: {
          createdAt: query.sort === "createdAt_asc" ? "asc" : "desc",
        },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      items: rows.map((row) => ({
        turnId: row.turnId,
        deviceId: row.deviceId,
        channel: row.channel,
        createdAt: row.createdAt,
        safetyLayer: row.safetyLayer,
        safetyCategory: row.safetyCategory,
        safetySource: row.safetySource,
        safetyMatched: row.safetyMatched,
        asrText: row.asrText,
        intent: row.intent,
        intentSource: row.intentSource,
      })),
    };
  }

  /** 日期区间 → createdAt 边界（北京时区），口径与其余 analytics 接口一致 */
  private buildWhere(query: DecisionRangeQuery) {
    if (
      !isValidReportDate(query.startDate) ||
      !isValidReportDate(query.endDate)
    ) {
      throw new BadRequestException("Invalid date");
    }
    if (query.startDate > query.endDate) {
      throw new BadRequestException("startDate must be <= endDate");
    }
    const { start } = reportDayRange(query.startDate, DEFAULT_REPORT_TIMEZONE);
    const { end } = reportDayRange(query.endDate, DEFAULT_REPORT_TIMEZONE);
    return { createdAt: { gte: start, lt: end } };
  }
}
