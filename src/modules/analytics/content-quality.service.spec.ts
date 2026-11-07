import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  reportDayRange,
} from "../learning-stats/parent-report-date.util";
import { ContentService } from "./content.service";
import { QualityService } from "./quality.service";

type Row = Record<string, any>;

function spokeAtOn(dateKey: string, hour = 12): Date {
  const { start } = reportDayRange(dateKey, DEFAULT_REPORT_TIMEZONE);
  return new Date(start.getTime() + hour * 3600000);
}

function applyDateRange(
  rows: Row[],
  field: string,
  range?: { gte?: Date; lte?: string; lt?: Date },
) {
  if (!range) return rows;
  return rows.filter((row) => {
    const value = row[field];
    if (range.gte && value < range.gte) return false;
    if (range.lt && value >= range.lt) return false;
    if (range.lte && value > range.lte) return false;
    return true;
  });
}

function buildPrisma(data: {
  progresses?: Row[];
  stats?: Row[];
  habitPlans?: Row[];
  messages?: Row[];
  reports?: Row[];
  feedbacks?: Row[];
}) {
  return {
    adventureProgress: {
      findMany: jest.fn(({ where }: any = {}) =>
        applyDateRange(data.progresses ?? [], "createdAt", where?.createdAt),
      ),
    },
    learningStat: {
      findMany: jest.fn(({ where }: any = {}) =>
        applyDateRange(data.stats ?? [], "statDate", where?.statDate),
      ),
    },
    habitPlan: {
      findMany: jest.fn(({ where }: any = {}) =>
        (data.habitPlans ?? []).filter(
          (p) => !where?.status || p.status === where.status,
        ),
      ),
    },
    message: {
      findMany: jest.fn(({ where, distinct }: any = {}) => {
        let rows = data.messages ?? [];
        if (where?.role) rows = rows.filter((m) => m.role === where.role);
        rows = applyDateRange(rows, "spokeAt", where?.spokeAt);
        if (distinct?.includes("deviceId")) {
          const seen = new Set<string>();
          rows = rows.filter((m) =>
            seen.has(m.deviceId) ? false : (seen.add(m.deviceId), true),
          );
        }
        return rows;
      }),
    },
    parentReport: {
      count: jest.fn(({ where }: any = {}) => {
        let rows = applyDateRange(
          data.reports ?? [],
          "reportDate",
          where?.reportDate,
        );
        if (where?.generationStatus) {
          rows = rows.filter(
            (r) => r.generationStatus === where.generationStatus,
          );
        }
        return rows.length;
      }),
    },
    parentReportFeedback: {
      findMany: jest.fn(({ where }: any = {}) =>
        applyDateRange(data.feedbacks ?? [], "reportDate", where?.reportDate),
      ),
    },
  };
}

async function buildServices(prisma: any) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ContentService,
      QualityService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return {
    content: module.get(ContentService),
    quality: module.get(QualityService),
  };
}

