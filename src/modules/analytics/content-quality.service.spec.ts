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
  adventureEvents?: Row[];
  adventureEpisodes?: Row[];
  adventureEpisodeVersions?: Row[];
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
    adventureEvent: {
      findMany: jest.fn(({ where }: any = {}) => {
        let rows = data.adventureEvents ?? [];
        if (where?.eventType?.in) {
          rows = rows.filter((e) =>
            (where.eventType.in as string[]).includes(e.eventType),
          );
        }
        if (where?.episodeId) {
          rows = rows.filter((e) => e.episodeId === where.episodeId);
        }
        return applyDateRange(rows, "createdAt", where?.createdAt);
      }),
    },
    adventureEpisode: {
      findMany: jest.fn(({ where }: any = {}) => {
        let rows = data.adventureEpisodes ?? [];
        if (where?.id?.in) {
          rows = rows.filter((e) => (where.id.in as string[]).includes(e.id));
        }
        return rows;
      }),
    },
    adventureEpisodeVersion: {
      findMany: jest.fn(({ where }: any = {}) => {
        let rows = data.adventureEpisodeVersions ?? [];
        if (where?.id?.in) {
          rows = rows.filter((v) => (where.id.in as string[]).includes(v.id));
        }
        return rows;
      }),
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

  describe("adventure-choices", () => {
    // ---- 共享数据工厂 ----

    /** 单集 + 单个 two_choice 段的标准数据 */
    function standardChoiceData(overrides?: {
      events?: Row[];
      episodes?: Row[];
      versions?: Row[];
    }) {
      const e1 = overrides?.episodes?.[0] ?? { id: "e1", title: "森林" };
      const v1 = overrides?.versions?.[0] ?? {
        id: "v1",
        episodeId: "e1",
        payload: {
          segments: [
            { order: 0, kind: "narration", text: "开场" },
            {
              order: 1,
              kind: "interaction",
              text: "选一个",
              interactionType: "two_choice",
              options: {
                choices: [
                  { key: "a", text: "红色", reply: "红" },
                  { key: "b", text: "蓝色", reply: "蓝" },
                ],
              },
            },
          ],
        },
      };
      return {
        adventureEvents: overrides?.events ?? [
          {
            eventType: "choice_matched",
            episodeId: "e1",
            episodeVersionId: "v1",
            segmentOrder: 1,
            payload: { index: 0, source: "deterministic", key: "a" },
            createdAt: spokeAtOn("2026-11-01"),
          },
          {
            eventType: "choice_matched",
            episodeId: "e1",
            episodeVersionId: "v1",
            segmentOrder: 1,
            payload: { index: 0, source: "llm", key: "a" },
            createdAt: spokeAtOn("2026-11-01", 13),
          },
          {
            eventType: "choice_matched",
            episodeId: "e1",
            episodeVersionId: "v1",
            segmentOrder: 1,
            payload: { index: 1, source: "llm", key: "b" },
            createdAt: spokeAtOn("2026-11-01", 14),
          },
          {
            eventType: "answered",
            episodeId: "e1",
            segmentOrder: 1,
            payload: { interactionType: "two_choice" },
            createdAt: spokeAtOn("2026-11-01"),
          },
          {
            eventType: "answered",
            episodeId: "e1",
            segmentOrder: 1,
            payload: { interactionType: "two_choice" },
            createdAt: spokeAtOn("2026-11-01", 13),
          },
          {
            eventType: "fallback",
            episodeId: "e1",
            segmentOrder: 1,
            payload: { interactionType: "two_choice" },
            createdAt: spokeAtOn("2026-11-01", 14),
          },
        ],
        adventureEpisodes: overrides?.episodes ?? [e1],
        adventureEpisodeVersions: overrides?.versions ?? [v1],
      };
    }

    // ---- Contract shape ----

    it("零数据 → 全 0/null、byEpisode 空", async () => {
      const { content } = await buildServices(buildPrisma({}));

      const result = await content.getAdventureChoices({});

      expect(result.totalInteractions).toBe(0);
      expect(result.outcomeCounts).toEqual({
        answered: 0,
        off_topic: 0,
        fallback: 0,
        timeout: 0,
      });
      expect(result.fallbackRate).toBeNull();
      expect(result.matchedTotal).toBe(0);
      expect(result.sourceCounts).toEqual({ deterministic: 0, llm: 0 });
      expect(result.llmShare).toBeNull();
      expect(result.byEpisode).toEqual([]);
    });

    it("totalInteractions = answered + fallback + timeout（two_choice 且不含 off_topic/exit）", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "answered",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "off_topic",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01", 13),
            },
            {
              eventType: "fallback",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01", 14),
            },
            {
              eventType: "timeout",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01", 15),
            },
          ],
          adventureEpisodes: [{ id: "e1", title: "森林" }],
          adventureEpisodeVersions: [],
        }),
      );

      const result = await content.getAdventureChoices({});

      // answered=1 + fallback=1 + timeout=1 = 3（off_topic 不算）
      expect(result.totalInteractions).toBe(3);
    });

    it("outcomeCounts 始终包含 4 个键，off_topic 计入", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "answered",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "off_topic",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01", 13),
            },
            {
              eventType: "off_topic",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01", 14),
            },
          ],
          adventureEpisodes: [{ id: "e1", title: "森林" }],
          adventureEpisodeVersions: [],
        }),
      );

      const result = await content.getAdventureChoices({});

      expect(result.outcomeCounts).toEqual({
        answered: 1,
        off_topic: 2,
        fallback: 0,
        timeout: 0,
      });
      // off_topic 不在 totalInteractions 中
      expect(result.totalInteractions).toBe(1);
    });

    it("payload 无 key 的历史行 → key 为 null（不是空字符串）", async () => {
      // #84 之前写入的 choice_matched 事件 payload 里没有 key 字段；
      // 契约是 key: string | null，前端 AdventureChoicesSection 用严格
      // v === null 判断显示「—」，返回 "" 会渲染成空白单元格。
      const { content } = await buildServices(
        buildPrisma(
          standardChoiceData({
            events: [
              {
                eventType: "choice_matched",
                episodeId: "e1",
                episodeVersionId: "v1",
                segmentOrder: 1,
                payload: { index: 0, source: "deterministic" },
                createdAt: spokeAtOn("2026-11-01"),
              },
            ],
          }),
        ),
      );

      const result = await content.getAdventureChoices({});

      expect(result.matchedTotal).toBe(1);
      expect(result.byEpisode[0].choices).toEqual([
        { segmentOrder: 1, index: 0, key: null, text: "红色", hits: 1 },
      ]);
    });

    it("matchedTotal 统计全部 choice_matched 事件", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 0, source: "deterministic", key: "a" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 1, source: "llm", key: "b" },
              createdAt: spokeAtOn("2026-11-01", 13),
            },
          ],
          adventureEpisodes: [{ id: "e1", title: "森林" }],
          adventureEpisodeVersions: [
            {
              id: "v1",
              episodeId: "e1",
              payload: {
                segments: [
                  {
                    order: 1,
                    kind: "interaction",
                    interactionType: "two_choice",
                    options: {
                      choices: [
                        { key: "a", text: "红色" },
                        { key: "b", text: "蓝色" },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        }),
      );

      const result = await content.getAdventureChoices({});

      expect(result.matchedTotal).toBe(2);
    });

    it("sourceCounts 分解 deterministic / llm", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 0, source: "deterministic", key: "a" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 0, source: "deterministic", key: "a" },
              createdAt: spokeAtOn("2026-11-01", 13),
            },
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 0, source: "llm", key: "a" },
              createdAt: spokeAtOn("2026-11-01", 14),
            },
          ],
          adventureEpisodes: [{ id: "e1", title: "森林" }],
          adventureEpisodeVersions: [
            {
              id: "v1",
              episodeId: "e1",
              payload: {
                segments: [
                  {
                    order: 1,
                    kind: "interaction",
                    interactionType: "two_choice",
                    options: { choices: [{ key: "a", text: "红色" }] },
                  },
                ],
              },
            },
          ],
        }),
      );

      const result = await content.getAdventureChoices({});

      expect(result.sourceCounts).toEqual({ deterministic: 2, llm: 1 });
    });

    it("llmShare = llm / matchedTotal（分母 matchedTotal，非 llm+det），分母 0 → null", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 0, source: "llm", key: "a" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 0, source: "llm", key: "a" },
              createdAt: spokeAtOn("2026-11-01", 13),
            },
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 1, source: "deterministic", key: "b" },
              createdAt: spokeAtOn("2026-11-01", 14),
            },
          ],
          adventureEpisodes: [{ id: "e1", title: "森林" }],
          adventureEpisodeVersions: [
            {
              id: "v1",
              episodeId: "e1",
              payload: {
                segments: [
                  {
                    order: 1,
                    kind: "interaction",
                    interactionType: "two_choice",
                    options: {
                      choices: [
                        { key: "a", text: "红色" },
                        { key: "b", text: "蓝色" },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        }),
      );

      const result = await content.getAdventureChoices({});

      // llm=2, matchedTotal=3 → 0.6667 (not 2/2=1.0)
      expect(result.llmShare).toBeCloseTo(0.6667, 4);
    });

    it("llmShare 分母 matchedTotal 为 0 → null", async () => {
      const { content } = await buildServices(buildPrisma({}));

      const result = await content.getAdventureChoices({});

      expect(result.llmShare).toBeNull();
    });

    it("fallbackRate 4 位小数，分母 0 → null", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "answered",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "answered",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01", 13),
            },
            {
              eventType: "fallback",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01", 14),
            },
          ],
          adventureEpisodes: [{ id: "e1", title: "森林" }],
          adventureEpisodeVersions: [],
        }),
      );

      const result = await content.getAdventureChoices({});

      // fallback=1, totalInteractions=3 → 0.3333
      expect(result.fallbackRate).toBeCloseTo(0.3333, 4);
    });

    it("byEpisode 内嵌 choices，按 matchedTotal 降序、title 升序排列", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "choice_matched",
              episodeId: "e2",
              episodeVersionId: "v2",
              segmentOrder: 1,
              payload: { index: 0, source: "deterministic", key: "x" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "choice_matched",
              episodeId: "e2",
              episodeVersionId: "v2",
              segmentOrder: 1,
              payload: { index: 0, source: "deterministic", key: "x" },
              createdAt: spokeAtOn("2026-11-01", 13),
            },
            {
              eventType: "answered",
              episodeId: "e2",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 0, source: "deterministic", key: "a" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "choice_matched",
              episodeId: "e3",
              episodeVersionId: "v3",
              segmentOrder: 1,
              payload: { index: 0, source: "deterministic", key: "y" },
              createdAt: spokeAtOn("2026-11-01"),
            },
          ],
          adventureEpisodes: [
            { id: "e1", title: "AAA" },
            { id: "e2", title: "CCC" },
            { id: "e3", title: "BBB" },
          ],
          adventureEpisodeVersions: [
            {
              id: "v1",
              episodeId: "e1",
              payload: {
                segments: [
                  {
                    order: 1,
                    kind: "interaction",
                    interactionType: "two_choice",
                    options: { choices: [{ key: "a", text: "红" }] },
                  },
                ],
              },
            },
            {
              id: "v2",
              episodeId: "e2",
              payload: {
                segments: [
                  {
                    order: 1,
                    kind: "interaction",
                    interactionType: "two_choice",
                    options: { choices: [{ key: "x", text: "X" }] },
                  },
                ],
              },
            },
            {
              id: "v3",
              episodeId: "e3",
              payload: {
                segments: [
                  {
                    order: 1,
                    kind: "interaction",
                    interactionType: "two_choice",
                    options: { choices: [{ key: "y", text: "Y" }] },
                  },
                ],
              },
            },
          ],
        }),
      );

      const result = await content.getAdventureChoices({});

      // e2 matchedTotal=2 > e1=1 = e3=1 → e2 first; e1 title "AAA" < e3 "BBB"
      expect(result.byEpisode.map((e) => e.episodeId)).toEqual([
        "e2",
        "e1",
        "e3",
      ]);
      // e2 has 2 choice_matched events for key "x"
      expect(result.byEpisode[0].choices).toEqual([
        { segmentOrder: 1, index: 0, key: "x", text: "X", hits: 2 },
      ]);
      // e1 has 1 choice_matched event for key "a"
      expect(result.byEpisode[1].choices).toEqual([
        { segmentOrder: 1, index: 0, key: "a", text: "红", hits: 1 },
      ]);
    });

    it("byEpisode 内 choices 按 segmentOrder asc null 最后、同段内 index asc 排序", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 2,
              payload: { index: 1, source: "deterministic", key: "c" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 2,
              payload: { index: 0, source: "deterministic", key: "b" },
              createdAt: spokeAtOn("2026-11-01", 13),
            },
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: null,
              payload: { index: 99, source: "deterministic", key: "z" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 0, source: "deterministic", key: "a" },
              createdAt: spokeAtOn("2026-11-01"),
            },
          ],
          adventureEpisodes: [{ id: "e1", title: "森林" }],
          adventureEpisodeVersions: [
            {
              id: "v1",
              episodeId: "e1",
              payload: {
                segments: [
                  {
                    order: 1,
                    kind: "interaction",
                    interactionType: "two_choice",
                    options: { choices: [{ key: "a", text: "A" }] },
                  },
                  {
                    order: 2,
                    kind: "interaction",
                    interactionType: "two_choice",
                    options: {
                      choices: [
                        { key: "b", text: "B" },
                        { key: "c", text: "C" },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        }),
      );

      const result = await content.getAdventureChoices({});

      const sorted = result.byEpisode[0].choices.map((c) => ({
        segmentOrder: c.segmentOrder,
        index: c.index,
      }));
      expect(sorted).toEqual([
        { segmentOrder: 1, index: 0 },
        { segmentOrder: 2, index: 0 },
        { segmentOrder: 2, index: 1 },
        { segmentOrder: null, index: 99 },
      ]);
    });

    it("choices[].text 用事件自己的 episodeVersionId 查版本 payload，不是遍历所有版本取第一个", async () => {
      // v1 有 index=0 text="红色"；v2 有 index=0 text="蓝色"
      // e1 事件引用 v1 → text="红色"；e2 事件引用 v2 → text="蓝色"
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 0, source: "deterministic", key: "a" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "choice_matched",
              episodeId: "e2",
              episodeVersionId: "v2",
              segmentOrder: 1,
              payload: { index: 0, source: "llm", key: "x" },
              createdAt: spokeAtOn("2026-11-01"),
            },
          ],
          adventureEpisodes: [
            { id: "e1", title: "森林" },
            { id: "e2", title: "海洋" },
          ],
          adventureEpisodeVersions: [
            {
              id: "v1",
              episodeId: "e1",
              payload: {
                segments: [
                  {
                    order: 1,
                    kind: "interaction",
                    interactionType: "two_choice",
                    options: { choices: [{ key: "a", text: "红色" }] },
                  },
                ],
              },
            },
            {
              id: "v2",
              episodeId: "e2",
              payload: {
                segments: [
                  {
                    order: 1,
                    kind: "interaction",
                    interactionType: "two_choice",
                    options: { choices: [{ key: "x", text: "蓝色" }] },
                  },
                ],
              },
            },
          ],
        }),
      );

      const result = await content.getAdventureChoices({});

      // e1 choice uses v1 → text="红色"
      const e1Choices = result.byEpisode.find(
        (e) => e.episodeId === "e1",
      )!.choices;
      expect(e1Choices[0].text).toBe("红色");

      // e2 choice uses v2 → text="蓝色"
      const e2Choices = result.byEpisode.find(
        (e) => e.episodeId === "e2",
      )!.choices;
      expect(e2Choices[0].text).toBe("蓝色");
    });

    it("版本 payload 畸形 → text=null 不抛异常", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 0, source: "deterministic", key: "a" },
              createdAt: spokeAtOn("2026-11-01"),
            },
          ],
          adventureEpisodes: [{ id: "e1", title: "森林" }],
          adventureEpisodeVersions: [
            {
              id: "v1",
              episodeId: "e1",
              payload: null,
            },
          ],
        }),
      );

      const result = await content.getAdventureChoices({});

      expect(result.byEpisode[0].choices[0].text).toBeNull();
      expect(result.byEpisode[0].choices[0].hits).toBe(1);
    });

    it("日期区间过滤（reportDayRange gte/lt 语义）", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 0, source: "deterministic", key: "a" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 0, source: "deterministic", key: "a" },
              createdAt: spokeAtOn("2026-11-03"),
            },
          ],
          adventureEpisodes: [{ id: "e1", title: "森林" }],
          adventureEpisodeVersions: [
            {
              id: "v1",
              episodeId: "e1",
              payload: {
                segments: [
                  {
                    order: 1,
                    kind: "interaction",
                    interactionType: "two_choice",
                    options: { choices: [{ key: "a", text: "红色" }] },
                  },
                ],
              },
            },
          ],
        }),
      );

      // startDate="2026-11-01" → gte 2026-11-01T00:00+08:00
      // endDate="2026-11-02"   → lt  2026-11-03T00:00+08:00
      // 所以 11-01 事件在范围内，11-03 事件不在
      const result = await content.getAdventureChoices({
        startDate: "2026-11-01",
        endDate: "2026-11-02",
      });

      expect(result.matchedTotal).toBe(1);
    });

    it("startDate > endDate → BadRequestException", async () => {
      const { content } = await buildServices(buildPrisma({}));

      await expect(
        content.getAdventureChoices({
          startDate: "2026-11-05",
          endDate: "2026-11-01",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("非法日期格式 → BadRequestException", async () => {
      const { content } = await buildServices(buildPrisma({}));

      await expect(
        content.getAdventureChoices({
          startDate: "bad",
          endDate: "2026-11-01",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("exit 事件不查询、不计入任何指标", async () => {
      // exit 不在 eventType.in 中，所以即使有 exit 事件也不影响结果
      // mock 已经通过 eventType.in 过滤，这里验证 exit 确实被排除
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "exit",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "answered",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01", 13),
            },
          ],
          adventureEpisodes: [{ id: "e1", title: "森林" }],
          adventureEpisodeVersions: [],
        }),
      );

      const result = await content.getAdventureChoices({});

      // totalInteractions 只有 answered=1（exit 未查询）
      expect(result.totalInteractions).toBe(1);
      expect(result.outcomeCounts.answered).toBe(1);
    });

    it("byEpisode fallbackRate 按各集独立计算", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "answered",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "fallback",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01", 13),
            },
            {
              eventType: "answered",
              episodeId: "e2",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "answered",
              episodeId: "e2",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01", 13),
            },
          ],
          adventureEpisodes: [
            { id: "e1", title: "森林" },
            { id: "e2", title: "海洋" },
          ],
          adventureEpisodeVersions: [],
        }),
      );

      const result = await content.getAdventureChoices({});

      // e1: fallbackRate = 1/2 = 0.5
      const e1 = result.byEpisode.find((e) => e.episodeId === "e1")!;
      expect(e1.fallbackRate).toBe(0.5);
      // e2: fallbackRate = 0/2 = 0
      const e2 = result.byEpisode.find((e) => e.episodeId === "e2")!;
      expect(e2.fallbackRate).toBe(0);
    });

    it("PII 红线：响应不含 asrText / messageId / deviceId", async () => {
      const { content } = await buildServices(
        buildPrisma(standardChoiceData()),
      );

      const result = await content.getAdventureChoices({});
      const json = JSON.stringify(result);

      expect(json).not.toContain("asrText");
      expect(json).not.toContain("messageId");
      expect(json).not.toContain("deviceId");
    });
  });

  describe("边界补测", () => {
    it("adventure：带完整日期区间 → 走 rangeFilter 过滤路径", async () => {
      const { content } = await buildServices(
        buildPrisma({
          progresses: [
            {
              deviceId: "d1",
              episodeId: "e1",
              status: "completed",
              stars: 2,
              episode: { title: "森林" },
              createdAt: spokeAtOn("2026-11-01"),
            },
          ],
        }),
      );
      const result = await content.getAdventure({
        startDate: "2026-11-01",
        endDate: "2026-11-05",
      });
      expect(result.completedEpisodes).toBe(1);
    });

    it("adventure：零进度 → completionRate/avgStarsPerEpisode 为 null", async () => {
      const { content } = await buildServices(buildPrisma({ progresses: [] }));
      const result = await content.getAdventure({});
      expect(result.completionRate).toBeNull();
      expect(result.avgStarsPerEpisode).toBeNull();
      expect(result.startedDevices).toBe(0);
    });

    it("adventure-choices：payload 非对象 / 非 two_choice → 不计入 interaction", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "answered",
              episodeId: "e1",
              segmentOrder: 1,
              payload: null,
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "answered",
              episodeId: "e1",
              segmentOrder: 1,
              payload: { interactionType: "open_question" },
              createdAt: spokeAtOn("2026-11-01", 13),
            },
          ],
          adventureEpisodes: [{ id: "e1", title: "森林" }],
          adventureEpisodeVersions: [],
        }),
      );
      const result = await content.getAdventureChoices({});
      expect(result.totalInteractions).toBe(0);
    });

    it("adventure-choices：source 非 llm/deterministic → sourceCounts 均 0", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 0, source: "unknown", key: "a" },
              createdAt: spokeAtOn("2026-11-01"),
            },
          ],
          adventureEpisodes: [{ id: "e1", title: "森林" }],
          adventureEpisodeVersions: [
            {
              id: "v1",
              payload: {
                segments: [
                  {
                    order: 1,
                    options: { choices: [{ key: "a", text: "红" }] },
                  },
                ],
              },
            },
          ],
        }),
      );
      const result = await content.getAdventureChoices({});
      expect(result.matchedTotal).toBe(1);
      expect(result.sourceCounts).toEqual({ deterministic: 0, llm: 0 });
    });

    it("adventure-choices：choices[index] 越界 → text 为 null", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 5, source: "llm", key: null },
              createdAt: spokeAtOn("2026-11-01"),
            },
          ],
          adventureEpisodes: [{ id: "e1", title: "森林" }],
          adventureEpisodeVersions: [
            {
              id: "v1",
              payload: {
                segments: [
                  {
                    order: 1,
                    options: { choices: [{ key: "a", text: "红" }] },
                  },
                ],
              },
            },
          ],
        }),
      );
      const result = await content.getAdventureChoices({});
      expect(result.byEpisode[0].choices[0].text).toBeNull();
    });

    it("adventure-choices：episode 不在 titleMap → 标题回落 '未知'", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "answered",
              episodeId: "e-unknown",
              segmentOrder: 1,
              payload: { interactionType: "two_choice" },
              createdAt: spokeAtOn("2026-11-01"),
            },
          ],
          adventureEpisodes: [],
          adventureEpisodeVersions: [],
        }),
      );
      const result = await content.getAdventureChoices({});
      expect(result.byEpisode[0].title).toBe("未知");
    });

    it("adventure-choices：segmentOrder null 的 choice 排在最后", async () => {
      const { content } = await buildServices(
        buildPrisma({
          adventureEvents: [
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: null,
              payload: { index: 0, source: "llm", key: "a" },
              createdAt: spokeAtOn("2026-11-01"),
            },
            {
              eventType: "choice_matched",
              episodeId: "e1",
              episodeVersionId: "v1",
              segmentOrder: 1,
              payload: { index: 1, source: "llm", key: "b" },
              createdAt: spokeAtOn("2026-11-01", 13),
            },
          ],
          adventureEpisodes: [{ id: "e1", title: "森林" }],
          adventureEpisodeVersions: [
            {
              id: "v1",
              payload: {
                segments: [
                  {
                    order: 1,
                    options: {
                      choices: [
                        { key: "a", text: "红" },
                        { key: "b", text: "蓝" },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      const result = await content.getAdventureChoices({});
      // segmentOrder 非 null 的排前，null 的排后
      expect(result.byEpisode[0].choices[0].segmentOrder).toBe(1);
      expect(result.byEpisode[0].choices[1].segmentOrder).toBeNull();
    });

    it("learning：targetDays 0 / 无活跃设备", async () => {
      const { content } = await buildServices(
        buildPrisma({
          stats: [],
          messages: [],
          habitPlans: [{ status: "active", targetDays: 0, dailyRecords: [] }],
        }),
      );
      const result = await content.getLearning({
        startDate: "2026-11-01",
        endDate: "2026-11-05",
      });
      expect(result.avgNewWordsPerActiveDevice).toBe(0);
      expect(result.habitCompletionRate).not.toBeNull();
    });

    it("learning：无习惯计划 → habitCompletionRate 为 null", async () => {
      const { content } = await buildServices(
        buildPrisma({ stats: [], messages: [], habitPlans: [] }),
      );
      const result = await content.getLearning({
        startDate: "2026-11-01",
        endDate: "2026-11-05",
      });
      expect(result.habitCompletionRate).toBeNull();
    });

    it("parent-report：generated 0 / 无反馈 → successRate/usefulRate 为 null", async () => {
      const { content } = await buildServices(
        buildPrisma({ reports: [], feedbacks: [] }),
      );
      const result = await content.getParentReport({
        startDate: "2026-11-01",
        endDate: "2026-11-05",
      });
      expect(result.successRate).toBeNull();
      expect(result.usefulRate).toBeNull();
    });
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
