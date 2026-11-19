import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  isValidReportDate,
  reportDayRange,
} from "../learning-stats/parent-report-date.util";
import { AnalyticsDateRangeQueryDto } from "./dto/analytics-query.dto";

function assertValidRange(startDate: string, endDate: string) {
  if (!isValidReportDate(startDate) || !isValidReportDate(endDate)) {
    throw new BadRequestException("Invalid date");
  }
  if (startDate > endDate) {
    throw new BadRequestException("startDate must be <= endDate");
  }
}

@Injectable()
export class ContentService {
  constructor(private readonly prisma: PrismaService) {}

  async getAdventure(query: { startDate?: string; endDate?: string }) {
    const rangeFilter =
      query.startDate && query.endDate
        ? (() => {
            assertValidRange(query.startDate, query.endDate);
            const { start } = reportDayRange(
              query.startDate,
              DEFAULT_REPORT_TIMEZONE,
            );
            const { end } = reportDayRange(
              query.endDate,
              DEFAULT_REPORT_TIMEZONE,
            );
            return { createdAt: { gte: start, lt: end } };
          })()
        : {};

    const progresses = await this.prisma.adventureProgress.findMany({
      where: rangeFilter,
      select: {
        deviceId: true,
        episodeId: true,
        status: true,
        stars: true,
        episode: { select: { title: true } },
      },
    });

    const startedDevices = new Set(progresses.map((row) => row.deviceId)).size;
    const completed = progresses.filter((row) => row.status === "completed");
    const avgStarsPerEpisode =
      completed.length > 0
        ? Math.round(
            (completed.reduce((sum, row) => sum + row.stars, 0) /
              completed.length) *
              100,
          ) / 100
        : null;

    const byEpisode = new Map<
      string,
      { episodeId: string; title: string; completions: number; stars: number[] }
    >();
    for (const row of completed) {
      let bucket = byEpisode.get(row.episodeId);
      if (!bucket) {
        bucket = {
          episodeId: row.episodeId,
          title: row.episode.title,
          completions: 0,
          stars: [],
        };
        byEpisode.set(row.episodeId, bucket);
      }
      bucket.completions += 1;
      bucket.stars.push(row.stars);
    }
    const topEpisodes = Array.from(byEpisode.values())
      .map((bucket) => ({
        episodeId: bucket.episodeId,
        title: bucket.title,
        completions: bucket.completions,
        avgStars:
          bucket.stars.length > 0
            ? Math.round(
                (bucket.stars.reduce((sum, s) => sum + s, 0) /
                  bucket.stars.length) *
                  100,
              ) / 100
            : null,
      }))
      .sort((a, b) => b.completions - a.completions)
      .slice(0, 10);

    return {
      startedDevices,
      completedEpisodes: completed.length,
      completionRate:
        progresses.length > 0
          ? Math.round((completed.length / progresses.length) * 10000) / 10000
          : null,
      avgStarsPerEpisode,
      topEpisodes,
    };
  }