describe("ContentService", () => {
  it("adventure：完集率、平均星光、集排行", async () => {
    const { content } = await buildServices(
      buildPrisma({
        progresses: [
          {
            deviceId: "d1",
            episodeId: "e1",
            status: "completed",
            stars: 3,
            episode: { title: "森林" },
            createdAt: spokeAtOn("2026-11-01"),
          },
          {
            deviceId: "d2",
            episodeId: "e1",
            status: "completed",
            stars: 1,
            episode: { title: "森林" },
            createdAt: spokeAtOn("2026-11-02"),
          },
          {
            deviceId: "d2",
            episodeId: "e2",
            status: "in_progress",
            stars: 0,
            episode: { title: "海洋" },
            createdAt: spokeAtOn("2026-11-03"),
          },
        ],
      }),
    );

    const result = await content.getAdventure({});

    expect(result.startedDevices).toBe(2);
    expect(result.completedEpisodes).toBe(2);
    expect(result.completionRate).toBeCloseTo(0.6667, 3);
    expect(result.avgStarsPerEpisode).toBe(2);
    expect(result.topEpisodes[0]).toEqual({
      episodeId: "e1",
      title: "森林",
      completions: 2,
      avgStars: 2,
    });
  });

  it("learning：新词/开口按 statDate 区间聚合", async () => {
    const { content } = await buildServices(
      buildPrisma({
        stats: [
          {
            deviceId: "d1",
            statDate: "2026-11-04",
            newWords: 3,
            speakCount: 10,
          },
          {
            deviceId: "d2",
            statDate: "2026-11-05",
            newWords: 5,
            speakCount: 8,
          },
          {
            deviceId: "d1",
            statDate: "2026-12-01",
            newWords: 99,
            speakCount: 99,
          },
        ],
        messages: [
          { deviceId: "d1", role: "user", spokeAt: spokeAtOn("2026-11-04") },
        ],
        habitPlans: [
          {
            status: "active",
            targetDays: 10,
            dailyRecords: [
              { completed: true },
              { completed: true },
              { completed: false },
            ],
          },
        ],
      }),
    );

    const result = await content.getLearning({
      startDate: "2026-11-04",
      endDate: "2026-11-05",
    });

    expect(result.totalNewWords).toBe(8);
    expect(result.speakCountTotal).toBe(18);
    expect(result.avgNewWordsPerActiveDevice).toBe(8); // 活跃设备仅 d1
    expect(result.habitPlansActive).toBe(1);
    expect(result.habitCompletionRate).toBe(0.2);
  });

  it("parent-report：成功率与有用率", async () => {
    const { content } = await buildServices(
      buildPrisma({
        reports: [
          { reportDate: "2026-11-04", generationStatus: "completed" },
          { reportDate: "2026-11-04", generationStatus: "completed" },
          { reportDate: "2026-11-05", generationStatus: "failed" },
        ],
        feedbacks: [
          { reportDate: "2026-11-04", isUseful: true },
          { reportDate: "2026-11-04", isUseful: false },
          { reportDate: "2026-11-05", isUseful: true },
        ],
      }),
    );

    const result = await content.getParentReport({
      startDate: "2026-11-04",
      endDate: "2026-11-05",
    });

    expect(result.generated).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.successRate).toBeCloseTo(0.6667, 3);
    expect(result.feedbackTotal).toBe(3);
    expect(result.usefulRate).toBeCloseTo(0.6667, 3);
  });

  it("非法范围返回 400", async () => {
    const { content } = await buildServices(buildPrisma({}));
    await expect(
      content.getLearning({ startDate: "bad", endDate: "2026-11-05" }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe("QualityService", () => {
  it("按日聚合失败率与安全拦截率", async () => {
    const { quality } = await buildServices(
      buildPrisma({
        messages: [
          {
            role: "user",
            status: "completed",
            spokeAt: spokeAtOn("2026-11-04"),
            rawPayload: null,
          },
          {
            role: "user",
            status: "completed",
            spokeAt: spokeAtOn("2026-11-04", 13),
            rawPayload: { safetyCategory: "sexual" },
          },
          {
            role: "assistant",
            status: "failed",
            spokeAt: spokeAtOn("2026-11-04", 13),
            rawPayload: null,
          },
          {
            role: "user",
            status: "completed",
            spokeAt: spokeAtOn("2026-11-05"),
            rawPayload: null,
          },
        ],
      }),
    );

    const result = await quality.getConversationQuality({
      startDate: "2026-11-04",
      endDate: "2026-11-05",
    });

    expect(result.series).toHaveLength(2);
    expect(result.series[0]).toEqual({
      date: "2026-11-04",
      totalTurns: 2,
      failedTurns: 1,
      failureRate: 0.5,
      safetyBlockedTurns: 1,
      safetyRate: 0.5,
    });
    expect(result.series[1].failureRate).toBe(0);
  });

  it("week 粒度按 ISO 周一聚合", async () => {
    const { quality } = await buildServices(
      buildPrisma({
        messages: [
          {
            role: "user",
            status: "completed",
            spokeAt: spokeAtOn("2026-11-02"),
            rawPayload: null,
          }, // 周一
          {
            role: "user",
            status: "completed",
            spokeAt: spokeAtOn("2026-11-08"),
            rawPayload: null,
          }, // 周日，同一周
          {
            role: "user",
            status: "completed",
            spokeAt: spokeAtOn("2026-11-09"),
            rawPayload: null,
          }, // 下周一
        ],
      }),
    );

    const result = await quality.getConversationQuality({
      startDate: "2026-11-02",
      endDate: "2026-11-09",
      granularity: "week",
    });

    expect(result.series).toHaveLength(2);
    expect(result.series[0].date).toBe("2026-11-02");
    expect(result.series[0].totalTurns).toBe(2);
    expect(result.series[1].date).toBe("2026-11-09");
  });
});
