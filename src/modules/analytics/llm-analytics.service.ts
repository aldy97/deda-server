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

export interface LlmSummaryQuery {
  startDate: string;
  endDate: string;
}

export interface LlmTrendQuery extends LlmSummaryQuery {
  granularity?: Granularity;
  scene?: string;
}

export interface LlmRecentFailuresQuery {
  page?: number;
  pageSize?: number;
  scene?: string;
}

export interface LlmTurnHandoffQuery {
  startDate: string;
  endDate: string;
  /** 空窗判定阈值（ms）：chat_main 首包晚于 filler 完成超过该值记空窗；缺省 0 */
  gapThresholdMs?: number;
}

export interface LlmSlowCallsQuery {
  startDate: string;
  endDate: string;
  scene?: string;
  /** 缺省 20，上限 50 */
  limit?: number;
}

interface LlmLogRow {
  scene: string;
  tier: string;
  success: boolean;
  failureReason: string | null;
  latencyMs: number | null;
  firstTokenMs: number | null;
  totalTokens: number | null;
  createdAt: Date;
}

/** percentile_cont 等价：线性插值；空数组返回 null */
function percentileCont(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** 与 quality.service 同一口径：day=当天；week=周一起始；month=YYYY-MM */
function bucketKeyOf(dateKey: string, granularity: Granularity): string {
  if (granularity === "day") return dateKey;
  if (granularity === "month") return dateKey.slice(0, 7);
  const date = new Date(`${dateKey}T00:00:00Z`);
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum);
  return date.toISOString().slice(0, 10);
}

/** 区间内全部桶（day 逐日枚举后按粒度归并去重，保证无数据桶补零） */
function enumerateBuckets(
  startDate: string,
  endDate: string,
  granularity: Granularity,
): string[] {
  const keys: string[] = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const key = bucketKeyOf(cursor, granularity);
    if (keys[keys.length - 1] !== key) {
      keys.push(key);
    }
    cursor = shiftReportDate(cursor, 1);
  }
  return keys;
}

