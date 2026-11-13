import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { RequestMethod, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AdventureAdminController } from "./adventure-admin.controller";
import { AdventureContentService } from "./adventure-content.service";
import { AdventureContentQueryService } from "./adventure-content-query.service";
import { AdventureTransferService } from "./adventure-transfer.service";
import { AdventureAuditService } from "./adventure-audit.service";
import {
  CONTENT_READ_ONLY_METADATA_KEY,
  ContentAdminGuard,
} from "./guards/content-admin.guard";
import {
  CONTENT_ADMIN_SCOPE,
  resolveContentAdminProfile,
} from "./content-admin-profile";

/**
 * 这个 spec 的重心不是「每个 handler 都转发给了 service」——那部分很机械。
 * 真正要钉住的是两件安全事实：
 *
 * 1. **路由表是白名单**。EXPECTED_ROUTES 把 handler + method + path + 是否只读豁免
 *    全部写死，并从 Nest 的元数据反查一遍实际路由。任何人新增路由、或给某个路由
 *    挂上 @ContentReadOnly()，这条测试都会红。@ContentReadOnly() 的语义是
 *    「在只读环境开一个非 GET 的口子」，方向是放松权限，所以它必须被测试看见，
 *    不能靠 review 时的记性。
 * 2. **actor 不允许匿名**。审计表的全部意义在于「谁干的」；username 缺失时必须
 *    拒绝执行，而不是记成 unknown 混过去。
 */

interface RouteExpectation {
  handler: string;
  method: RequestMethod;
  path: string;
  /** true = 标了 @ContentReadOnly()，只读环境也可用（前提：它确实不写库） */
  readOnlyExempt: boolean;
}

const EXPECTED_ROUTES: RouteExpectation[] = [
  {
    handler: "capabilities",
    method: RequestMethod.GET,
    path: "capabilities",
    readOnlyExempt: false,
  },
  {
    handler: "listEpisodes",
    method: RequestMethod.GET,
    path: "episodes",
    readOnlyExempt: false,
  },
  {
    handler: "createEpisode",
    method: RequestMethod.POST,
    path: "episodes",
    readOnlyExempt: false,
  },
  {
    handler: "getEpisode",
    method: RequestMethod.GET,
    path: "episodes/:episodeId",
    readOnlyExempt: false,
  },
  {
    handler: "saveDraft",
    method: RequestMethod.POST,
    path: "episodes/:episodeId/draft",
    readOnlyExempt: false,
  },
  {
    handler: "publish",
    method: RequestMethod.POST,
    path: "episodes/:episodeId/publish",
    readOnlyExempt: false,
  },
  {
    handler: "revert",
    method: RequestMethod.POST,
    path: "episodes/:episodeId/revert",
    readOnlyExempt: false,
  },
  {
    handler: "retire",
    method: RequestMethod.POST,
    path: "episodes/:episodeId/retire",
    readOnlyExempt: false,
  },
  {
    handler: "restore",
    method: RequestMethod.POST,
    path: "episodes/:episodeId/restore",
    readOnlyExempt: false,
  },
  {
    handler: "discardDraft",
    method: RequestMethod.POST,
    path: "episodes/:episodeId/discard-draft",
    readOnlyExempt: false,
  },
  {
    handler: "discardEpisode",
    method: RequestMethod.POST,
    path: "episodes/:episodeId/discard",
    readOnlyExempt: false,
  },
  {
    handler: "listVersions",
    method: RequestMethod.GET,
    path: "episodes/:episodeId/versions",
    readOnlyExempt: false,
  },
  {
    handler: "getVersion",
    method: RequestMethod.GET,
    path: "episodes/:episodeId/versions/:versionId",
    readOnlyExempt: false,
  },
  {
    handler: "diffVersions",
    method: RequestMethod.GET,
    path: "episodes/:episodeId/diff",
    readOnlyExempt: false,
  },
  {
    handler: "impact",
    method: RequestMethod.GET,
    path: "episodes/:episodeId/impact",
    readOnlyExempt: false,
  },
  {
    handler: "lint",
    method: RequestMethod.POST,
    path: "lint",
    readOnlyExempt: true,
  },
  {
    handler: "simulate",
    method: RequestMethod.POST,
    path: "simulate",
    readOnlyExempt: true,
  },
  {
    handler: "listAudit",
    method: RequestMethod.GET,
    path: "audit",
    readOnlyExempt: false,
  },
  {
    handler: "exportBundle",
    method: RequestMethod.POST,
    path: "export",
    readOnlyExempt: false,
  },
  {
    handler: "importPreview",
    method: RequestMethod.POST,
    path: "import/preview",
    readOnlyExempt: true,
  },
  {
    handler: "applyImport",
    method: RequestMethod.POST,
    path: "import",
    readOnlyExempt: false,
  },
];