  async getAdventureChoices(query: { startDate?: string; endDate?: string }) {
    const rangeFilter =
      query.startDate && query.endDate
        ? (() => {
            assertValidRange(query.startDate, query.endDate);
            const { start } = reportDayRange(
              query.startDate,
              DEFAULT_REPORT_TIMEZONE,
            );
            const { end } = reportDayRange(
              query.endDate,
              DEFAULT_REPORT_TIMEZONE,
            );
            return { createdAt: { gte: start, lt: end } };
          })()
        : {};

    // exit 不查询——不计入任何指标
    const eventTypes = [
      "choice_matched",
      "answered",
      "off_topic",
      "fallback",
      "timeout",
    ] as const;

    const events = await this.prisma.adventureEvent.findMany({
      where: {
        eventType: { in: [...eventTypes] },
        ...rangeFilter,
      },
      select: {
        episodeId: true,
        segmentOrder: true,
        eventType: true,
        payload: true,
        episodeVersionId: true,
      },
    });

    function payloadInteractionType(payload: unknown): string | undefined {
      const p = (payload ?? {}) as Record<string, unknown>;
      return typeof p.interactionType === "string"
        ? p.interactionType
        : undefined;
    }

    // 收集 choice_matched 事件的 episodeVersionId，用于查版本 payload
    const versionIds = new Set(
      events
        .filter((e) => e.eventType === "choice_matched")
        .map((e) => e.episodeVersionId)
        .filter(Boolean) as string[],
    );

    // 收集所有出现过事件的 episodeId（含 choice_matched 与 two_choice interaction）
    const allEpisodeIds = new Set<string>();
    for (const event of events) {
      if (event.eventType === "choice_matched") {
        allEpisodeIds.add(event.episodeId);
      } else if (payloadInteractionType(event.payload) === "two_choice") {
        allEpisodeIds.add(event.episodeId);
      }
    }

    const [episodes, versions] = await Promise.all([
      allEpisodeIds.size > 0
        ? this.prisma.adventureEpisode.findMany({
            where: { id: { in: [...allEpisodeIds] } },
            select: { id: true, title: true },
          })
        : ([] as { id: string; title: string }[]),
      versionIds.size > 0
        ? this.prisma.adventureEpisodeVersion.findMany({
            where: { id: { in: [...versionIds] } },
            select: { id: true, payload: true },
          })
        : ([] as { id: string; payload: unknown }[]),
    ]);

    const titleMap = new Map(episodes.map((ep) => [ep.id, ep.title]));

    // versionId → payload map，用于按事件自己的 episodeVersionId 查 text
    const versionPayloadMap = new Map(
      versions.map((v) => [v.id, v.payload] as const),
    );

    // 从版本 payload 中提取 choice text
    type VersionSegment = {
      order?: number | null;
      options?: { choices?: Array<{ text?: string | null }> };
    };

    function choiceText(
      payload: unknown,
      segmentOrder: number | null,
      index: number,
    ): string | null {
      const p = (payload ?? {}) as { segments?: VersionSegment[] };
      if (!Array.isArray(p.segments)) return null;
      const seg = p.segments.find((s) => s.order === segmentOrder);
      const choices = seg?.options?.choices;
      if (!Array.isArray(choices)) return null;
      return choices[index]?.text ?? null;
    }

    // ---- 全局聚合 ----
    let totalInteractions = 0;
    let fallbackCount = 0;
    let outcomeAnswered = 0;
    let outcomeOffTopic = 0;
    let outcomeFallback = 0;
    let outcomeTimeout = 0;
    let matchedTotal = 0;
    let sourceDeterministic = 0;
    let sourceLlm = 0;

    // ---- 按 episode 聚合 ----
    type EpChoiceKey = string; // `${episodeId}::${segmentOrder ?? "null"}::${index}`
    const epChoiceMap = new Map<
      EpChoiceKey,
      {
        episodeId: string;
        episodeVersionId: string | null;
        segmentOrder: number | null;
        index: number;
        key: string | null;
        hits: number;
      }
    >();

    // 按 episode 的 interaction/fb 计数
    const epInteractionCount = new Map<string, number>();
    const epFallbackCount = new Map<string, number>();

    for (const event of events) {
      if (event.eventType === "choice_matched") {
        matchedTotal++;
        const pl = (event.payload ?? {}) as Record<string, unknown>;
        if (pl.source === "llm") sourceLlm++;
        else if (pl.source === "deterministic") sourceDeterministic++;

        const segOrder = event.segmentOrder;
        const index = typeof pl.index === "number" ? pl.index : undefined;
        if (index != null) {
          const ck: EpChoiceKey = `${event.episodeId}::${segOrder ?? "null"}::${index}`;
          const existing = epChoiceMap.get(ck);
          if (existing) {
            existing.hits++;
          } else {
            epChoiceMap.set(ck, {
              episodeId: event.episodeId,
              episodeVersionId: event.episodeVersionId,
              segmentOrder: segOrder,
              index,
              key: typeof pl.key === "string" ? pl.key : null,
              hits: 1,
            });
          }
        }
        continue;
      }

      // 非 choice_matched 事件：检查 interactionType
      const pType = payloadInteractionType(event.payload);
      if (pType !== "two_choice") continue;

      if (event.eventType === "off_topic") {
        outcomeOffTopic++;
        continue; // off_topic 不计入 totalInteractions
      }

      totalInteractions++;

      if (event.eventType === "answered") outcomeAnswered++;
      else if (event.eventType === "fallback") {
        outcomeFallback++;
        fallbackCount++;
      } else if (event.eventType === "timeout") outcomeTimeout++;

      // 按 episode 统计 interaction/fallback
      const epId = event.episodeId;
      epInteractionCount.set(epId, (epInteractionCount.get(epId) ?? 0) + 1);
      if (event.eventType === "fallback") {
        epFallbackCount.set(epId, (epFallbackCount.get(epId) ?? 0) + 1);
      }
    }

    const fallbackRate =
      totalInteractions > 0
        ? Math.round((fallbackCount / totalInteractions) * 10000) / 10000
        : null;

    const llmShare =
      matchedTotal > 0
        ? Math.round((sourceLlm / matchedTotal) * 10000) / 10000
        : null;

    // ---- 构建 byEpisode（含 choices） ----
    // 按 episodeId 分组 choices，同时统计 per-episode matchedTotal
    const epChoices = new Map<
      string,
      Array<{
        segmentOrder: number | null;
        index: number;
        key: string | null;
        text: string | null;
        hits: number;
      }>
    >();
    const epMatchedTotal = new Map<string, number>();

    for (const c of epChoiceMap.values()) {
      const epId = c.episodeId;
      if (!epChoices.has(epId)) epChoices.set(epId, []);
      epMatchedTotal.set(epId, (epMatchedTotal.get(epId) ?? 0) + c.hits);

      // 用事件自己的 episodeVersionId 查版本 payload 取 text
      let text: string | null = null;
      if (c.episodeVersionId) {
        const payload = versionPayloadMap.get(c.episodeVersionId);
        text = choiceText(payload, c.segmentOrder, c.index);
      }

      epChoices.get(epId)!.push({
        segmentOrder: c.segmentOrder,
        index: c.index,
        key: c.key,
        text,
        hits: c.hits,
      });
    }

    // 按 episode 排序 choices
    for (const [, choices] of epChoices) {
      choices.sort((a, b) => {
        if (a.segmentOrder === null && b.segmentOrder !== null) return 1;
        if (a.segmentOrder !== null && b.segmentOrder === null) return -1;
        if (a.segmentOrder !== null && b.segmentOrder !== null) {
          if (a.segmentOrder !== b.segmentOrder)
            return a.segmentOrder - b.segmentOrder;
        }
        return a.index - b.index;
      });
    }

    const byEpisode = Array.from(allEpisodeIds)
      .map((epId) => {
        const choices = epChoices.get(epId) ?? [];
        const interactionCount = epInteractionCount.get(epId) ?? 0;
        const fbCount = epFallbackCount.get(epId) ?? 0;
        return {
          episodeId: epId,
          title: titleMap.get(epId) ?? "未知",
          matchedTotal: epMatchedTotal.get(epId) ?? 0,
          fallbackRate:
            interactionCount > 0
              ? Math.round((fbCount / interactionCount) * 10000) / 10000
              : null,
          choices,
        };
      })
      .sort((a, b) => {
        if (b.matchedTotal !== a.matchedTotal)
          return b.matchedTotal - a.matchedTotal;
        return a.title.localeCompare(b.title, "zh-CN");
      });

    return {
      totalInteractions,
      outcomeCounts: {
        answered: outcomeAnswered,
        off_topic: outcomeOffTopic,
        fallback: outcomeFallback,
        timeout: outcomeTimeout,
      },
      fallbackRate,
      matchedTotal,
      sourceCounts: { deterministic: sourceDeterministic, llm: sourceLlm },
      llmShare,
      byEpisode,
    };
  }

