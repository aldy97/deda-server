import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AdventureContentService } from "./adventure-content.service";
import { AdventureAuditService } from "./adventure-audit.service";
import {
  AdventureContentQueryService,
  EpisodeImpact,
} from "./adventure-content-query.service";
import {
  EpisodeContentDraft,
  EpisodeIdentity,
} from "./adventure-content.types";
import { LintIssue } from "./adventure-linter";

/**
 * 写侧的验收标准只有两条：
 * 1）破坏性动作必须先过「手输业务键 + 理由 + 影响面」这道闸；
 * 2）内容变更与审计必须同事务——审计写不进去，内容就不许改。
 * 所以这里断言的是事务内的调用序列，而不是返回值好不好看。
 */
describe("AdventureContentService", () => {
  let service: AdventureContentService;
  let prisma: {
    $transaction: jest.Mock;
    adventureEpisode: {
      create: jest.Mock;
      update: jest.Mock;
      findUnique: jest.Mock;
    };
    adventureEpisodeVersion: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    adventureSegment: {
      findMany: jest.Mock;
      deleteMany: jest.Mock;
      createMany: jest.Mock;
    };
    adventureDailyRecord: { findMany: jest.Mock; updateMany: jest.Mock };
    adventureProgress: { updateMany: jest.Mock; count: jest.Mock };
  };
  let tx: typeof prisma;
  let audit: { record: jest.Mock; list: jest.Mock };
  let query: {
    loadEpisode: jest.Mock;
    checkContent: jest.Mock;
    retireImpact: jest.Mock;
    dateKey: jest.Mock;
  };

  const identity: EpisodeIdentity = {
    characterKey: "elly",
    season: 1,
    episodeNumber: 3,
  };
  const actor = {
    username: "alice",
    displayName: "Alice",
    profile: "authoring",
  };
  const TODAY = "2026-11-13";

  const episodeRow = {
    id: "ep1",
    characterKey: "elly",
    season: 1,
    episodeNumber: 3,
    title: "第三集",
    recap: "上集回顾",
    published: true,
    retiredAt: null,
    currentVersionId: "v2",
    createdAt: new Date("2026-11-01"),
    updatedAt: new Date("2026-11-10"),
  };

  const content: EpisodeContentDraft = {
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
        exitText: "先休息一下",
      },
    ],
  };

  const impact: EpisodeImpact = {
    devicesPlayingToday: 3,
    devicesStaleCrossDay: 5,
    devicesPinnedToOlderVersions: 1,
    totalDevicesEverStarted: 20,
    publishedVersionCount: 2,
  };

  const okReport = { ok: true, issues: [], errors: [], warnings: [] };

  function errorReport(...codes: string[]) {
    const errors: LintIssue[] = codes.map((code) => ({
      severity: "error" as const,
      code,
      message: `${code} 中文说明`,
      businessKey: "elly/1/3",
    }));
    return { ok: false, issues: errors, errors, warnings: [] };
  }

  function versionRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "v2",
      episodeId: "ep1",
      version: 2,
      status: "published",
      payload: { title: "第三集", recap: "上集回顾", segments: [] },
      contentHash: "hash-v2",
      changeNote: null,
      createdBy: "bob",
      createdByName: "Bob",
      publishedAt: new Date("2026-11-05"),
      publishedBy: "bob",
      supersededById: null,
      createdAt: new Date("2026-11-05"),
      updatedAt: new Date("2026-11-05"),
      ...overrides,
    };
  }

  beforeEach(async () => {
    tx = {
      $transaction: jest.fn(),
      adventureEpisode: {
        create: jest
          .fn()
          .mockResolvedValue({ ...episodeRow, id: "ep-new", published: false }),
        update: jest.fn(),
        findUnique: jest.fn(),
      },
      adventureEpisodeVersion: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation((args) =>
            Promise.resolve({ id: "v-new", ...args.data }),
          ),
        update: jest
          .fn()
          .mockImplementation((args) =>
            Promise.resolve({ id: args.where.id, ...args.data }),
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      adventureSegment: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      adventureDailyRecord: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      adventureProgress: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    prisma = {
      ...tx,
      $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) =>
        fn(tx),
      ),
      adventureEpisodeVersion: {
        ...tx.adventureEpisodeVersion,
        findMany: jest.fn().mockResolvedValue([]),
      },
      adventureSegment: {
        ...tx.adventureSegment,
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    prisma.adventureEpisode = {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(episodeRow),
    };
    prisma.adventureProgress = {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    };

    audit = { record: jest.fn().mockResolvedValue(undefined), list: jest.fn() };
    query = {
      loadEpisode: jest.fn().mockResolvedValue(episodeRow),
      checkContent: jest.fn().mockResolvedValue(okReport),
      retireImpact: jest.fn().mockResolvedValue(impact),
      dateKey: jest.fn().mockReturnValue(TODAY),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdventureContentService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdventureAuditService, useValue: audit },
        { provide: AdventureContentQueryService, useValue: query },
      ],
    }).compile();

    service = module.get(AdventureContentService);
  });

  function auditActions(): string[] {
    return audit.record.mock.calls.map((call) => call[1].action);
  }

  describe("createEpisode", () => {
    it("creates the episode row, a first draft version and the audit entry in one transaction", async () => {
      tx.adventureEpisode.create = jest
        .fn()
        .mockResolvedValue({ ...episodeRow, id: "ep-new", published: false });
      prisma.adventureEpisode.create = tx.adventureEpisode.create;
      prisma.$transaction = jest.fn(async (fn) => fn(tx));

      const result = await service.createEpisode(identity, content, actor, {
        reason: "新增第三集的初稿",
      });

      expect(tx.adventureEpisode.create).toHaveBeenCalledTimes(1);
      expect(tx.adventureEpisodeVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            episodeId: "ep-new",
            version: 1,
            status: "draft",
            createdBy: "alice",
            createdByName: "Alice",
          }),
        }),
      );
      expect(auditActions()).toEqual(["create"]);
      // 审计必须与内容变更同事务，否则回滚后会留下一条假记录
      expect(audit.record.mock.calls[0][2]).toBe(tx);
      expect(result).toMatchObject({
        episodeId: "ep-new",
        version: 1,
        businessKey: "elly/1/3",
      });
      expect(result.lint.ok).toBe(true);
    });

    it("never writes anything when the identity itself is invalid", async () => {
      query.checkContent.mockResolvedValue(errorReport("SEASON_UNSUPPORTED"));

      await expect(
        service.createEpisode(
          { characterKey: "elly", season: 2, episodeNumber: 3 },
          content,
          actor,
          { reason: "跨季的故事本期不支持" },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("refuses to persist a draft containing a forbidden word", async () => {
      query.checkContent.mockResolvedValue(errorReport("FORBIDDEN_WORD"));

      await expect(
        service.createEpisode(identity, content, actor, {
          reason: "新建一集的初稿内容",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("lets purely structural problems live on as a draft and returns the report for the editor", async () => {
      const report = errorReport("NO_SEGMENTS", "TITLE_REQUIRED");
      query.checkContent.mockResolvedValue(report);
      tx.adventureEpisode.create = jest
        .fn()
        .mockResolvedValue({ ...episodeRow, id: "ep-new" });
      prisma.adventureEpisode.create = tx.adventureEpisode.create;

      const result = await service.createEpisode(identity, content, actor, {
        reason: "结构没填完也允许先存草稿",
      });

      expect(tx.adventureEpisode.create).toHaveBeenCalledTimes(1);
      expect(result.lint).toBe(report);
      expect(result.lint.ok).toBe(false);
    });

    it("maps a business-key race to a 409 instead of leaking a Prisma error", async () => {
      tx.adventureEpisode.create = jest.fn().mockRejectedValue({
        code: "P2002",
        meta: { target: ["characterKey", "season", "episodeNumber"] },
      });
      prisma.adventureEpisode.create = tx.adventureEpisode.create;

      await expect(
        service.createEpisode(identity, content, actor, {
          reason: "新建一集的初稿内容",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("saveDraft", () => {
    it("creates a new draft numbered after the highest existing version", async () => {
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v2", version: 2, status: "published" }),
        versionRow({ id: "v1", version: 1, status: "superseded" }),
      ]);
      tx.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v2", version: 2, status: "published" }),
        versionRow({ id: "v1", version: 1, status: "superseded" }),
      ]);

      const result = await service.saveDraft("ep1", content, actor, {
        reason: "把第二段的引导词改短",
      });

      expect(tx.adventureEpisodeVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            episodeId: "ep1",
            version: 3,
            status: "draft",
          }),
        }),
      );
      expect(auditActions()).toEqual(["create_draft"]);
      expect(result).toMatchObject({ version: 3, created: true });
    });

    it("mutates the existing draft in place so history is not flooded by every keystroke", async () => {
      const draft = versionRow({ id: "v3", version: 3, status: "draft" });
      tx.adventureEpisodeVersion.findMany.mockResolvedValue([
        draft,
        versionRow({ id: "v2", version: 2, status: "published" }),
      ]);

      const result = await service.saveDraft("ep1", content, actor, {
        baseVersionId: "v3",
        reason: "把这里的错别字改掉",
      });

      expect(tx.adventureEpisodeVersion.create).not.toHaveBeenCalled();
      expect(tx.adventureEpisodeVersion.update).toHaveBeenCalledWith({
        where: { id: "v3" },
        data: expect.objectContaining({
          status: "draft",
          createdBy: "alice",
          createdByName: "Alice",
        }),
      });
      expect(auditActions()).toEqual(["update_draft"]);
      expect(result).toMatchObject({
        versionId: "v3",
        version: 3,
        created: false,
      });
    });

    it("returns 409 with the competing draft when the optimistic-lock base is stale", async () => {
      tx.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({
          id: "v4",
          version: 4,
          status: "draft",
          createdByName: "Carol",
          updatedAt: new Date("2026-11-12"),
        }),
      ]);

      const error = await service
        .saveDraft("ep1", content, actor, {
          baseVersionId: "v3",
          reason: "我以为还是我在改",
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      const body = error.getResponse();
      expect(body.code).toBe("DRAFT_CONFLICT");
      expect(body.currentDraft).toMatchObject({ id: "v4", version: 4 });
      expect(tx.adventureEpisodeVersion.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("overwrites without a base when the caller explicitly says so", async () => {
      tx.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v4", version: 4, status: "draft" }),
      ]);

      const result = await service.saveDraft("ep1", content, actor, {
        reason: "确认覆盖 Carol 的草稿",
        force: true,
      });

      expect(tx.adventureEpisodeVersion.update).toHaveBeenCalledTimes(1);
      expect(result.versionId).toBe("v4");
    });

    it("requires a reason long enough to explain itself half a year later", async () => {
      await expect(
        service.saveDraft("ep1", content, actor, { reason: "改一下" }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("blocks identity-level lint errors but still saves content-level ones", async () => {
      query.checkContent.mockResolvedValue(errorReport("BUSINESS_KEY_TAKEN"));
      await expect(
        service.saveDraft("ep1", content, actor, {
          reason: "换一个集号试试看",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      query.checkContent.mockResolvedValue(errorReport("CHOICES_REQUIRED"));
      await expect(
        service.saveDraft("ep1", content, actor, {
          reason: "二选一的选项还没填完",
        }),
      ).resolves.toBeDefined();
    });

    it("reports NotFound for an unknown episode", async () => {
      query.loadEpisode.mockRejectedValue(
        new NotFoundException("故事集不存在"),
      );

      await expect(
        service.saveDraft("nope", content, actor, {
          reason: "随便写一点什么理由",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("publish", () => {
    const draft = versionRow({
      id: "v3",
      version: 3,
      status: "draft",
      payload: { title: "新标题", recap: "新回顾", segments: content.segments },
    });

    beforeEach(() => {
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        draft,
        versionRow({ id: "v2", version: 2, status: "published" }),
      ]);
      tx.adventureEpisodeVersion.findMany.mockResolvedValue([
        draft,
        versionRow({ id: "v2", version: 2, status: "published" }),
      ]);
      prisma.adventureSegment.findMany.mockImplementation(async () => [
        { order: 0, kind: "narration", text: "开场" },
        {
          order: 1,
          kind: "interaction",
          text: "你看到了什么？",
          interactionType: "open_question",
          fallbackText: "没关系",
          exitText: "先休息一下",
        },
      ]);
    });

    it("promotes the draft, supersedes the previous version and rebuilds segments atomically", async () => {
      const result = await service.publish("ep1", actor, {
        reason: "修正第二段的引导词",
      });

      expect(tx.adventureEpisodeVersion.update).toHaveBeenCalledWith({
        where: { id: "v2" },
        data: { status: "superseded", supersededById: "v3" },
      });
      expect(tx.adventureEpisodeVersion.update).toHaveBeenCalledWith({
        where: { id: "v3" },
        data: expect.objectContaining({
          status: "published",
          publishedBy: "alice",
        }),
      });
      expect(tx.adventureEpisode.update).toHaveBeenCalledWith({
        where: { id: "ep1" },
        data: expect.objectContaining({
          published: true,
          currentVersionId: "v3",
          title: "新标题",
          recap: "新回顾",
        }),
      });
      expect(tx.adventureSegment.deleteMany).toHaveBeenCalledWith({
        where: { episodeId: "ep1" },
      });
      const created = tx.adventureSegment.createMany.mock.calls[0][0].data;
      expect(created).toHaveLength(2);
      expect(created[1]).toMatchObject({
        order: 1,
        kind: "interaction",
        interactionType: "open_question",
      });
      expect(auditActions()).toEqual(["publish"]);
      expect(audit.record.mock.calls[0][2]).toBe(tx);
      expect(result).toMatchObject({
        versionId: "v3",
        businessKey: "elly/1/3",
      });
    });

    it("does not ask for a typed confirmation because publishing never rewrites what a child is playing", async () => {
      const result = await service.publish("ep1", actor, {
        reason: "正常发布不需要手输业务键",
      });

      expect(result.versionId).toBe("v3");
    });

    it("refuses to publish when there is no draft", async () => {
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v2", version: 2, status: "published" }),
      ]);

      await expect(
        service.publish("ep1", actor, { reason: "我改好了，发布吧" }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("blocks a publish that fails the publish-standard lint even though the draft saved fine", async () => {
      query.checkContent.mockResolvedValue(errorReport("SEGMENT_ORDER_GAP"));

      await expect(
        service.publish("ep1", actor, { reason: "段号断了一格必须拦住" }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.adventureSegment.deleteMany).not.toHaveBeenCalled();
    });

    it("refuses to publish a retired episode instead of silently un-retiring it", async () => {
      query.loadEpisode.mockResolvedValue({
        ...episodeRow,
        retiredAt: new Date("2026-11-01"),
      });

      await expect(
        service.publish("ep1", actor, { reason: "已下架的集不该被悄悄上架" }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("requires a reason", async () => {
      await expect(service.publish("ep1", actor, {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("re-reads the segments after commit and records a self-check failure without rolling back", async () => {
      prisma.adventureSegment.findMany.mockResolvedValue([
        { order: 0, kind: "narration", text: "完全不对的文本" },
      ]);

      const result = await service.publish("ep1", actor, {
        reason: "发布后自检应发现漂移",
      });

      expect(auditActions()).toContain("self_check_failed");
      expect(result.selfCheckDrift).not.toEqual([]);
      // 已经提交的内容不许被自检回滚：回滚会造成孩子端看到的和库里不一致
      expect(tx.adventureSegment.deleteMany).toHaveBeenCalledTimes(1);
    });

    it("swallows a self-check crash so publishing still reports success", async () => {
      prisma.adventureSegment.findMany.mockRejectedValue(
        new Error("read replica down"),
      );

      await expect(
        service.publish("ep1", actor, { reason: "自检本身崩了也不该影响发布" }),
      ).resolves.toMatchObject({ versionId: "v3" });
    });
  });

  describe("revert", () => {
    const target = versionRow({
      id: "v1",
      version: 1,
      status: "superseded",
      payload: {
        title: "旧标题",
        recap: null,
        segments: [{ order: 0, kind: "narration", text: "旧开场" }],
      },
    });

    beforeEach(() => {
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(target);
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v2", version: 2, status: "published" }),
        target,
      ]);
      tx.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v2", version: 2, status: "published" }),
        target,
      ]);
      prisma.adventureSegment.findMany.mockResolvedValue([
        { order: 0, kind: "narration", text: "旧开场" },
      ]);
    });

    it("demands the typed business key before touching live content", async () => {
      await expect(
        service.revert("ep1", "v1", actor, {
          confirmText: "elly/1/4",
          reason: "打错业务键必须被拦住",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("creates a new published version carrying the old payload instead of rewriting history", async () => {
      const result = await service.revert("ep1", "v1", actor, {
        confirmText: "elly/1/3",
        reason: "新版本把结尾改坏了，回滚到 v1",
      });

      expect(tx.adventureEpisodeVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            episodeId: "ep1",
            version: 3,
            status: "published",
            publishedBy: "alice",
          }),
        }),
      );
      // 历史版本一行都不许改状态以外的东西；v1 仍是 superseded
      expect(tx.adventureEpisodeVersion.update).toHaveBeenCalledWith({
        where: { id: "v2" },
        data: expect.objectContaining({ status: "superseded" }),
      });
      expect(tx.adventureEpisode.update).toHaveBeenCalledWith({
        where: { id: "ep1" },
        data: expect.objectContaining({ currentVersionId: "v-new" }),
      });
      expect(auditActions()).toEqual(["revert"]);
      expect(audit.record.mock.calls[0][1].detail).toMatchObject({
        revertedFromVersionId: "v2",
        revertedToVersionId: "v1",
        revertedToVersion: 1,
      });
      expect(result).toMatchObject({ newVersion: 3, revertedToVersion: 1 });
    });

    it("refuses to revert to a draft or an already discarded version", async () => {
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(
        versionRow({ id: "v9", version: 9, status: "draft" }),
      );

      await expect(
        service.revert("ep1", "v9", actor, {
          confirmText: "elly/1/3",
          reason: "草稿不是可回滚的目标",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("rejects a version id that belongs to another episode", async () => {
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(
        versionRow({ id: "v1", episodeId: "other" }),
      );

      await expect(
        service.revert("ep1", "v1", actor, {
          confirmText: "elly/1/3",
          reason: "跨集回滚等于越权",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("blocks the revert when the old payload no longer passes the publish lint", async () => {
      query.checkContent.mockResolvedValue(errorReport("FORBIDDEN_WORD"));

      await expect(
        service.revert("ep1", "v1", actor, {
          confirmText: "elly/1/3",
          reason: "旧版本里有现在被禁用的词",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("warns that an untouched draft is still pending after the revert", async () => {
      tx.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v4", version: 4, status: "draft" }),
        versionRow({ id: "v2", version: 2, status: "published" }),
        target,
      ]);
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v4", version: 4, status: "draft" }),
        versionRow({ id: "v2", version: 2, status: "published" }),
        target,
      ]);

      const result = await service.revert("ep1", "v1", actor, {
        confirmText: "elly/1/3",
        reason: "回滚之后草稿还在，得提醒创作者",
      });

      expect(result.newVersion).toBe(5);
      expect(result.draftStillPending).toBe(true);
    });
  });

  describe("retire", () => {
    beforeEach(() => {
      tx.adventureDailyRecord.findMany.mockResolvedValue([
        { id: "d-1", deviceId: "dev-1" },
        { id: "d-2", deviceId: "dev-2" },
        { id: "d-3", deviceId: "dev-1" },
      ]);
      tx.adventureProgress.updateMany.mockResolvedValue({ count: 2 });
    });

    it("demands both the typed business key and a reason", async () => {
      await expect(
        service.retire("ep1", actor, { confirmText: "elly/1/3", reason: "短" }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.retire("ep1", actor, {
          confirmText: "错",
          reason: "理由够长但确认文本不对",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("refuses to retire an episode that was never published", async () => {
      query.loadEpisode.mockResolvedValue({ ...episodeRow, published: false });

      await expect(
        service.retire("ep1", actor, {
          confirmText: "elly/1/3",
          reason: "从没发布过就该走废弃整集",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("only collects the stale cross-day records and leaves today's children alone", async () => {
      const result = await service.retire("ep1", actor, {
        confirmText: "elly/1/3",
        reason: "内容有问题，先下架止血",
      });

      expect(tx.adventureDailyRecord.findMany).toHaveBeenCalledWith({
        where: {
          episodeId: "ep1",
          status: "in_progress",
          assignedDate: { lt: TODAY },
        },
        select: { id: true, deviceId: true },
      });
      expect(tx.adventureDailyRecord.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["d-1", "d-2", "d-3"] } },
        data: { status: "abandoned" },
      });
      expect(tx.adventureProgress.updateMany).toHaveBeenCalledWith({
        where: {
          episodeId: "ep1",
          deviceId: { in: ["dev-1", "dev-2"] },
          status: { in: ["in_progress", "awaiting_reply", "exited"] },
        },
        data: { status: "abandoned" },
      });
      expect(tx.adventureEpisode.update).toHaveBeenCalledWith({
        where: { id: "ep1" },
        data: { retiredAt: expect.any(Date) },
      });
      expect(auditActions()).toEqual(["retire"]);
      expect(result).toMatchObject({
        businessKey: "elly/1/3",
        staleDailyCount: 3,
        abandonedProgressCount: 2,
      });
      expect(result.impact.devicesPlayingToday).toBe(3);
    });

    it("skips the progress sweep entirely when nothing is stale", async () => {
      tx.adventureDailyRecord.findMany.mockResolvedValue([]);

      const result = await service.retire("ep1", actor, {
        confirmText: "elly/1/3",
        reason: "没有陈旧进度的情况下不该乱动 progress",
      });

      expect(tx.adventureProgress.updateMany).not.toHaveBeenCalled();
      expect(tx.adventureDailyRecord.updateMany).not.toHaveBeenCalled();
      expect(result.staleDailyCount).toBe(0);
    });

    it("is idempotent: retiring twice is a conflict, not a second sweep", async () => {
      query.loadEpisode.mockResolvedValue({
        ...episodeRow,
        retiredAt: new Date("2026-11-01"),
      });

      await expect(
        service.retire("ep1", actor, {
          confirmText: "elly/1/3",
          reason: "重复 retire 必须被识别出来",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("restore", () => {
    it("clears the tombstone and says out loud that abandoned progress never comes back", async () => {
      query.loadEpisode.mockResolvedValue({
        ...episodeRow,
        retiredAt: new Date("2026-11-01"),
      });
      prisma.adventureProgress.count.mockResolvedValue(7);

      const result = await service.restore("ep1", actor, {
        reason: "问题已修复，重新上架",
      });

      expect(tx.adventureEpisode.update).toHaveBeenCalledWith({
        where: { id: "ep1" },
        data: { retiredAt: null },
      });
      expect(auditActions()).toEqual(["restore"]);
      expect(result.abandonedProgressNotRestored).toBe(7);
      expect(result.message).toContain("7");
      expect(result.message).toContain("不会");
      expect(tx.adventureProgress.updateMany).not.toHaveBeenCalled();
    });

    it("rejects restoring an episode that is not retired", async () => {
      await expect(
        service.restore("ep1", actor, { reason: "没有被下架却想恢复" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("discardDraft", () => {
    it("marks the draft discarded when a published version still carries the episode", async () => {
      tx.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v3", version: 3, status: "draft" }),
        versionRow({ id: "v2", version: 2, status: "published" }),
      ]);

      const result = await service.discardDraft("ep1", actor, {
        reason: "这个方向不对，丢掉重来",
      });

      expect(tx.adventureEpisodeVersion.update).toHaveBeenCalledWith({
        where: { id: "v3" },
        data: { status: "discarded" },
      });
      expect(auditActions()).toEqual(["discard_draft"]);
      expect(result).toMatchObject({ discardedVersionId: "v3", version: 3 });
      expect(tx.adventureEpisode.update).not.toHaveBeenCalled();
    });

    it("refuses when the draft is the only content the episode has", async () => {
      tx.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v1", version: 1, status: "draft" }),
      ]);

      await expect(
        service.discardDraft("ep1", actor, {
          reason: "从没发布过的集不能只丢草稿",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.adventureEpisodeVersion.update).not.toHaveBeenCalled();
    });

    it("refuses when there is no draft", async () => {
      tx.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v2", version: 2, status: "published" }),
      ]);

      await expect(
        service.discardDraft("ep1", actor, { reason: "没有草稿却想丢草稿" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("discardEpisode", () => {
    beforeEach(() => {
      query.loadEpisode.mockResolvedValue({
        ...episodeRow,
        published: false,
        currentVersionId: null,
      });
      tx.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v1", version: 1, status: "draft" }),
      ]);
    });

    it("tombstones instead of deleting and states that the business key stays taken forever", async () => {
      const result = await service.discardEpisode("ep1", actor, {
        confirmText: "elly/1/3",
        reason: "这一集立项就错了，作废",
      });

      expect(tx.adventureEpisode.update).toHaveBeenCalledWith({
        where: { id: "ep1" },
        data: { retiredAt: expect.any(Date), published: false },
      });
      expect(tx.adventureEpisodeVersion.updateMany).toHaveBeenCalledWith({
        where: { episodeId: "ep1", status: "draft" },
        data: { status: "discarded" },
      });
      expect(auditActions()).toEqual(["discard"]);
      expect(result.message).toContain("elly/1/3");
      expect(result.message).toContain("永久");
    });

    it("refuses to discard an episode that has ever been published", async () => {
      tx.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v2", version: 2, status: "superseded" }),
      ]);

      await expect(
        service.discardEpisode("ep1", actor, {
          confirmText: "elly/1/3",
          reason: "发布过的集必须走 retire 而不是作废",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.adventureEpisode.update).not.toHaveBeenCalled();
    });

    it("demands the typed business key", async () => {
      await expect(
        service.discardEpisode("ep1", actor, {
          confirmText: "elly/1/9",
          reason: "确认文本不对就不能作废",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("safety invariants", () => {
    it("exposes no hard-delete path of any kind", () => {
      const methodNames = Object.getOwnPropertyNames(
        Object.getPrototypeOf(service),
      ).filter((name) => name !== "constructor");
      const destructive = methodNames.filter((name) =>
        /delete|remove|destroy|truncate|purge|erase|wipe/i.test(name),
      );
      expect(destructive).toEqual([]);
    });

    it("writes every mutation through the audit service inside the same transaction", async () => {
      tx.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v3", version: 3, status: "draft" }),
        versionRow({ id: "v2", version: 2, status: "published" }),
      ]);
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v3", version: 3, status: "draft" }),
        versionRow({ id: "v2", version: 2, status: "published" }),
      ]);
      prisma.adventureSegment.findMany.mockResolvedValue([]);

      await service.saveDraft("ep1", content, actor, {
        reason: "同事务审计写入校验",
      });

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0][2]).toBe(tx);
    });

    it("keeps the published snapshot immutable: no code path updates a published version's payload", async () => {
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v3", version: 3, status: "draft" }),
        versionRow({ id: "v2", version: 2, status: "published" }),
      ]);
      tx.adventureEpisodeVersion.findMany.mockResolvedValue([
        versionRow({ id: "v3", version: 3, status: "draft" }),
        versionRow({ id: "v2", version: 2, status: "published" }),
      ]);
      prisma.adventureSegment.findMany.mockResolvedValue([]);

      await service.publish("ep1", actor, {
        reason: "发布不许改写历史版本的 payload",
      });

      for (const call of tx.adventureEpisodeVersion.update.mock.calls) {
        const payloadKeys = Object.keys(call[0].data).filter(
          (key) => key === "payload",
        );
        if (call[0].where.id === "v2") {
          expect(payloadKeys).toEqual([]);
        }
      }
    });
  });
});