function normalizePath(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.replace(/^\//, "") : "";
}

/** 从 Nest 的路由元数据反查实际暴露了哪些路由，与 EXPECTED_ROUTES 逐条对齐。 */
function declaredRoutes(): RouteExpectation[] {
  const proto = AdventureAdminController.prototype as unknown as Record<
    string,
    unknown
  >;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== "constructor")
    .map((name) => ({ name, fn: proto[name] }))
    .filter(
      ({ fn }) =>
        typeof fn === "function" &&
        Reflect.getMetadata("path", fn) !== undefined,
    )
    .map(({ name, fn }) => ({
      handler: name,
      method: Reflect.getMetadata("method", fn) as RequestMethod,
      path: normalizePath(Reflect.getMetadata("path", fn)),
      readOnlyExempt:
        Reflect.getMetadata(CONTENT_READ_ONLY_METADATA_KEY, fn) === true,
    }))
    .sort((a, b) => a.handler.localeCompare(b.handler));
}

function adminRequest(extra: Record<string, unknown> = {}) {
  return {
    user: {
      adminId: "admin-1",
      username: "alice",
      displayName: "Alice",
      scope: "analytics",
      scopes: ["analytics", CONTENT_ADMIN_SCOPE],
      ...extra,
    },
  } as never;
}

const IDENTITY = { characterKey: "elly", season: 1, episodeNumber: 3 } as const;
const DRAFT = { title: "第三集", segments: [] } as const;

