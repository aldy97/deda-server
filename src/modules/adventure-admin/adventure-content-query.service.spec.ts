import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AdventureContentQueryService } from "./adventure-content-query.service";
import {
  ADVENTURE_SEASON,
  EpisodeContentDraft,
} from "./adventure-content.types";
import { DEFAULT_LINT_THRESHOLDS } from "./adventure-linter";
import { DEFAULT_SIMULATION_THRESHOLDS } from "./adventure-simulator";

/**
 * 读侧的全部价值在于「让 admin 在动手之前看见真相」：
 * 影响面数字、版本谱系、当前草稿基线。所以这里重点断言查询条件与派生字段，
 * 而不是断言 Prisma 被调用了几次。
 */
describe("AdventureContentQueryService", () => {
  let service: AdventureContentQueryService;
  let prisma: {
    adventureEpisode: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
    };
    adventureEpisodeVersion: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
    };
    adventureProgress: { count: jest.Mock; findMany: jest.Mock };
    adventureDailyRecord: { count: jest.Mock; findMany: jest.Mock };
    adventureSegment: { findMany: jest.Mock };
  };

  const ellyEpisode = {
    id: "ep1",
    characterKey: "elly",
    season: 1,
    episodeNumber: 3,
    title: "第三集",
    recap: "上集回顾",
    published: true,
    retiredAt: null,
    currentVersionId: "v2",
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-10T00:00:00Z"),
  };

  const draftContent: EpisodeContentDraft = {
    title: "第三集",
    recap: "上集回顾",
    segments: [
      { order: 0, kind: "narration", text: "开场" },
      {
        order: 1,
        kind: "interaction",
        text: "你看到了什么？",
        interactionType: "open_question",
        fallbackText: "没关系",
        exitText: "那我们先休息一下",
      },
    ],
  };

  beforeEach(async () => {
    prisma = {
      adventureEpisode: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      adventureEpisodeVersion: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      adventureProgress: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      adventureDailyRecord: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      adventureSegment: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdventureContentQueryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === "CONTENT_ADMIN_PROFILE") {
                return "authoring";
              }
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(AdventureContentQueryService);
  });

  describe("capabilities", () => {
    it("publishes the closed vocabularies the editor must render from", () => {
      const caps = service.capabilities();

      expect(caps.season).toBe(ADVENTURE_SEASON);
      expect(caps.characterKeys).toEqual(["elly", "polly"]);
      expect(caps.interactionTypes).toEqual([
        "open_question",
        "two_choice",
        "repeat_after_me",
        "reward",
      ]);
      // reward 不等回答，编辑器据此决定是否要求填 fallback/exit
      expect(caps.replyWaitingInteractionTypes).toEqual([
        "open_question",
        "two_choice",
        "repeat_after_me",
      ]);
      expect(caps.segmentKinds).toEqual(["narration", "interaction"]);
      expect(caps.lintThresholds).toEqual(DEFAULT_LINT_THRESHOLDS);
      expect(caps.simulationThresholds).toEqual(DEFAULT_SIMULATION_THRESHOLDS);
      expect(caps.profile).toBe("authoring");
      expect(caps.authoring).toBe(true);
    });

    it("reports a readonly profile as non-authoring so the UI can disable every write control", () => {
      const readonlyService = new AdventureContentQueryService(
        prisma as never,
        {
          get: (key: string) =>
            key === "CONTENT_ADMIN_PROFILE" ? "readonly" : undefined,
        } as never,
      );

      expect(readonlyService.capabilities()).toMatchObject({
        profile: "readonly",
        authoring: false,
      });
    });
  });

  describe("listEpisodes", () => {
    it("always scopes to the supported season and hides retired rows unless asked", async () => {
      await service.listEpisodes({});

      const where = prisma.adventureEpisode.findMany.mock.calls[0][0].where;
      expect(where.season).toBe(ADVENTURE_SEASON);
      expect(where.retiredAt).toBeNull();
    });

    it("keeps retired rows visible when the admin asks for them", async () => {
      await service.listEpisodes({ includeRetired: true });

      const where = prisma.adventureEpisode.findMany.mock.calls[0][0].where;
      expect(where.retiredAt).toBeUndefined();
    });

    it("derives the business key and the draft/published version numbers for each row", async () => {
      prisma.adventureEpisode.findMany.mockResolvedValue([ellyEpisode]);
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        {
          episodeId: "ep1",
          id: "v2",
          version: 2,
          status: "published",
          publishedAt: new Date("2026-11-05"),
        },
        {
          episodeId: "ep1",
          id: "v3",
          version: 3,
          status: "draft",
          updatedAt: new Date("2026-11-09"),
          createdByName: "Bob",
        },
      ]);

      const result = await service.listEpisodes({});

      expect(result.items).toEqual([
        expect.objectContaining({
          id: "ep1",
          businessKey: "elly/1/3",
          currentVersion: 2,
          currentVersionId: "v2",
          publishedAt: new Date("2026-11-05"),
          draftVersionId: "v3",
          draftVersion: 3,
          draftUpdatedBy: "Bob",
          hasDraft: true,
        }),
      ]);
    });

    it("reports hasDraft false for an episode with no draft row", async () => {
      prisma.adventureEpisode.findMany.mockResolvedValue([ellyEpisode]);
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([]);

      const result = await service.listEpisodes({});

      expect(result.items[0]).toMatchObject({
        hasDraft: false,
        draftVersionId: null,
        currentVersion: null,
      });
    });

    it("never leaks a discarded version as the current draft", async () => {
      prisma.adventureEpisode.findMany.mockResolvedValue([ellyEpisode]);
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        { episodeId: "ep1", id: "v9", version: 9, status: "discarded" },
      ]);

      const result = await service.listEpisodes({});

      expect(result.items[0].hasDraft).toBe(false);
    });
  });

  describe("getEpisode", () => {
    it("throws NotFound for an unknown id", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(null);

      await expect(service.getEpisode("nope")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("prefers the draft over the published snapshot and hands back the draft id as the optimistic-lock base", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        { episodeId: "ep1", id: "v2", version: 2, status: "published" },
      ]);
      prisma.adventureEpisodeVersion.findFirst
        .mockResolvedValueOnce({
          id: "v3",
          version: 3,
          status: "draft",
          payload: draftContent,
        })
        .mockResolvedValueOnce(null);

      const detail = await service.getEpisode("ep1");

      expect(detail.contentSource).toBe("draft");
      expect(detail.baseVersionId).toBe("v3");
      // 内容一律按白名单补全后返回：表单拿到的每一段字段齐全，不会有 undefined 空洞
      expect(detail.content.title).toBe("第三集");
      expect(detail.content.recap).toBe("上集回顾");
      expect(detail.content.segments).toHaveLength(2);
      expect(detail.content.segments[0]).toMatchObject({
        order: 0,
        kind: "narration",
        text: "开场",
        interactionType: null,
        rewardStar: false,
      });
      expect(detail.content.segments[1]).toMatchObject({
        order: 1,
        kind: "interaction",
        interactionType: "open_question",
        fallbackText: "没关系",
        exitText: "那我们先休息一下",
      });
      expect(detail.summary.businessKey).toBe("elly/1/3");
    });

    it("falls back to the published snapshot when there is no draft", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisodeVersion.findFirst.mockResolvedValue(null);
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue({
        id: "v2",
        version: 2,
        status: "published",
        payload: draftContent,
      });

      const detail = await service.getEpisode("ep1");

      expect(detail.contentSource).toBe("published");
      expect(detail.baseVersionId).toBe("v2");
      expect(detail.content.segments).toHaveLength(2);
    });

    it("returns an empty shell with the materialized title when the episode has no version at all", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue({
        ...ellyEpisode,
        published: false,
        currentVersionId: null,
      });
      prisma.adventureEpisodeVersion.findFirst.mockResolvedValue(null);

      const detail = await service.getEpisode("ep1");

      expect(detail.contentSource).toBe("empty");
      expect(detail.baseVersionId).toBeNull();
      expect(detail.content).toEqual({
        title: "第三集",
        recap: "上集回顾",
        segments: [],
      });
      expect(detail.lint.ok).toBe(false);
    });

    it("carries the lint report so the editor can show issues without another round trip", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisodeVersion.findFirst.mockResolvedValue({
        id: "v3",
        version: 3,
        status: "draft",
        payload: { title: "", recap: null, segments: [] },
      });

      const detail = await service.getEpisode("ep1");

      expect(detail.lint.ok).toBe(false);
      expect(detail.lint.errors.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["TITLE_REQUIRED", "NO_SEGMENTS"]),
      );
    });
  });

  describe("retireImpact", () => {
    beforeEach(() => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        { episodeId: "ep1", id: "v2", version: 2, status: "published" },
        { episodeId: "ep1", id: "v1", version: 1, status: "superseded" },
      ]);
    });

    it("separates the children playing today from the stale cross-day ones", async () => {
      prisma.adventureDailyRecord.count
        .mockResolvedValueOnce(4) // 今日在播
        .mockResolvedValueOnce(7); // 跨天陈旧
      prisma.adventureProgress.findMany.mockResolvedValue([
        { deviceId: "d1", episodeVersionId: "v1", status: "in_progress" },
        { deviceId: "d2", episodeVersionId: "v2", status: "in_progress" },
        { deviceId: "d3", episodeVersionId: null, status: "completed" },
      ]);
      prisma.adventureProgress.count.mockResolvedValue(12);

      const impact = await service.retireImpact("ep1");

      expect(impact).toEqual({
        devicesPlayingToday: 4,
        devicesStaleCrossDay: 7,
        devicesPinnedToOlderVersions: 1,
        totalDevicesEverStarted: 12,
        publishedVersionCount: 2,
      });
    });

    it("does not count a device pinned to an older version whose progress is already closed", async () => {
      prisma.adventureDailyRecord.count.mockResolvedValue(0);
      prisma.adventureProgress.findMany.mockResolvedValue([
        { deviceId: "d1", episodeVersionId: "v1", status: "completed" },
        { deviceId: "d4", episodeVersionId: "v1", status: "abandoned" },
      ]);
      prisma.adventureProgress.count.mockResolvedValue(2);

      const impact = await service.retireImpact("ep1");

      expect(impact.devicesPinnedToOlderVersions).toBe(0);
    });

    it("asks for the stale window using a lexicographically comparable date key", async () => {
      prisma.adventureDailyRecord.count.mockResolvedValue(0);

      await service.retireImpact("ep1");

      const staleCall = prisma.adventureDailyRecord.count.mock.calls[1][0];
      expect(staleCall.where.status).toBe("in_progress");
      expect(staleCall.where.episodeId).toBe("ep1");
      expect(staleCall.where.assignedDate.lt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe("listVersions", () => {
    it("orders newest first and includes the discarded tail so history stays complete", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        {
          id: "v3",
          version: 3,
          status: "draft",
          payload: draftContent,
          createdAt: new Date(3),
        },
        {
          id: "v2",
          version: 2,
          status: "published",
          payload: draftContent,
          createdAt: new Date(2),
        },
        {
          id: "v1",
          version: 1,
          status: "superseded",
          payload: draftContent,
          createdAt: new Date(1),
        },
      ]);

      const versions = await service.listVersions("ep1");

      expect(
        prisma.adventureEpisodeVersion.findMany.mock.calls[0][0].orderBy,
      ).toEqual({
        version: "desc",
      });
      expect(versions.map((item) => item.id)).toEqual(["v3", "v2", "v1"]);
      expect(versions[0].segmentCount).toBe(2);
      expect(versions[0].isCurrent).toBe(false);
    });

    it("marks the version the episode currently points at", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        {
          id: "v2",
          version: 2,
          status: "published",
          payload: draftContent,
          createdAt: new Date(2),
        },
      ]);

      const versions = await service.listVersions("ep1");

      expect(versions[0].isCurrent).toBe(true);
    });

    it("never returns the raw payload in the list, only its size and hash", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        {
          id: "v2",
          version: 2,
          status: "published",
          payload: draftContent,
          contentHash: "abc",
          createdAt: new Date(2),
        },
      ]);

      const versions = await service.listVersions("ep1");

      expect(versions[0]).not.toHaveProperty("payload");
      expect(versions[0].contentHash).toBe("abc");
    });
  });

  describe("getVersion", () => {
    it("rejects a version id that belongs to another episode", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue({
        id: "v2",
        episodeId: "other",
        version: 2,
        status: "published",
        payload: draftContent,
      });

      await expect(service.getVersion("ep1", "v2")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("parses the stored payload back into an editable draft", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue({
        id: "v2",
        episodeId: "ep1",
        version: 2,
        status: "published",
        payload: draftContent,
      });

      const result = await service.getVersion("ep1", "v2");

      expect(result.meta.id).toBe("v2");
      expect(result.content.segments).toHaveLength(2);
      expect(result.content.title).toBe("第三集");
    });
  });

  describe("diffVersions", () => {
    it("reports added, removed and changed segments between two snapshots", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisodeVersion.findUnique
        .mockResolvedValueOnce({
          id: "v1",
          episodeId: "ep1",
          version: 1,
          status: "superseded",
          payload: {
            title: "旧标题",
            recap: null,
            segments: [{ order: 0, kind: "narration", text: "旧开场" }],
          },
        })
        .mockResolvedValueOnce({
          id: "v2",
          episodeId: "ep1",
          version: 2,
          status: "published",
          payload: draftContent,
        });

      const diff = await service.diffVersions("ep1", "v1", "v2");

      expect(diff.titleChanged).toBe(true);
      expect(diff.added).toHaveLength(1);
      expect(
        diff.changed.length + diff.removed.length + diff.added.length,
      ).toBeGreaterThan(0);
      expect(diff.left.businessKey).toBe("elly/1/3");
      expect(diff.right.businessKey).toBe("elly/1/3");
    });
  });

  describe("checkContent", () => {
    it("treats the edited episode's own business key as free", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisode.findMany.mockResolvedValue([ellyEpisode]);

      const report = await service.checkContent("ep1", draftContent);

      expect(report.errors.map((issue) => issue.code)).not.toContain(
        "BUSINESS_KEY_TAKEN",
      );
    });

    it("flags a brand new identity that collides with an existing episode", async () => {
      prisma.adventureEpisode.findMany.mockResolvedValue([ellyEpisode]);

      const report = await service.checkContent(null, draftContent, {
        characterKey: "elly",
        season: 1,
        episodeNumber: 3,
      });

      expect(report.errors.map((issue) => issue.code)).toContain(
        "BUSINESS_KEY_TAKEN",
      );
    });

    it("applies the publish-standard ordering check only when asked", async () => {
      prisma.adventureEpisode.findMany.mockResolvedValue([]);

      const draftReport = await service.checkContent(null, draftContent, {
        characterKey: "elly",
        season: 1,
        episodeNumber: 5,
      });
      const publishReport = await service.checkContent(null, draftContent, {
        characterKey: "elly",
        season: 1,
        episodeNumber: 5,
        forPublish: true,
      });

      expect(draftReport.errors.map((issue) => issue.code)).not.toContain(
        "PREDECESSOR_NOT_PUBLISHED",
      );
      expect(publishReport.errors.map((issue) => issue.code)).toContain(
        "PREDECESSOR_NOT_PUBLISHED",
      );
    });
  });

  describe("simulate", () => {
    it("estimates the spoken session without touching the database", async () => {
      const result = service.simulate(
        { characterKey: "elly", season: 1, episodeNumber: 3 },
        draftContent,
      );

      expect(result.businessKey).toBe("elly/1/3");
      expect(result.beats.length).toBeGreaterThan(0);
      expect(result.estimatedSeconds).toBeGreaterThan(0);
      expect(prisma.adventureEpisode.findMany).not.toHaveBeenCalled();
    });
  });

  describe("lintThresholds", () => {
    it("lets the deployment override the character limits through env", () => {
      const tuned = new AdventureContentQueryService(
        prisma as never,
        {
          get: (key: string) => {
            if (key === "CONTENT_ADMIN_PROFILE") {
              return "authoring";
            }
            if (key === "ADVENTURE_LINT_MAX_NARRATION_CHARS") {
              return "200";
            }
            if (key === "ADVENTURE_LINT_FORBIDDEN_WORDS") {
              return "暴力, 恐怖";
            }
            return undefined;
          },
        } as never,
      );

      const caps = tuned.capabilities();
      expect(caps.lintThresholds.maxNarrationTextChars).toBe(200);
      expect(caps.lintThresholds.forbiddenWords).toEqual(["暴力", "恐怖"]);
      // 未覆盖的阈值保持默认，避免半套配置静默生效
      expect(caps.lintThresholds.maxTitleChars).toBe(
        DEFAULT_LINT_THRESHOLDS.maxTitleChars,
      );
    });
  });
});
