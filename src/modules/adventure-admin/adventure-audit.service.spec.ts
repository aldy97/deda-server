import { Test, TestingModule } from "@nestjs/testing";
import { AdventureAuditService } from "./adventure-audit.service";
import { PrismaService } from "@/common/prisma/prisma.service";

/**
 * 审计是安全控制而不是日志：破坏性内容操作的可追溯性依赖它。
 * 所以这里除了写入内容，还要用结构性断言锁住「本服务不存在任何改写入口」。
 */
describe("AdventureAuditService", () => {
  let service: AdventureAuditService;
  let prisma: {
    adventureContentAuditLog: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
  };

  const actor = {
    username: "alice",
    displayName: "Alice",
    profile: "authoring",
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdventureAuditService,
        {
          provide: PrismaService,
          useValue: {
            adventureContentAuditLog: {
              create: jest.fn().mockResolvedValue({ id: "audit-1" }),
              findMany: jest.fn().mockResolvedValue([]),
              count: jest.fn().mockResolvedValue(0),
            },
          },
        },
      ],
    }).compile();

    service = module.get(AdventureAuditService);
    prisma = module.get(PrismaService);
  });

  it("writes an append-only row with the actor, profile and business key", async () => {
    await service.record(actor, {
      action: "publish",
      entityType: "episode_version",
      episodeId: "ep1",
      episodeVersionId: "v3",
      businessKey: "elly/1/3",
      reason: "修正第二段的错别字",
      detail: { fromVersion: 2 },
    });

    expect(prisma.adventureContentAuditLog.create).toHaveBeenCalledWith({
      data: {
        action: "publish",
        entityType: "episode_version",
        episodeId: "ep1",
        episodeVersionId: "v3",
        businessKey: "elly/1/3",
        actorUsername: "alice",
        actorDisplayName: "Alice",
        profile: "authoring",
        reason: "修正第二段的错别字",
        detail: { fromVersion: 2 },
        sourceBundleHash: null,
      },
    });
  });

  it("defaults optional columns to null instead of omitting them", async () => {
    await service.record(actor, {
      action: "retire",
      entityType: "episode",
      businessKey: "elly/1/3",
    });

    const call = prisma.adventureContentAuditLog.create.mock.calls[0][0];
    expect(call.data).toEqual(
      expect.objectContaining({
        episodeId: null,
        episodeVersionId: null,
        reason: null,
        detail: null,
        sourceBundleHash: null,
      }),
    );
  });

  it("writes through the supplied transaction client so the audit cannot outlive a rolled-back change", async () => {
    const tx = {
      adventureContentAuditLog: { create: jest.fn().mockResolvedValue({}) },
    };

    await service.record(
      actor,
      { action: "publish", entityType: "episode", businessKey: "elly/1/1" },
      tx as never,
    );

    expect(tx.adventureContentAuditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.adventureContentAuditLog.create).not.toHaveBeenCalled();
  });

  it("lets an audit write failure propagate so the content change is rolled back with it", async () => {
    prisma.adventureContentAuditLog.create.mockRejectedValueOnce(
      new Error("audit table unavailable"),
    );

    await expect(
      service.record(actor, {
        action: "retire",
        entityType: "episode",
        businessKey: "elly/1/1",
      }),
    ).rejects.toThrow("audit table unavailable");
  });

  it("exposes no update, delete or mutation entry point of any kind", () => {
    const methodNames = Object.getOwnPropertyNames(
      Object.getPrototypeOf(service),
    ).filter((name) => name !== "constructor");
    const mutating = methodNames.filter((name) =>
      /update|delete|remove|destroy|upsert|patch|edit|truncate/i.test(name),
    );
    expect(mutating).toEqual([]);
    expect(methodNames.sort()).toEqual(["list", "record"]);
  });

  describe("list", () => {
    beforeEach(() => {
      prisma.adventureContentAuditLog.findMany.mockResolvedValue([
        { id: "a1", action: "publish" },
      ]);
      prisma.adventureContentAuditLog.count.mockResolvedValue(1);
    });

    it("orders newest first and pages with a bounded page size", async () => {
      const result = await service.list({ page: 2, pageSize: 10 });

      expect(prisma.adventureContentAuditLog.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { createdAt: "desc" },
        skip: 10,
        take: 10,
      });
      expect(result).toEqual({
        items: [{ id: "a1", action: "publish" }],
        total: 1,
      });
    });

    it("clamps an oversized or non-positive page size", async () => {
      await service.list({ page: 1, pageSize: 100000 });
      expect(
        prisma.adventureContentAuditLog.findMany.mock.calls.at(-1)[0].take,
      ).toBe(200);

      await service.list({ page: 1, pageSize: 0 });
      expect(
        prisma.adventureContentAuditLog.findMany.mock.calls.at(-1)[0].take,
      ).toBe(50);

      await service.list({ page: -3, pageSize: 10 });
      expect(
        prisma.adventureContentAuditLog.findMany.mock.calls.at(-1)[0].skip,
      ).toBe(0);
    });

    it("filters by episode, actor, action and time range", async () => {
      await service.list({
        episodeId: "ep1",
        actorUsername: "alice",
        action: "retire",
        from: new Date("2026-11-01T00:00:00Z"),
        to: new Date("2026-11-02T00:00:00Z"),
      });

      expect(
        prisma.adventureContentAuditLog.findMany.mock.calls[0][0].where,
      ).toEqual({
        episodeId: "ep1",
        actorUsername: "alice",
        action: "retire",
        createdAt: {
          gte: new Date("2026-11-01T00:00:00Z"),
          lte: new Date("2026-11-02T00:00:00Z"),
        },
      });
    });

    it("ignores empty filters rather than turning them into empty-string matches", async () => {
      await service.list({ episodeId: "", actorUsername: "  ", action: "" });
      expect(
        prisma.adventureContentAuditLog.findMany.mock.calls[0][0].where,
      ).toEqual({});
    });
  });
});
