import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  AdventureContentQueryService,
  contentFromPayload,
} from "./adventure-content-query.service";
import {
  ADVENTURE_SEASON,
  EpisodeContentDraft,
} from "./adventure-content.types";
import { DEFAULT_LINT_THRESHOLDS } from "./adventure-linter";
import { DEFAULT_SIMULATION_THRESHOLDS } from "./adventure-simulator";
import { ADVENTURE_EXIT_TEXT } from "@/modules/adventure/adventure.constants";

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
    adventureEvent: { findMany: jest.Mock };
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
      adventureEvent: { findMany: jest.fn().mockResolvedValue([]) },
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
      // reward 不等回答，编辑器据此决定是否要求填 fallback
      expect(caps.replyWaitingInteractionTypes).toEqual([
        "open_question",
        "two_choice",
        "repeat_after_me",
      ]);
      // 退出话术全局唯一，由服务端下发给看板只读展示，前端不得内联这句话。
      // 字面值在这里断言一次：它是孩子真正会听到的内容，属于对外契约。
      expect(caps.fixedExitText).toBe(ADVENTURE_EXIT_TEXT);
      expect(caps.fixedExitText).toBe("好的，那么我们之后再一起继续冒险吧");
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

    it("translates a whitelisted characterKey, published and a numeric search into the where clause", async () => {
      await service.listEpisodes({
        characterKey: "elly",
        published: false,
        search: "3",
      });

      const where = prisma.adventureEpisode.findMany.mock.calls[0][0].where;
      expect(where.characterKey).toBe("elly");
      expect(where.published).toBe(false);
      // 纯数字 search 同时命中标题 contains 与集号精确匹配
      expect(where.OR).toEqual([
        { title: { contains: "3" } },
        { episodeNumber: 3 },
      ]);
    });

    it("ignores a characterKey outside the whitelist and a non-numeric search's episode-number arm", async () => {
      await service.listEpisodes({ characterKey: "momo", search: "森林" });

      const where = prisma.adventureEpisode.findMany.mock.calls[0][0].where;
      expect(where.characterKey).toBeUndefined();
      expect(where.OR).toEqual([{ title: { contains: "森林" } }]);
    });

    it("omits the filter argument entirely and still paginates by default", async () => {
      await service.listEpisodes();

      const args = prisma.adventureEpisode.findMany.mock.calls[0][0];
      expect(args.skip).toBe(0);
      expect(args.take).toBe(50);
    });

    it("clamps page and pageSize the same way the audit list does", async () => {
      await service.listEpisodes({ page: 1.5, pageSize: 201 });
      let args = prisma.adventureEpisode.findMany.mock.calls[0][0];
      expect(args.skip).toBe(0);
      expect(args.take).toBe(200);

      await service.listEpisodes({ page: 0, pageSize: 0.5 });
      args = prisma.adventureEpisode.findMany.mock.calls[1][0];
      expect(args.skip).toBe(0);
      expect(args.take).toBe(50);

      await service.listEpisodes({ page: Infinity, pageSize: 200 });
      args = prisma.adventureEpisode.findMany.mock.calls[2][0];
      expect(args.skip).toBe(0);
      expect(args.take).toBe(200);
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
          updatedAt: new Date("2026-11-11T08:00:00.000Z"),
        })
        .mockResolvedValueOnce(null);

      const detail = await service.getEpisode("ep1");

      expect(detail.contentSource).toBe("draft");
      expect(detail.baseVersionId).toBe("v3");
      // 草稿是可变行，光有 id 挡不住「同一行被别人改过」，所以再发一个 updatedAt 令牌
      expect(detail.baseDraftUpdatedAt).toBe("2026-11-11T08:00:00.000Z");
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
      expect(detail.baseDraftUpdatedAt).toBeNull();
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
      expect(detail.baseDraftUpdatedAt).toBeNull();
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

    it("parses a payload with missing segments and title into empty defaults", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue({
        id: "v2",
        episodeId: "ep1",
        version: 2,
        status: "published",
        payload: null,
      });

      const result = await service.getVersion("ep1", "v2");

      expect(result.meta.title).toBe("");
      expect(result.meta.segmentCount).toBe(0);
      expect(result.content.segments).toEqual([]);
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

    /**
     * 对比页必须看得见「还没写字」的那一段。若这里走严格规范化，空段会被整个抹掉，
     * 作者看到的是「两边一样」——比不显示更糟，因为他会以为草稿根本没改动。
     */
    it("shows an empty-text draft segment in the diff instead of hiding it", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisodeVersion.findUnique
        .mockResolvedValueOnce({
          id: "v1",
          episodeId: "ep1",
          version: 1,
          status: "published",
          payload: {
            title: "第三集",
            recap: null,
            segments: [{ order: 0, kind: "narration", text: "开场" }],
          },
        })
        .mockResolvedValueOnce({
          id: "v2",
          episodeId: "ep1",
          version: 2,
          status: "draft",
          payload: {
            title: "第三集",
            recap: null,
            segments: [
              { order: 0, kind: "narration", text: "开场" },
              { order: 1, kind: "narration", text: "" },
            ],
          },
        });

      const diff = await service.diffVersions("ep1", "v1", "v2");

      expect(diff.right.episode.segments).toHaveLength(2);
      expect(diff.right.episode.segments[1].text).toBe("");
      expect(diff.added).toHaveLength(1);
    });
  });

  describe("contentFromPayload", () => {
    const identity = {
      characterKey: "elly" as const,
      season: 1,
      episodeNumber: 3,
    };

    it("keeps an empty-text segment so a work-in-progress draft survives a reload", () => {
      const content = contentFromPayload(identity, {
        title: "第三集",
        recap: null,
        segments: [
          { order: 0, kind: "narration", text: "开场" },
          { order: 1, kind: "narration", text: "" },
        ],
      });

      expect(content.segments).toHaveLength(2);
      expect(content.segments[1]).toMatchObject({ order: 1, text: "" });
    });

    it("is the identity transform for payloads written under the strict bundle shape", () => {
      const legacy = {
        title: "第三集",
        recap: "上集回顾",
        segments: [
          {
            order: 0,
            kind: "narration",
            text: "开场",
            interactionType: null,
            options: null,
            fallbackText: null,
            rewardStar: false,
          },
        ],
      };

      expect(contentFromPayload(identity, legacy)).toEqual(legacy);
    });

    it("still drops structurally malformed segments", () => {
      const content = contentFromPayload(identity, {
        title: "第三集",
        segments: [
          { order: 0, kind: "narration", text: "开场" },
          { order: 1, kind: "banana", text: "类型非法" },
        ],
      });

      expect(content.segments).toHaveLength(1);
    });

    it("survives a null payload: 空标题、空段，而不是崩", () => {
      const parsed = contentFromPayload(identity, null);

      expect(parsed.title).toBe("");
      expect(parsed.segments).toEqual([]);
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

    it("applies publish standard via 4th param when episodeId resolves identity", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisode.findMany.mockResolvedValue([]);

      const report = await service.checkContent(
        "ep1",
        draftContent,
        undefined,
        true,
      );

      expect(report.errors.map((issue) => issue.code)).toContain(
        "PREDECESSOR_NOT_PUBLISHED",
      );
    });

    it("applies draft standard via 4th param undefined when episodeId resolves identity", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(ellyEpisode);
      prisma.adventureEpisode.findMany.mockResolvedValue([]);

      const report = await service.checkContent(
        "ep1",
        draftContent,
        undefined,
        undefined,
      );

      expect(report.errors.map((issue) => issue.code)).not.toContain(
        "PREDECESSOR_NOT_PUBLISHED",
      );
    });

    it("runs lintContextFor (hitting findMany) when forPublish is true and no identity at all", async () => {
      prisma.adventureEpisode.findMany.mockResolvedValue([]);

      await service.checkContent(null, draftContent, undefined, true);

      expect(prisma.adventureEpisode.findMany).toHaveBeenCalled();
    });

    it("skips lintContextFor (and findMany) when forPublish is undefined and no identity at all", async () => {
      await service.checkContent(null, draftContent, undefined, undefined);

      expect(prisma.adventureEpisode.findMany).not.toHaveBeenCalled();
    });

    it("still reads forPublish from identity when the 4th param is omitted (backward compat)", async () => {
      prisma.adventureEpisode.findMany.mockResolvedValue([]);

      const report = await service.checkContent(null, draftContent, {
        characterKey: "elly",
        season: 1,
        episodeNumber: 5,
        forPublish: true,
      });

      expect(report.errors.map((issue) => issue.code)).toContain(
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

    it("falls back to defaults when the env list produces no words", () => {
      const tuned = new AdventureContentQueryService(
        prisma as never,
        {
          get: (key: string) => {
            if (key === "CONTENT_ADMIN_PROFILE") {
              return "authoring";
            }
            if (key === "ADVENTURE_LINT_FORBIDDEN_WORDS") {
              return "，,  ";
            }
            return undefined;
          },
        } as never,
      );

      expect(tuned.capabilities().lintThresholds.forbiddenWords).toEqual(
        DEFAULT_LINT_THRESHOLDS.forbiddenWords,
      );
    });
  });

  describe("choiceStats", () => {
    const episode = {
      id: "ep1",
      characterKey: "elly",
      title: "第三集",
      currentVersionId: "v1",
    };

    const versionPayload = {
      title: "第三集",
      recap: "回顾",
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
        {
          order: 2,
          kind: "interaction",
          text: "再选一个",
          interactionType: "two_choice",
          options: {
            choices: [{ key: "c", text: "大的", reply: "大" }],
          },
        },
      ],
    };

    const versionRow = {
      id: "v1",
      episodeId: "ep1",
      payload: versionPayload,
    };

    beforeEach(() => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(episode);
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(versionRow);
    });

    // ---- Contract shape ----

    it("零数据 / 无事件 → segments 仅 two_choice 段且全零填充", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([]);

      const result = await service.choiceStats("ep1", {});

      expect(result.episodeId).toBe("ep1");
      expect(result.title).toBe("第三集");
      expect(result.contentNote).toBe("adventure-choice-stats");
      expect(result.totalInteractions).toBe(0);
      expect(result.matchedTotal).toBe(0);
      // 只有 two_choice 段（narration excluded）
      expect(result.segments).toHaveLength(2);
      expect(result.segments[0]).toMatchObject({
        segmentOrder: 1,
        promptText: "选一个",
        matchedTotal: 0,
        fallbackTotal: 0,
        fallbackRate: null,
        neverChosen: true,
        choices: [
          {
            index: 0,
            key: "a",
            text: "红色",
            hits: 0,
            deterministicHits: 0,
            llmHits: 0,
            share: null,
          },
          {
            index: 1,
            key: "b",
            text: "蓝色",
            hits: 0,
            deterministicHits: 0,
            llmHits: 0,
            share: null,
          },
        ],
      });
      expect(result.segments[1]).toMatchObject({
        segmentOrder: 2,
        promptText: "再选一个",
        matchedTotal: 0,
        fallbackTotal: 0,
        fallbackRate: null,
        neverChosen: true,
      });
    });

    it("无发布版本（currentVersionId null）→ segments: [] 但 totals 反映真实事件", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue({
        id: "ep1",
        title: "第三集",
        currentVersionId: null,
      });
      prisma.adventureEvent.findMany.mockResolvedValue([
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 0, source: "deterministic", key: "a" },
        },
        {
          eventType: "answered",
          segmentOrder: 1,
          payload: { interactionType: "two_choice" },
        },
      ]);

      const result = await service.choiceStats("ep1", {});

      expect(result.segments).toEqual([]);
      // 即使没有版本 payload，事件 stats 仍然存在
      expect(result.matchedTotal).toBe(1);
      expect(result.totalInteractions).toBe(1);
    });

    it("episodeId 不存在 → NotFoundException", async () => {
      prisma.adventureEpisode.findUnique.mockResolvedValue(null);

      await expect(service.choiceStats("nope", {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("段级 neverChosen：段 matchedTotal=0 → true，否则 false", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 0, source: "deterministic", key: "a" },
        },
      ]);

      const result = await service.choiceStats("ep1", {});

      // 段 1 有命中 → neverChosen=false
      expect(result.segments[0].neverChosen).toBe(false);
      expect(result.segments[0].matchedTotal).toBe(1);
      // 段 2 无命中 → neverChosen=true
      expect(result.segments[1].neverChosen).toBe(true);
      expect(result.segments[1].matchedTotal).toBe(0);
    });

    it("fallbackRate = fallbackTotal / (matchedTotal + fallbackTotal)，4 位小数", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 0, source: "deterministic", key: "a" },
        },
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 0, source: "llm", key: "a" },
        },
        {
          eventType: "fallback",
          segmentOrder: 1,
          payload: { interactionType: "two_choice" },
        },
        {
          eventType: "fallback",
          segmentOrder: 1,
          payload: { interactionType: "two_choice" },
        },
      ]);

      const result = await service.choiceStats("ep1", {});

      // matchedTotal=2, fallbackTotal=2 → fallbackRate=2/4=0.5
      expect(result.segments[0].matchedTotal).toBe(2);
      expect(result.segments[0].fallbackTotal).toBe(2);
      expect(result.segments[0].fallbackRate).toBe(0.5);
    });

    it("fallbackRate 分母 0 → null", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([]);

      const result = await service.choiceStats("ep1", {});

      expect(result.segments[0].fallbackRate).toBeNull();
    });

    it("timeout 不计入 fallbackRate 分母", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 0, source: "deterministic", key: "a" },
        },
        {
          eventType: "timeout",
          segmentOrder: 1,
          payload: { interactionType: "two_choice" },
        },
        {
          eventType: "fallback",
          segmentOrder: 1,
          payload: { interactionType: "two_choice" },
        },
      ]);

      const result = await service.choiceStats("ep1", {});

      // matchedTotal=1, fallbackTotal=1 → fallbackRate=1/2=0.5（timeout 不在分母）
      // timeout 计入 totalInteractions 但不计入 fallbackRate 分母
      expect(result.segments[0].fallbackRate).toBe(0.5);
      expect(result.totalInteractions).toBe(2); // fallback=1 + timeout=1
    });

    it("narration 段不在 segments 中", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([]);

      const result = await service.choiceStats("ep1", {});

      // versionPayload 有 3 个 segments（narration + 2 two_choice），
      // 但 segments 只有 2 个 two_choice 段
      expect(result.segments).toHaveLength(2);
      expect(result.segments[0].segmentOrder).toBe(1);
      expect(result.segments[1].segmentOrder).toBe(2);
    });

    it("choices 含 deterministicHits / llmHits / share（share 分母 = 段 matchedTotal）", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 0, source: "deterministic", key: "a" },
        },
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 0, source: "deterministic", key: "a" },
        },
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 0, source: "llm", key: "a" },
        },
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 1, source: "llm", key: "b" },
        },
      ]);

      const result = await service.choiceStats("ep1", {});

      const seg = result.segments[0];
      // 段 matchedTotal = 4
      expect(seg.matchedTotal).toBe(4);
      // choice "a": hits=3 (2 det + 1 llm), share = 3/4 = 0.75
      expect(seg.choices[0]).toMatchObject({
        index: 0,
        key: "a",
        hits: 3,
        deterministicHits: 2,
        llmHits: 1,
        share: 0.75,
      });
      // choice "b": hits=1 (0 det + 1 llm), share = 1/4 = 0.25
      expect(seg.choices[1]).toMatchObject({
        index: 1,
        key: "b",
        hits: 1,
        deterministicHits: 0,
        llmHits: 1,
        share: 0.25,
      });
    });

    it("share 为 4 位小数，段 matchedTotal=0 → null", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([]);

      const result = await service.choiceStats("ep1", {});

      expect(result.segments[0].choices[0].share).toBeNull();
    });

    it("null segmentOrder → segments 最后一个元素，promptText: null", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([
        {
          eventType: "choice_matched",
          segmentOrder: null,
          payload: { index: 0, source: "deterministic", key: "x" },
        },
        {
          eventType: "choice_matched",
          segmentOrder: null,
          payload: { index: 0, source: "llm", key: "x" },
        },
        {
          eventType: "fallback",
          segmentOrder: null,
          payload: { interactionType: "two_choice" },
        },
      ]);

      const result = await service.choiceStats("ep1", {});

      // null 段在 segments 末尾
      const nullSeg = result.segments[result.segments.length - 1];
      expect(nullSeg.segmentOrder).toBeNull();
      expect(nullSeg.promptText).toBeNull();
      expect(nullSeg.matchedTotal).toBe(2);
      expect(nullSeg.fallbackTotal).toBe(1);
      expect(nullSeg.fallbackRate).toBe(0.3333);
      expect(nullSeg.choices).toHaveLength(1);
      expect(nullSeg.choices[0]).toMatchObject({ index: 0, key: "x", hits: 2 });
    });

    it("孤儿选项（事件有、payload 无的 index）追加到该段 choices 末尾", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 0, source: "deterministic", key: "a" },
        },
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 2, source: "llm", key: "extra" },
        },
      ]);

      const result = await service.choiceStats("ep1", {});

      const seg = result.segments[0];
      // payload 有 2 个 choices (a, b)，孤儿 extra 追加到末尾
      expect(seg.choices).toHaveLength(3);
      expect(seg.choices[0]).toMatchObject({ index: 0, key: "a", hits: 1 });
      expect(seg.choices[1]).toMatchObject({ index: 1, key: "b", hits: 0 });
      expect(seg.choices[2]).toMatchObject({
        index: 2,
        key: "extra",
        hits: 1,
        text: null,
      });
    });

    it("跨段隔离：各段独立聚合", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 0, source: "deterministic", key: "a" },
        },
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 0, source: "deterministic", key: "a" },
        },
        {
          eventType: "choice_matched",
          segmentOrder: 2,
          payload: { index: 0, source: "llm", key: "c" },
        },
        {
          eventType: "fallback",
          segmentOrder: 1,
          payload: { interactionType: "two_choice" },
        },
        {
          eventType: "fallback",
          segmentOrder: 2,
          payload: { interactionType: "two_choice" },
        },
      ]);

      const result = await service.choiceStats("ep1", {});

      // 段 1
      expect(result.segments[0].matchedTotal).toBe(2);
      expect(result.segments[0].fallbackTotal).toBe(1);
      // 段 2
      expect(result.segments[1].matchedTotal).toBe(1);
      expect(result.segments[1].fallbackTotal).toBe(1);
      // top-level 汇总
      expect(result.matchedTotal).toBe(3);
      expect(result.totalInteractions).toBe(2); // fallback only (no answered/timeout)
    });

    it("日期区间过滤（reportDayRange gte/lt 语义）", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([]);

      await service.choiceStats("ep1", {
        startDate: "2026-11-01",
        endDate: "2026-11-02",
      });

      // 验证传给 findMany 的 where.createdAt
      const callArgs = prisma.adventureEvent.findMany.mock.calls[0][0];
      expect(callArgs.where.createdAt).toBeDefined();
      expect(callArgs.where.createdAt.gte).toBeInstanceOf(Date);
      expect(callArgs.where.createdAt.lt).toBeInstanceOf(Date);
    });

    it("PII 红线：响应不含 asrText / messageId / deviceId", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 0, source: "deterministic", key: "a" },
        },
      ]);

      const result = await service.choiceStats("ep1", {});
      const json = JSON.stringify(result);

      expect(json).not.toContain("asrText");
      expect(json).not.toContain("messageId");
      expect(json).not.toContain("deviceId");
    });

    it("拒绝形状不对或倒挂的日期区间", async () => {
      await expect(
        service.choiceStats("ep1", {
          startDate: "2026-1-1",
          endDate: "2026-01-02",
        }),
      ).rejects.toThrow("Invalid date");
      await expect(
        service.choiceStats("ep1", {
          startDate: "2026-13-01",
          endDate: "2026-01-01",
        }),
      ).rejects.toThrow("Invalid date");
      await expect(
        service.choiceStats("ep1", {
          startDate: "2026-02-01",
          endDate: "2026-01-01",
        }),
      ).rejects.toThrow("startDate must be <= endDate");
      expect(prisma.adventureEvent.findMany).not.toHaveBeenCalled();
    });

    it("事件 payload 缺失或类型不对 → 兜底计数，不崩", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([
        { eventType: "choice_matched", segmentOrder: 1, payload: null },
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: "x", key: 1, source: 2 },
        },
        {
          eventType: "choice_matched",
          segmentOrder: 1,
          payload: { index: 2 },
        },
        { eventType: "choice_matched", segmentOrder: 1 },
      ]);

      const result = await service.choiceStats("ep1", {});

      const seg = result.segments[0];
      expect(seg.matchedTotal).toBe(4);
      // 版本选项在前，事件里兜底 key 的孤儿选项追加在后
      expect(seg.choices).toHaveLength(4);
      expect(seg.choices[2]).toMatchObject({ index: 0, key: "", hits: 3 });
      expect(seg.choices[3]).toMatchObject({ index: 2, key: "", hits: 1 });
    });

    it("fallback / answered / timeout 的 interactionType 不是 two_choice → 不计入", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([
        {
          eventType: "fallback",
          segmentOrder: 1,
          payload: { interactionType: "open_question" },
        },
        { eventType: "fallback", segmentOrder: 1, payload: null },
        {
          eventType: "answered",
          segmentOrder: 1,
          payload: { interactionType: 1 },
        },
        { eventType: "timeout", segmentOrder: 1, payload: null },
      ]);

      const result = await service.choiceStats("ep1", {});

      expect(result.totalInteractions).toBe(0);
    });

    it("版本 payload 缺失、segments 不是数组、段/选项缺字段 → 空值兜底", async () => {
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(null);
      await expect(service.choiceStats("ep1", {})).resolves.toMatchObject({
        segments: [],
      });

      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue({
        id: "v1",
        episodeId: "ep1",
        payload: {
          segments: [
            {
              order: 1,
              kind: "interaction",
              interactionType: "two_choice",
            },
            {
              order: 2,
              kind: "interaction",
              interactionType: "two_choice",
              options: "不是对象",
            },
            {
              order: 3,
              kind: "interaction",
              interactionType: "two_choice",
              options: { choices: [{}, { key: "c" }] },
            },
          ],
        },
      });

      const result = await service.choiceStats("ep1", {});

      expect(result.segments[0]).toMatchObject({
        segmentOrder: 1,
        promptText: null,
      });
      expect(result.segments[1].choices).toEqual([]);
      expect(result.segments[2].choices).toEqual([
        expect.objectContaining({ index: 0, key: null, text: null }),
        expect.objectContaining({ index: 1, key: "c", text: null }),
      ]);
    });

    it("null 段只有 fallback → 仍出现在末尾，share 全 null", async () => {
      prisma.adventureEvent.findMany.mockResolvedValue([
        {
          eventType: "fallback",
          segmentOrder: null,
          payload: { interactionType: "two_choice" },
        },
      ]);

      const result = await service.choiceStats("ep1", {});

      const nullSeg = result.segments[result.segments.length - 1];
      expect(nullSeg.segmentOrder).toBeNull();
      expect(nullSeg.matchedTotal).toBe(0);
      expect(nullSeg.fallbackTotal).toBe(1);
      expect(nullSeg.choices).toEqual([]);
      expect(nullSeg.neverChosen).toBe(true);
    });
  });
});
