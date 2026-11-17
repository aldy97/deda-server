import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  isValidReportDate,
  reportDateInTimezone,
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