describe("AdventureAdminController", () => {
  let controller: AdventureAdminController;
  let query: Record<string, jest.Mock>;
  let content: Record<string, jest.Mock>;
  let transfer: Record<string, jest.Mock>;
  let audit: Record<string, jest.Mock>;
  let profile: string;

  beforeEach(async () => {
    profile = "authoring";
    query = {
      capabilities: jest.fn(),
      listEpisodes: jest.fn(),
      getEpisode: jest.fn(),
      listVersions: jest.fn(),
      getVersion: jest.fn(),
      diffVersions: jest.fn(),
      retireImpact: jest.fn(),
      checkContent: jest.fn(),
      simulate: jest.fn(),
    };
    content = {
      createEpisode: jest.fn(),
      saveDraft: jest.fn(),
      publish: jest.fn(),
      revert: jest.fn(),
      retire: jest.fn(),
      restore: jest.fn(),
      discardDraft: jest.fn(),
      discardEpisode: jest.fn(),
    };
    transfer = {
      exportBundle: jest.fn(),
      planImport: jest.fn(),
      applyImport: jest.fn(),
    };
    audit = { list: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdventureAdminController],
      providers: [
        { provide: AdventureContentQueryService, useValue: query },
        { provide: AdventureContentService, useValue: content },
        { provide: AdventureTransferService, useValue: transfer },
        { provide: AdventureAuditService, useValue: audit },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === "CONTENT_ADMIN_PROFILE" ? profile : undefined,
          },
        },
      ],
    }).compile();

    controller = module.get(AdventureAdminController);
  });

  describe("route table", () => {
    it("is mounted under analytics/adventure-admin so the dashboard proxy needs no change", () => {
      expect(
        normalizePath(Reflect.getMetadata("path", AdventureAdminController)),
      ).toBe("analytics/adventure-admin");
    });

    it("is guarded by ContentAdminGuard", () => {
      expect(
        Reflect.getMetadata("__guards__", AdventureAdminController),
      ).toContain(ContentAdminGuard);
    });

    it("exposes exactly the reviewed routes, with the reviewed read-only exemptions", () => {
      expect(declaredRoutes()).toEqual(
        [...EXPECTED_ROUTES].sort((a, b) => a.handler.localeCompare(b.handler)),
      );
    });

    it("only exempts the three routes that provably write nothing", () => {
      expect(
        EXPECTED_ROUTES.filter((route) => route.readOnlyExempt)
          .map((route) => route.path)
          .sort(),
      ).toEqual(["import/preview", "lint", "simulate"]);
    });

    it("keeps export behind the write gate because it leaves an audit row", () => {
      const exportRoute = EXPECTED_ROUTES.find((r) => r.path === "export");
      expect(exportRoute?.readOnlyExempt).toBe(false);
    });
  });

  describe("actor resolution", () => {
    it("records profile=authoring only when the environment says so", async () => {
      content.publish.mockResolvedValue({ ok: true });

      await controller.publish(
        "ep1",
        { reason: "上线第三集" } as never,
        adminRequest(),
      );
      expect(content.publish).toHaveBeenCalledWith(
        "ep1",
        { username: "alice", displayName: "Alice", profile: "authoring" },
        { reason: "上线第三集" },
      );

      profile = "readonly";
      await controller.publish(
        "ep1",
        { reason: "上线第三集" } as never,
        adminRequest(),
      );
      expect(content.publish).toHaveBeenLastCalledWith(
        "ep1",
        { username: "alice", displayName: "Alice", profile: "readonly" },
        { reason: "上线第三集" },
      );
    });

    it("falls back to username when displayName is missing", async () => {
      content.restore.mockResolvedValue({ ok: true });

      await controller.restore(
        "ep1",
        { reason: "重新上架" } as never,
        adminRequest({ displayName: undefined }),
      );

      expect(content.restore).toHaveBeenCalledWith(
        "ep1",
        { username: "alice", displayName: "alice", profile: "authoring" },
        { reason: "重新上架" },
      );
    });

    it.each([
      ["missing user", { user: undefined }],
      ["blank username", adminRequest({ username: "   " })],
      ["non-string username", adminRequest({ username: 42 })],
    ])("refuses to act anonymously: %s", async (_label, request) => {
      content.retire.mockResolvedValue({ ok: true });

      await expect(
        controller.retire(
          "ep1",
          { reason: "下架这一集", confirmText: "elly/1/3" } as never,
          request as never,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(content.retire).not.toHaveBeenCalled();
    });
  });

  describe("read routes", () => {
    it("forwards capabilities", async () => {
      query.capabilities.mockReturnValue({ authoring: true });

      await expect(controller.capabilities()).resolves.toEqual({
        authoring: true,
      });
    });

    it("passes list filters through untouched", async () => {
      query.listEpisodes.mockResolvedValue({ items: [], total: 0 });
      const dto = {
        characterKey: "elly",
        published: true,
        includeRetired: false,
        search: "森林",
        page: 2,
        pageSize: 20,
      };

      await controller.listEpisodes(dto as never);

      expect(query.listEpisodes).toHaveBeenCalledWith(dto);
    });

    it("drops blank list filters instead of forwarding them", async () => {
      query.listEpisodes.mockResolvedValue({ items: [], total: 0 });

      await controller.listEpisodes({
        characterKey: "",
        search: "   ",
      } as never);

      expect(query.listEpisodes).toHaveBeenCalledWith({});
    });

    it("forwards episode detail / versions / single version / impact", async () => {
      query.getEpisode.mockResolvedValue({ id: "ep1" });
      query.listVersions.mockResolvedValue([]);
      query.getVersion.mockResolvedValue({ id: "v1" });
      query.retireImpact.mockResolvedValue({ totalDevicesEverStarted: 3 });

      await controller.getEpisode("ep1");
      await controller.listVersions("ep1");
      await controller.getVersion("ep1", "v1");
      await controller.impact("ep1");

      expect(query.getEpisode).toHaveBeenCalledWith("ep1");
      expect(query.listVersions).toHaveBeenCalledWith("ep1");
      expect(query.getVersion).toHaveBeenCalledWith("ep1", "v1");
      expect(query.retireImpact).toHaveBeenCalledWith("ep1");
    });

    it("forwards diff with left/right from the query string", async () => {
      query.diffVersions.mockResolvedValue({ added: [] });

      await controller.diffVersions("ep1", {
        left: "v1",
        right: "v2",
      } as never);

      expect(query.diffVersions).toHaveBeenCalledWith("ep1", "v1", "v2");
    });

    it("converts audit from/to to Date and trims the rest", async () => {
      audit.list.mockResolvedValue({ items: [], total: 0 });

      await controller.listAudit({
        episodeId: " ep1 ",
        actorUsername: "",
        action: "  ",
        from: "2026-11-01T00:00:00.000Z",
        to: "2026-11-02T00:00:00.000Z",
        page: 1,
        pageSize: 50,
      } as never);

      expect(audit.list).toHaveBeenCalledWith({
        episodeId: "ep1",
        from: new Date("2026-11-01T00:00:00.000Z"),
        to: new Date("2026-11-02T00:00:00.000Z"),
        page: 1,
        pageSize: 50,
      });
    });

    it("ignores an unparseable audit date rather than querying with Invalid Date", async () => {
      audit.list.mockResolvedValue({ items: [], total: 0 });

      await controller.listAudit({ from: "not-a-date" } as never);

      expect(audit.list).toHaveBeenCalledWith({});
    });
  });

  describe("non-mutating POST routes", () => {
    it("lint passes episodeId=null when validating a brand new episode", async () => {
      query.checkContent.mockResolvedValue({ ok: true });

      await controller.lint({
        content: DRAFT,
        identity: IDENTITY,
        forPublish: true,
      } as never);

      expect(query.checkContent).toHaveBeenCalledWith(null, DRAFT, {
        ...IDENTITY,
        forPublish: true,
      });
    });

    it("lint targets an existing episode and leaves identity undefined when not editing it", async () => {
      query.checkContent.mockResolvedValue({ ok: true });

      await controller.lint({ episodeId: " ep1 ", content: DRAFT } as never);

      expect(query.checkContent).toHaveBeenCalledWith("ep1", DRAFT, undefined);
    });

    it("lint defaults season so a hand-written bundle is not rejected for omitting it", async () => {
      query.checkContent.mockResolvedValue({ ok: true });

      await controller.lint({
        content: DRAFT,
        identity: { characterKey: "elly", episodeNumber: 3 },
      } as never);

      expect(query.checkContent).toHaveBeenCalledWith(null, DRAFT, {
        characterKey: "elly",
        season: 1,
        episodeNumber: 3,
      });
    });

    it("simulate passes identity + content only", async () => {
      query.simulate.mockReturnValue({ beats: [] });

      const result = await controller.simulate({
        identity: IDENTITY,
        content: DRAFT,
      } as never);

      expect(query.simulate).toHaveBeenCalledWith({ ...IDENTITY }, DRAFT);
      expect(result).toEqual({ beats: [] });
    });

    it("import preview forwards the bundle only, never the confirm text", async () => {
      const bundle = { bundleSchemaVersion: 1, episodes: [] };
      transfer.planImport.mockResolvedValue({ ok: true });

      await controller.importPreview({ bundle } as never);

      expect(transfer.planImport).toHaveBeenCalledWith(bundle);
    });
  });

  describe("mutating routes", () => {
    it("create forwards identity and content, plus only the reason it was given", async () => {
      content.createEpisode.mockResolvedValue({ episodeId: "ep1" });

      await controller.createEpisode(
        { identity: IDENTITY, content: DRAFT, reason: "新建第三集" } as never,
        adminRequest(),
      );

      expect(content.createEpisode).toHaveBeenCalledWith(
        { ...IDENTITY },
        DRAFT,
        { username: "alice", displayName: "Alice", profile: "authoring" },
        { reason: "新建第三集" },
      );
    });

    it("saveDraft forwards the optimistic-lock baseline and force flag", async () => {
      content.saveDraft.mockResolvedValue({ episodeId: "ep1" });

      await controller.saveDraft(
        "ep1",
        {
          content: DRAFT,
          reason: "改第二段的措辞",
          baseVersionId: "v7",
          force: true,
        } as never,
        adminRequest(),
      );

      expect(content.saveDraft).toHaveBeenCalledWith(
        "ep1",
        DRAFT,
        expect.anything(),
        { reason: "改第二段的措辞", baseVersionId: "v7", force: true },
      );
    });

    it("saveDraft omits baseVersionId when the editor did not send one", async () => {
      content.saveDraft.mockResolvedValue({ episodeId: "ep1" });

      await controller.saveDraft(
        "ep1",
        { content: DRAFT, reason: "改措辞" } as never,
        adminRequest(),
      );

      expect(content.saveDraft).toHaveBeenCalledWith(
        "ep1",
        DRAFT,
        expect.anything(),
        {
          reason: "改措辞",
        },
      );
    });

    it("publish forwards reason only — confirm text is not part of publishing", async () => {
      content.publish.mockResolvedValue({ episodeId: "ep1" });

      await controller.publish(
        "ep1",
        { reason: "staging 验证通过，上线" } as never,
        adminRequest(),
      );

      expect(content.publish).toHaveBeenCalledWith("ep1", expect.anything(), {
        reason: "staging 验证通过，上线",
      });
    });

    it("revert forwards target version, confirm text and reason", async () => {
      content.revert.mockResolvedValue({ episodeId: "ep1" });

      await controller.revert(
        "ep1",
        {
          targetVersionId: "v5",
          reason: "v6 的选择题太难，退回 v5",
          confirmText: "elly/1/3",
        } as never,
        adminRequest(),
      );

      expect(content.revert).toHaveBeenCalledWith(
        "ep1",
        "v5",
        expect.anything(),
        { reason: "v6 的选择题太难，退回 v5", confirmText: "elly/1/3" },
      );
    });

    it("revert needs a target version and says so instead of calling the service", async () => {
      await expect(
        controller.revert(
          "ep1",
          { targetVersionId: "  ", reason: "退回上一版" } as never,
          adminRequest(),
        ),
      ).rejects.toThrow();
      expect(content.revert).not.toHaveBeenCalled();
    });

    it.each([
      [
        "retire",
        { reason: "下架", confirmText: "elly/1/3" },
        { reason: "下架", confirmText: "elly/1/3" },
      ],
      [
        "restore",
        { reason: "重新上架", confirmText: "elly/1/3" },
        { reason: "重新上架" },
      ],
      [
        "discardDraft",
        { reason: "草稿不要了", confirmText: "elly/1/3" },
        { reason: "草稿不要了" },
      ],
      [
        "discardEpisode",
        { reason: "这一集作废", confirmText: "elly/1/3" },
        { reason: "这一集作废", confirmText: "elly/1/3" },
      ],
    ])(
      "%s forwards exactly the options it is allowed to use",
      async (route, dto, expected) => {
        content[route].mockResolvedValue({ episodeId: "ep1" });
        const handler = (controller as unknown as Record<string, unknown>)[
          route as string
        ] as (id: string, dto: unknown, req: unknown) => Promise<unknown>;

        // 必须 .call：把 handler 从实例上摘下来直接调用，this 会是 undefined
        await handler.call(controller, "ep1", dto as never, adminRequest());

        expect(content[route]).toHaveBeenCalledWith(
          "ep1",
          expect.anything(),
          expected,
        );
      },
    );

    it("normalises blank reason/confirmText away so the service reports the real error", async () => {
      content.retire.mockResolvedValue({ episodeId: "ep1" });

      await controller.retire(
        "ep1",
        { reason: "   ", confirmText: "" } as never,
        adminRequest(),
      );

      expect(content.retire).toHaveBeenCalledWith("ep1", expect.anything(), {});
    });
  });

  describe("transfer routes", () => {
    it("export forwards the selector and nothing else", async () => {
      transfer.exportBundle.mockResolvedValue({ bundleHash: "h" });

      await controller.exportBundle(
        {
          episodeIds: ["ep1", "ep2"],
          characterKey: "elly",
          includeRetired: true,
        } as never,
        adminRequest(),
      );

      expect(transfer.exportBundle).toHaveBeenCalledWith(
        {
          episodeIds: ["ep1", "ep2"],
          characterKey: "elly",
          includeRetired: true,
        },
        expect.anything(),
      );
    });

    it("export with an empty episodeIds array exports by character rather than nothing", async () => {
      transfer.exportBundle.mockResolvedValue({ bundleHash: "h" });

      await controller.exportBundle(
        { episodeIds: [], characterKey: "elly" } as never,
        adminRequest(),
      );

      expect(transfer.exportBundle).toHaveBeenCalledWith(
        { characterKey: "elly" },
        expect.anything(),
      );
    });

    it("import applies the confirm token and expected hash from the preview", async () => {
      const bundle = { bundleSchemaVersion: 1, episodes: [] };
      transfer.applyImport.mockResolvedValue({ bundleHash: "h" });

      await controller.applyImport(
        {
          bundle,
          reason: "把 staging 验证过的三集搬到 prod",
          confirmText: "Ab3xK9mQ2pLr",
          expectedBundleHash: "hash-abc",
        } as never,
        adminRequest(),
      );

      expect(transfer.applyImport).toHaveBeenCalledWith(
        bundle,
        expect.objectContaining({ username: "alice", profile: "authoring" }),
        {
          reason: "把 staging 验证过的三集搬到 prod",
          confirmText: "Ab3xK9mQ2pLr",
          expectedBundleHash: "hash-abc",
        },
      );
    });

    it("import refuses a missing bundle before touching the service", async () => {
      await expect(
        controller.applyImport(
          { reason: "搬过来", confirmText: "Ab3xK9mQ2pLr" } as never,
          adminRequest(),
        ),
      ).rejects.toThrow();
      expect(transfer.applyImport).not.toHaveBeenCalled();
    });
  });

  it("resolveContentAdminProfile stays fail-safe for the controller too", () => {
    const configService = { get: () => undefined } as unknown as ConfigService;

    expect(resolveContentAdminProfile(configService)).toBe("readonly");
  });
});