  async getLearning(query: AnalyticsDateRangeQueryDto) {
    assertValidRange(query.startDate, query.endDate);

    const stats = await this.prisma.learningStat.findMany({
      where: {
        statDate: { gte: query.startDate, lte: query.endDate },
      },
      select: { deviceId: true, newWords: true, speakCount: true },
    });
    const { start } = reportDayRange(query.startDate, DEFAULT_REPORT_TIMEZONE);
    const { end } = reportDayRange(query.endDate, DEFAULT_REPORT_TIMEZONE);
    const [activeMessages, habitPlans] = await Promise.all([
      this.prisma.message.findMany({
        where: { role: "user", spokeAt: { gte: start, lt: end } },
        select: { deviceId: true },
        distinct: ["deviceId"],
      }),
      this.prisma.habitPlan.findMany({
        where: { status: "active" },
        select: {
          targetDays: true,
          dailyRecords: { select: { completed: true } },
        },
      }),
    ]);

    const totalNewWords = stats.reduce((sum, row) => sum + row.newWords, 0);
    const speakCountTotal = stats.reduce((sum, row) => sum + row.speakCount, 0);
    const activeDevices = activeMessages.length;

    const completionRates = habitPlans.map((plan) =>
      plan.targetDays > 0
        ? plan.dailyRecords.filter((record) => record.completed).length /
          plan.targetDays
        : 0,
    );

    return {
      totalNewWords,
      avgNewWordsPerActiveDevice:
        activeDevices > 0
          ? Math.round((totalNewWords / activeDevices) * 100) / 100
          : 0,
      speakCountTotal,
      habitPlansActive: habitPlans.length,
      habitCompletionRate:
        completionRates.length > 0
          ? Math.round(
              (completionRates.reduce((sum, rate) => sum + rate, 0) /
                completionRates.length) *
                10000,
            ) / 10000
          : null,
    };
  }

  async getParentReport(query: AnalyticsDateRangeQueryDto) {
    assertValidRange(query.startDate, query.endDate);

    const [generated, failed, feedbacks] = await Promise.all([
      this.prisma.parentReport.count({
        where: {
          reportDate: { gte: query.startDate, lte: query.endDate },
        },
      }),
      this.prisma.parentReport.count({
        where: {
          reportDate: { gte: query.startDate, lte: query.endDate },
          generationStatus: "failed",
        },
      }),
      this.prisma.parentReportFeedback.findMany({
        where: {
          reportDate: { gte: query.startDate, lte: query.endDate },
        },
        select: { isUseful: true },
      }),
    ]);

    const useful = feedbacks.filter((feedback) => feedback.isUseful).length;

    return {
      generated,
      failed,
      successRate:
        generated > 0
          ? Math.round(((generated - failed) / generated) * 10000) / 10000
          : null,
      feedbackTotal: feedbacks.length,
      usefulRate:
        feedbacks.length > 0
          ? Math.round((useful / feedbacks.length) * 10000) / 10000
          : null,
    };
  }
}
