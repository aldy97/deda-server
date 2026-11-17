import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AdventureTransferService } from "./adventure-transfer.service";
import { AdventureAuditService } from "./adventure-audit.service";
import { AdventureContentService } from "./adventure-content.service";
import { AdventureContentQueryService } from "./adventure-content-query.service";
import {
  AdventureBundle,
  BundleEpisode,
  bundleContentHash,
  episodeContentHash,
} from "./adventure-bundle";
import { LintIssue } from "./adventure-linter";

/**
 * 跨环境搬运是整个管理台里唯一能把 staging 的内容一次性推进 prod 的通道，
 * 所以这里的验收标准是：
 * - 导入**只写草稿**，永远不自动发布；发布必须是目标环境里一次独立的、有理由的动作。
 * - dry-run 与真实导入走同一份计划，且真实导入会重算计划——不信任客户端回传的预览。
 * - 任何一项被拒 → 整批不写（all-or-nothing），避免 prod 出现半套内容。
 * - 不静默覆盖同事在目标环境里的未发布草稿。
 */
describe("AdventureTransferService", () => {
  let service: AdventureTransferService;
  let prisma: {
    adventureEpisode: { findMany: jest.Mock; findUnique: jest.Mock };
    adventureEpisodeVersion: { findMany: jest.Mock; findUnique: jest.Mock };
  };
  let audit: { record: jest.Mock; list: jest.Mock };
  let query: { capabilities: jest.Mock; checkContent: jest.Mock };
  let content: {
    createEpisode: jest.Mock;
    saveDraft: jest.Mock;
    publish: jest.Mock;
  };

  const actor = {
    username: "alice",
    displayName: "Alice",
    profile: "authoring",
  };
  const okReport = { ok: true, issues: [], errors: [], warnings: [] };

  function segment(text: string, order = 0): BundleEpisode["segments"][number] {
    return {
      order,
      kind: "narration",
      text,
      interactionType: null,
      options: null,
      fallbackText: null,
      exitText: null,
      rewardStar: false,
    };
  }

  function episodeA(text = "第一集开场"): BundleEpisode {
    return {
      characterKey: "elly",
      season: 1,
      episodeNumber: 1,
      title: "第一集",
      recap: null,
      segments: [segment(text)],
    };
  }

  function episodeB(): BundleEpisode {
    return {
      characterKey: "elly",
      season: 1,
      episodeNumber: 2,
      title: "第二集",
      recap: "上集回顾",
      segments: [segment("第二集开场"), segment("第二集结尾", 1)],
    };
  }

  function episodeC(): BundleEpisode {
    return {
      characterKey: "elly",
      season: 1,
      episodeNumber: 3,
      title: "第三集",
      recap: null,
      segments: [segment("第三集开场")],
    };
  }

  function makeBundle(episodes: BundleEpisode[]): AdventureBundle {
    return {
      bundleSchemaVersion: 1,
      exportedAt: "2026-11-13T00:00:00.000Z",
      sourceProfile: "authoring",
      episodes,
    };
  }

  function episodeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "ep-a",
      characterKey: "elly",
      season: 1,
      episodeNumber: 1,
      title: "第一集",
      recap: null,
      published: true,
      retiredAt: null,
      currentVersionId: "v-a",
      createdAt: new Date("2026-11-01"),
      updatedAt: new Date("2026-11-01"),
      ...overrides,
    };
  }

  /** 目标环境现状：elly/1/1 已发布且内容与 bundle 一致，elly/1/2 已发布但内容陈旧，elly/1/3 不存在。 */
  function mockTargetEnvironment(
    overrides: {
      episodes?: unknown[];
      publishedVersions?: unknown[];
      drafts?: unknown[];
    } = {},
  ) {
    prisma.adventureEpisode.findMany.mockResolvedValue(
      overrides.episodes ?? [
        episodeRow(),
        episodeRow({
          id: "ep-b",
          episodeNumber: 2,
          title: "第二集",
          currentVersionId: "v-b",
        }),
      ],
    );
    prisma.adventureEpisodeVersion.findMany.mockImplementation(
      async (args: { where: Record<string, unknown> }) => {
        if (args.where.status === "draft") {
          return overrides.drafts ?? [];
        }
        return (
          overrides.publishedVersions ?? [
            {
              id: "v-a",
              episodeId: "ep-a",
              version: 2,
              status: "published",
              contentHash: episodeContentHash(episodeA()),
              payload: episodeA(),
            },
            {
              id: "v-b",
              episodeId: "ep-b",
              version: 1,
              status: "published",
              contentHash: "stale-hash-from-an-older-export",
              payload: episodeB(),
            },
          ]
        );
      },
    );
  }

  beforeEach(async () => {
    prisma = {
      adventureEpisode: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      adventureEpisodeVersion: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined), list: jest.fn() };
    query = {
      capabilities: jest
        .fn()
        .mockReturnValue({ profile: "authoring", authoring: true }),
      checkContent: jest.fn().mockResolvedValue(okReport),
    };
    content = {
      createEpisode: jest.fn().mockResolvedValue({
        episodeId: "ep-new",
        versionId: "v-new",
        version: 1,
      }),
      saveDraft: jest.fn().mockResolvedValue({
        episodeId: "ep-b",
        versionId: "v-b2",
        version: 2,
      }),
      publish: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdventureTransferService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdventureAuditService, useValue: audit },
        { provide: AdventureContentQueryService, useValue: query },
        { provide: AdventureContentService, useValue: content },
      ],
    }).compile();

    service = module.get(AdventureTransferService);
  });

  describe("exportBundle", () => {
    beforeEach(() => {
      prisma.adventureEpisode.findMany.mockResolvedValue([
        episodeRow(),
        episodeRow({
          id: "ep-draft-only",
          episodeNumber: 2,
          title: "只有草稿的第二集",
          published: false,
          currentVersionId: null,
        }),
      ]);
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        {
          id: "v-a",
          episodeId: "ep-a",
          version: 2,
          status: "published",
          contentHash: episodeContentHash(episodeA()),
          payload: episodeA(),
        },
      ]);
    });

    it("exports published snapshots only and says why the rest were skipped", async () => {
      const result = await service.exportBundle({}, actor);

      expect(result.episodeCount).toBe(1);
      expect(result.bundle.episodes).toHaveLength(1);
      expect(result.bundle.episodes[0]).toMatchObject({
        characterKey: "elly",
        season: 1,
        episodeNumber: 1,
        title: "第一集",
      });
      expect(result.skipped).toEqual([
        expect.objectContaining({ businessKey: "elly/1/2" }),
      ]);
      expect(result.skipped[0].reason).toContain("发布");
    });

    it("stamps the source profile so the receiving environment knows where the content came from", async () => {
      const result = await service.exportBundle({}, actor);

      expect(result.bundle.sourceProfile).toBe("authoring");
      expect(result.bundle.bundleSchemaVersion).toBe(1);
    });

    it("produces a hash that ignores the profile and the export timestamp", async () => {
      const result = await service.exportBundle({}, actor);
      const relocated = bundleContentHash({
        ...result.bundle,
        sourceProfile: "readonly",
        exportedAt: "1999-01-01T00:00:00.000Z",
      });

      // 同一份内容在 staging 与 prod 必须算出同一个 hash，否则「已一致」永远判不出来
      expect(relocated).toBe(result.bundleHash);
      expect(result.confirmToken).toHaveLength(12);
      expect(result.bundleHash.startsWith(result.confirmToken)).toBe(true);
    });

    it("refuses to export an empty selection instead of handing over a bundle that imports nothing", async () => {
      prisma.adventureEpisode.findMany.mockResolvedValue([]);

      const error = await service.exportBundle({}, actor).catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse().code).toBe("NOTHING_TO_EXPORT");
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("records an export audit naming every business key and the bundle hash", async () => {
      const result = await service.exportBundle({}, actor);

      expect(audit.record).toHaveBeenCalledTimes(1);
      const entry = audit.record.mock.calls[0][1];
      expect(entry).toMatchObject({ action: "export", entityType: "bundle" });
      expect(entry.businessKey).toBe("elly/1/1");
      expect(entry.detail.bundleHash).toBe(result.bundleHash);
      expect(entry.detail.skipped).toHaveLength(1);
    });

    it("never exports a draft snapshot even when it is newer than the published one", async () => {
      prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
        {
          id: "v-a",
          episodeId: "ep-a",
          version: 9,
          status: "draft",
          payload: episodeA("还没发布的改动"),
        },
      ]);

      const error = await service.exportBundle({}, actor).catch((e) => e);

      // 一份空 bundle 导过去只会让 prod 什么都不发生，所以直接拒绝，并把每集的原因说清楚
      expect(error).toBeInstanceOf(BadRequestException);
      const body = error.getResponse();
      expect(body.code).toBe("NOTHING_TO_EXPORT");
      expect(body.skipped).toEqual([
        expect.objectContaining({ businessKey: "elly/1/1" }),
        expect.objectContaining({ businessKey: "elly/1/2" }),
      ]);
      expect(body.skipped[0].reason).toContain("不是已发布");
      expect(body.skipped[1].reason).toContain("从未发布");
    });
  });

  describe("planImport", () => {
    it("refuses a malformed bundle without touching the database", async () => {
      const preview = await service.planImport({
        bundleSchemaVersion: 999,
        episodes: [],
      });

      expect(preview.ok).toBe(false);
      expect(preview.parseErrors.length).toBeGreaterThan(0);
      expect(preview.plan.items).toEqual([]);
      expect(prisma.adventureEpisode.findMany).not.toHaveBeenCalled();
    });

    it("classifies add, replace and already_up_to_date against the target environment", async () => {
      mockTargetEnvironment();

      const preview = await service.planImport(
        makeBundle([episodeA(), episodeB(), episodeC()]),
      );

      const byKey = Object.fromEntries(
        preview.plan.items.map((item) => [item.businessKey, item.action]),
      );
      expect(byKey).toEqual({
        "elly/1/1": "already_up_to_date",
        "elly/1/2": "replace",
        "elly/1/3": "add",
      });
      expect(preview.ok).toBe(true);
      expect(preview.plan).toMatchObject({
        adds: 1,
        replaces: 1,
        upToDate: 1,
        rejects: 0,
      });
    });

    it("rejects a target that this environment has retired", async () => {
      mockTargetEnvironment({
        episodes: [episodeRow({ retiredAt: new Date("2026-11-01") })],
      });

      const preview = await service.planImport(makeBundle([episodeA()]));

      expect(preview.ok).toBe(false);
      expect(preview.plan.items[0].action).toBe("reject");
      expect(preview.plan.items[0].reason).toContain("retire");
    });

    it("rejects a target carrying a diverging local draft instead of overwriting a colleague's work", async () => {
      mockTargetEnvironment({
        episodes: [
          episodeRow({
            id: "ep-b",
            episodeNumber: 2,
            title: "第二集",
            currentVersionId: "v-b",
          }),
        ],
        publishedVersions: [
          {
            id: "v-b",
            episodeId: "ep-b",
            version: 1,
            status: "published",
            contentHash: "stale-hash",
            payload: episodeB(),
          },
        ],
        drafts: [
          {
            id: "v-b-draft",
            episodeId: "ep-b",
            version: 2,
            status: "draft",
            contentHash: "someone-elses-work-in-progress",
            createdByName: "Carol",
            payload: episodeB(),
          },
        ],
      });

      const preview = await service.planImport(makeBundle([episodeB()]));

      expect(preview.ok).toBe(false);
      expect(preview.plan.items[0].action).toBe("reject");
      expect(preview.plan.items[0].reason).toContain("Carol");
      expect(preview.plan.items[0].reason).toContain("草稿");
    });

    it("accepts a local draft that already holds exactly the incoming content", async () => {
      mockTargetEnvironment({
        episodes: [
          episodeRow({
            id: "ep-b",
            episodeNumber: 2,
            title: "第二集",
            currentVersionId: "v-b",
          }),
        ],
        publishedVersions: [
          {
            id: "v-b",
            episodeId: "ep-b",
            version: 1,
            status: "published",
            contentHash: "stale-hash",
            payload: episodeB(),
          },
        ],
        drafts: [
          {
            id: "v-b-draft",
            episodeId: "ep-b",
            version: 2,
            status: "draft",
            contentHash: episodeContentHash(episodeB()),
            createdByName: "Carol",
            payload: episodeB(),
          },
        ],
      });

      const preview = await service.planImport(makeBundle([episodeB()]));

      expect(preview.plan.items[0].action).toBe("replace");
      expect(preview.ok).toBe(true);
    });

    it("blocks the whole import when incoming content would not even be savable as a draft", async () => {
      mockTargetEnvironment();
      const errors: LintIssue[] = [
        {
          severity: "error",
          code: "FORBIDDEN_WORD",
          message: "第 0 段含有禁用词。",
          businessKey: "elly/1/3",
        },
      ];
      query.checkContent.mockImplementation(
        async (
          episodeId: string | null,
          _c: unknown,
          identity?: { episodeNumber?: number },
        ) =>
          identity?.episodeNumber === 3
            ? { ok: false, issues: errors, errors, warnings: [] }
            : okReport,
      );

      const preview = await service.planImport(
        makeBundle([episodeA(), episodeC()]),
      );

      expect(preview.ok).toBe(false);
      const rejected = preview.plan.items.find(
        (item) => item.businessKey === "elly/1/3",
      );
      expect(rejected?.action).toBe("reject");
      expect(rejected?.reason).toContain("禁用词");
    });

    /**
     * 空壳集是导入链路唯一能造成的**持久性**伤害：它自己发布不出去（lint 的 NO_SEGMENTS
     * 会挡），但一旦落地就成了「目标环境这一集有未发布本地草稿」，之后每一次正常导入都会
     * 被环境闸拒掉，而且拒绝理由会指向一个根本没人在写的草稿。所以宁可整批失败。
     */
    it("rejects an episode that carries no usable segment instead of importing an empty shell", async () => {
      mockTargetEnvironment();

      const preview = await service.planImport(
        makeBundle([episodeA(), { ...episodeC(), segments: [] }]),
      );

      expect(preview.ok).toBe(false);
      const rejected = preview.plan.items.find(
        (item) => item.businessKey === "elly/1/3",
      );
      expect(rejected?.action).toBe("reject");
      expect(rejected?.reason).toContain("段");
      // 同批里内容正常的那一集照常被识别，不会因为兄弟集坏了就变成 reject
      expect(
        preview.plan.items.find((item) => item.businessKey === "elly/1/1")
          ?.action,
      ).toBe("already_up_to_date");
    });

    it("rejects an episode whose segments were all dropped while parsing the bundle", async () => {
      mockTargetEnvironment();
      const raw = {
        ...makeBundle([episodeA()]),
        episodes: [
          episodeA(),
          {
            ...episodeC(),
            // 两段都非法：一段没有文本，一段 order 不是整数。解析时会被丢弃并给出 warning。
            segments: [
              { order: 0, kind: "narration", text: "" },
              { order: "不是数字", kind: "narration", text: "第三集开场" },
            ],
          },
        ],
      };

      const preview = await service.planImport(raw);

      expect(preview.parseWarnings.join("")).toContain("已丢弃");
      expect(preview.ok).toBe(false);
      expect(
        preview.plan.items.find((item) => item.businessKey === "elly/1/3")
          ?.action,
      ).toBe("reject");
    });

    it("does not reject an add just because the target environment is still empty", async () => {
      // 反向护栏：空的是**目标环境**，不是 bundle。首次导入必须照常放行，
      // 否则一个全新的 prod 永远导不进第一集。
      mockTargetEnvironment({ episodes: [], publishedVersions: [] });

      const preview = await service.planImport(makeBundle([episodeC()]));

      expect(preview.ok).toBe(true);
      expect(preview.plan.items[0].action).toBe("add");
    });

    it("hands back a short confirm token that applyImport will demand verbatim", async () => {
      mockTargetEnvironment();

      const preview = await service.planImport(makeBundle([episodeC()]));

      expect(preview.confirmToken).toHaveLength(12);
      expect(preview.bundleHash.startsWith(preview.confirmToken)).toBe(true);
      expect(preview.message).toContain(preview.confirmToken);
    });
  });

  describe("applyImport", () => {
    const bundle = () => makeBundle([episodeB(), episodeC()]);

    async function tokenFor(raw: AdventureBundle) {
      const preview = await service.planImport(raw);
      return { token: preview.confirmToken, hash: preview.bundleHash };
    }

    beforeEach(() => {
      mockTargetEnvironment();
    });

    it("demands both a reason and the typed confirm token", async () => {
      const { token } = await tokenFor(bundle());

      await expect(
        service.applyImport(bundle(), actor, { confirmText: token }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.applyImport(bundle(), actor, {
          confirmText: "不是那个码",
          reason: "把 staging 校验过的两集搬到 prod",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(content.createEpisode).not.toHaveBeenCalled();
      expect(content.saveDraft).not.toHaveBeenCalled();
    });

    it("refuses a bundle that is not the one the admin previewed", async () => {
      const { token } = await tokenFor(makeBundle([episodeC()]));

      const error = await service
        .applyImport(bundle(), actor, {
          confirmText: token,
          expectedBundleHash: "a".repeat(64),
          reason: "偷换 bundle 必须被识别出来",
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse().code).toBe("BUNDLE_HASH_MISMATCH");
      expect(content.createEpisode).not.toHaveBeenCalled();
    });

    it("writes new episodes and replacements as drafts and never publishes them", async () => {
      const { token, hash } = await tokenFor(bundle());

      const result = await service.applyImport(bundle(), actor, {
        confirmText: token,
        expectedBundleHash: hash,
        reason: "把 staging 校验过的两集搬到 prod",
      });

      expect(content.createEpisode).toHaveBeenCalledTimes(1);
      expect(content.createEpisode.mock.calls[0][0]).toMatchObject({
        characterKey: "elly",
        season: 1,
        episodeNumber: 3,
      });
      expect(content.saveDraft).toHaveBeenCalledTimes(1);
      expect(content.saveDraft.mock.calls[0][0]).toBe("ep-b");
      expect(content.publish).not.toHaveBeenCalled();
      expect(result.written.map((item) => item.businessKey).sort()).toEqual([
        "elly/1/2",
        "elly/1/3",
      ]);
      expect(result.message).toContain("草稿");
      expect(result.message).toContain("不会自动发布");
    });

    it("passes the bundle token down so the per-episode audit trail links back to the import", async () => {
      const { token } = await tokenFor(bundle());

      await service.applyImport(bundle(), actor, {
        confirmText: token,
        reason: "把 staging 校验过的两集搬到 prod",
      });

      expect(content.saveDraft.mock.calls[0][3].reason).toContain(token);
      expect(content.createEpisode.mock.calls[0][3].reason).toContain(token);
    });

    it("records an import audit carrying the source bundle hash", async () => {
      const { token, hash } = await tokenFor(bundle());

      await service.applyImport(bundle(), actor, {
        confirmText: token,
        expectedBundleHash: hash,
        reason: "把 staging 校验过的两集搬到 prod",
      });

      const entry = audit.record.mock.calls.at(-1)[1];
      expect(entry).toMatchObject({
        action: "import",
        entityType: "bundle",
        sourceBundleHash: hash,
      });
      expect(entry.businessKey.split(",")).toEqual(["elly/1/2", "elly/1/3"]);
      expect(entry.detail).toMatchObject({ adds: 1, replaces: 1, upToDate: 0 });
    });

    it("refuses to write anything when any single item is rejected", async () => {
      mockTargetEnvironment({
        episodes: [
          episodeRow(),
          episodeRow({
            id: "ep-b",
            episodeNumber: 2,
            title: "第二集",
            currentVersionId: "v-b",
            retiredAt: new Date("2026-11-01"),
          }),
        ],
      });
      const raw = makeBundle([episodeA(), episodeB(), episodeC()]);
      const { token } = await tokenFor(raw);

      const error = await service
        .applyImport(raw, actor, {
          confirmText: token,
          reason: "有一集在 prod 被下架了，整批都不该写",
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse().code).toBe("IMPORT_PLAN_REJECTED");
      expect(content.createEpisode).not.toHaveBeenCalled();
      expect(content.saveDraft).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("writes nothing when the batch contains an empty-shell episode", async () => {
      mockTargetEnvironment();
      const raw = makeBundle([episodeC(), { ...episodeA(), segments: [] }]);
      const { token } = await tokenFor(raw);

      const error = await service
        .applyImport(raw, actor, {
          confirmText: token,
          reason: "有一集在导出时内容全坏了，整批都不该写",
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse().code).toBe("IMPORT_PLAN_REJECTED");
      expect(content.createEpisode).not.toHaveBeenCalled();
      expect(content.saveDraft).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("reports a no-op and still leaves an audit trail when the target already matches", async () => {
      mockTargetEnvironment();
      const raw = makeBundle([episodeA()]);
      const { token } = await tokenFor(raw);

      const result = await service.applyImport(raw, actor, {
        confirmText: token,
        reason: "确认两边内容确实一致",
      });

      expect(result.written).toEqual([]);
      expect(result.skipped).toEqual(["elly/1/1"]);
      expect(content.createEpisode).not.toHaveBeenCalled();
      expect(content.saveDraft).not.toHaveBeenCalled();
      expect(audit.record.mock.calls.at(-1)[1].action).toBe("import_noop");
    });

    it("recomputes the plan instead of trusting a client-supplied one", async () => {
      const { token } = await tokenFor(bundle());

      await service.applyImport(bundle(), actor, {
        confirmText: token,
        reason: "把 staging 校验过的两集搬到 prod",
        // 客户端塞进来的计划必须被忽略
        plan: { ok: true, items: [], adds: 99, replaces: 99 },
      } as never);

      expect(content.createEpisode).toHaveBeenCalledTimes(1);
      expect(content.saveDraft).toHaveBeenCalledTimes(1);
    });
  });
});