@Injectable()
export class LlmAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  private validateRange(startDate: string, endDate: string) {
    if (!isValidReportDate(startDate) || !isValidReportDate(endDate)) {
      throw new BadRequestException("Invalid date");
    }
    if (startDate > endDate) {
      throw new BadRequestException("startDate must be <= endDate");
    }
  }

  private async fetchRows(
    startDate: string,
    endDate: string,
    scene?: string,
  ): Promise<LlmLogRow[]> {
    const { start } = reportDayRange(startDate, DEFAULT_REPORT_TIMEZONE);
    const { end } = reportDayRange(endDate, DEFAULT_REPORT_TIMEZONE);
    return this.prisma.llmUsageLog.findMany({
      where: {
        createdAt: { gte: start, lt: end },
        ...(scene ? { scene } : {}),
      },
      select: {
        scene: true,
        tier: true,
        success: true,
        failureReason: true,
        latencyMs: true,
        firstTokenMs: true,
        totalTokens: true,
        createdAt: true,
      },
    });
  }

  /** 分场景汇总：成功率 / 延迟与首包分位数 / token / 失败原因分布 */
  async getSummary(query: LlmSummaryQuery) {
    this.validateRange(query.startDate, query.endDate);
    const rows = await this.fetchRows(query.startDate, query.endDate);

    const byScene = new Map<string, LlmLogRow[]>();
    for (const row of rows) {
      const list = byScene.get(row.scene) ?? [];
      list.push(row);
      byScene.set(row.scene, list);
    }

    const scenes = Array.from(byScene.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([scene, list]) => {
        const calls = list.length;
        const successes = list.filter((row) => row.success).length;
        const latencies = list
          .map((row) => row.latencyMs)
          .filter((value): value is number => value !== null);
        const firstTokens = list
          .map((row) => row.firstTokenMs)
          .filter((value): value is number => value !== null);
        const totalTokens = list.reduce(
          (sum, row) => sum + (row.totalTokens ?? 0),
          0,
        );

        const breakdown = new Map<string, number>();
        for (const row of list) {
          if (!row.success && row.failureReason) {
            breakdown.set(
              row.failureReason,
              (breakdown.get(row.failureReason) ?? 0) + 1,
            );
          }
        }

        return {
          scene,
          tier: list[0].tier,
          calls,
          successRate: calls > 0 ? round4(successes / calls) : null,
          p50LatencyMs: percentileCont(latencies, 0.5),
          p90LatencyMs: percentileCont(latencies, 0.9),
          p50FirstTokenMs: percentileCont(firstTokens, 0.5),
          p90FirstTokenMs: percentileCont(firstTokens, 0.9),
          totalTokens,
          failureBreakdown: Array.from(breakdown.entries())
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count),
        };
      });

    return { scenes };
  }

  /** 趋势：按日/周/月聚合，无数据桶补零（successRate/分位数为 null） */
  async getTrend(query: LlmTrendQuery) {
    this.validateRange(query.startDate, query.endDate);
    const granularity = query.granularity ?? "day";
    const rows = await this.fetchRows(
      query.startDate,
      query.endDate,
      query.scene,
    );

    interface Bucket {
      calls: number;
      successes: number;
      latencies: number[];
      firstTokens: number[];
      totalTokens: number;
    }
    const byBucket = new Map<string, Bucket>();
    for (const row of rows) {
      const dateKey = reportDateInTimezone(
        row.createdAt,
        DEFAULT_REPORT_TIMEZONE,
      );
      const key = bucketKeyOf(dateKey, granularity);
      let bucket = byBucket.get(key);
      if (!bucket) {
        bucket = {
          calls: 0,
          successes: 0,
          latencies: [],
          firstTokens: [],
          totalTokens: 0,
        };
        byBucket.set(key, bucket);
      }
      bucket.calls += 1;
      if (row.success) bucket.successes += 1;
      if (row.latencyMs !== null) bucket.latencies.push(row.latencyMs);
      if (row.firstTokenMs !== null) bucket.firstTokens.push(row.firstTokenMs);
      bucket.totalTokens += row.totalTokens ?? 0;
    }

    const series = enumerateBuckets(
      query.startDate,
      query.endDate,
      granularity,
    ).map((key) => {
      const bucket = byBucket.get(key);
      if (!bucket) {
        return {
          date: key,
          calls: 0,
          successRate: null,
          p50LatencyMs: null,
          avgFirstTokenMs: null,
          p50FirstTokenMs: null,
          p90FirstTokenMs: null,
          totalTokens: 0,
        };
      }
      return {
        date: key,
        calls: bucket.calls,
        successRate:
          bucket.calls > 0 ? round4(bucket.successes / bucket.calls) : null,
        p50LatencyMs: percentileCont(bucket.latencies, 0.5),
        avgFirstTokenMs:
          bucket.firstTokens.length > 0
            ? Math.round(
                bucket.firstTokens.reduce((sum, v) => sum + v, 0) /
                  bucket.firstTokens.length,
              )
            : null,
        p50FirstTokenMs: percentileCont(bucket.firstTokens, 0.5),
        p90FirstTokenMs: percentileCont(bucket.firstTokens, 0.9),
        totalTokens: bucket.totalTokens,
      };
    });

    return { granularity, series };
  }

  /**
   * 轮次衔接健康度（防死空气，生成侧口径）：按 turnId join 同轮的
   * filler 与 chat_main，逐轮计算
   *   gapMs = chat_main 首包时刻 − filler 生成完成时刻
   * 注意口径：这是「生成侧」时刻，不等于设备播放侧的真实死空气
   * （filler 音频播放时长不在本表）；gap ≤ 0 视为覆盖良好。
   */
  async getTurnHandoff(query: LlmTurnHandoffQuery) {
    this.validateRange(query.startDate, query.endDate);
    const threshold = query.gapThresholdMs ?? 0;
    const { start } = reportDayRange(query.startDate, DEFAULT_REPORT_TIMEZONE);
    const { end } = reportDayRange(query.endDate, DEFAULT_REPORT_TIMEZONE);

    const rows = await this.prisma.llmUsageLog.findMany({
      where: {
        createdAt: { gte: start, lt: end },
        turnId: { not: null },
        scene: { in: ["filler", "chat_main"] },
      },
      select: {
        turnId: true,
        scene: true,
        latencyMs: true,
        firstTokenMs: true,
        createdAt: true,
      },
    });

    interface TurnPair {
      filler?: { endAt: number };
      chat?: { firstTokenAt: number | null; createdAt: Date };
    }
    const byTurn = new Map<string, TurnPair>();
    for (const row of rows) {
      if (!row.turnId) continue;
      const pair = byTurn.get(row.turnId) ?? {};
      if (row.scene === "filler" && row.latencyMs !== null) {
        // 同轮多次 filler（重试）取最后一次完成的，它是实际播报的那次
        const endAt = row.createdAt.getTime() + row.latencyMs;
        if (!pair.filler || endAt > pair.filler.endAt) {
          pair.filler = { endAt };
        }
      }
      if (row.scene === "chat_main" && !pair.chat) {
        pair.chat = {
          firstTokenAt:
            row.firstTokenMs !== null
              ? row.createdAt.getTime() + row.firstTokenMs
              : null,
          createdAt: row.createdAt,
        };
      }
      byTurn.set(row.turnId, pair);
    }

    let turnsWithChat = 0;
    let turnsMissingFiller = 0;
    let turnsUnknown = 0;
    const gaps: number[] = [];
    const topGaps: Array<{ turnId: string; gapMs: number; createdAt: Date }> =
      [];

    for (const [turnId, pair] of byTurn) {
      if (!pair.chat) continue;
      turnsWithChat += 1;
      if (!pair.filler) {
        turnsMissingFiller += 1;
        continue;
      }
      if (pair.chat.firstTokenAt === null) {
        turnsUnknown += 1;
        continue;
      }
      const gapMs = pair.chat.firstTokenAt - pair.filler.endAt;
      gaps.push(gapMs);
      topGaps.push({ turnId, gapMs, createdAt: pair.chat.createdAt });
    }

    const turnsWithBoth = gaps.length;
    const overThreshold = gaps.filter((gap) => gap > threshold).length;
    topGaps.sort((a, b) => b.gapMs - a.gapMs);

    return {
      turnsWithChat,
      turnsWithBoth,
      turnsMissingFiller,
      turnsUnknown,
      gapThresholdMs: threshold,
      gapP50Ms: percentileCont(gaps, 0.5),
      gapP90Ms: percentileCont(gaps, 0.9),
      gapRate: turnsWithBoth > 0 ? round4(overThreshold / turnsWithBoth) : null,
      topGaps: topGaps.slice(0, 10),
    };
  }

  /**
   * 慢调用明细（成功但耗时长的长尾）：latencyMs 倒序。
   * 失败调用由 recent-failures 覆盖，这里只看成功样本。
   */
  async getSlowCalls(query: LlmSlowCallsQuery) {
    this.validateRange(query.startDate, query.endDate);
    const { start } = reportDayRange(query.startDate, DEFAULT_REPORT_TIMEZONE);
    const { end } = reportDayRange(query.endDate, DEFAULT_REPORT_TIMEZONE);

    const rows = await this.prisma.llmUsageLog.findMany({
      where: {
        createdAt: { gte: start, lt: end },
        success: true,
        latencyMs: { not: null },
        ...(query.scene ? { scene: query.scene } : {}),
      },
      orderBy: { latencyMs: "desc" },
      take: query.limit ?? 20,
      include: { device: { select: { deviceId: true } } },
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        scene: row.scene,
        tier: row.tier,
        model: row.model,
        latencyMs: row.latencyMs,
        firstTokenMs: row.firstTokenMs,
        totalTokens: row.totalTokens,
        turnId: row.turnId ?? null,
        deviceId: row.device?.deviceId ?? null,
        createdAt: row.createdAt,
      })),
    };
  }

  /** 单轮 LLM 调用链路：createdAt 升序，把同轮多次调用串成时间线 */
  async getByTurn(turnId: string) {
    const rows = await this.prisma.llmUsageLog.findMany({
      where: { turnId },
      orderBy: { createdAt: "asc" },
    });

    return {
      turnId,
      calls: rows.map((row) => ({
        id: row.id,
        scene: row.scene,
        model: row.model,
        tier: row.tier,
        success: row.success,
        failureReason: row.failureReason,
        latencyMs: row.latencyMs,
        firstTokenMs: row.firstTokenMs,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        createdAt: row.createdAt,
      })),
    };
  }

  /** 最近失败明细：createdAt 倒序，deviceId 对外返回业务 ID */
  async getRecentFailures(query: LlmRecentFailuresQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = {
      success: false,
      ...(query.scene ? { scene: query.scene } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.llmUsageLog.count({ where }),
      this.prisma.llmUsageLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { device: { select: { deviceId: true } } },
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      items: rows.map((row) => ({
        id: row.id,
        scene: row.scene,
        tier: row.tier,
        model: row.model,
        failureReason: row.failureReason,
        latencyMs: row.latencyMs,
        turnId: row.turnId ?? null,
        deviceId: row.device?.deviceId ?? null,
        createdAt: row.createdAt,
      })),
    };
  }
}
