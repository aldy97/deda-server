import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { AdventureAuditService, AuditActor } from "./adventure-audit.service";
import { ADVENTURE_TEST_ENV } from "@/modules/adventure/adventure.constants";
import { AdventureTestAssignService } from "./adventure-test-assign.service";

/**
 * 测试冒险故事下发的单测：钉住环境闸、设备/集校验、草稿快照锁定、
 * 清除的「只清当前集」与「审计写失败不吞结果」口径。
 */
describe("AdventureTestAssignService", () => {
  let service: AdventureTestAssignService;
  let prisma: {
    device: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    adventureEpisode: { findUnique: jest.Mock };
    adventureEpisodeVersion: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
    adventureContentAuditLog: { findMany: jest.Mock };
    conversationSession: { upsert: jest.Mock };
  };
  let config: { get: jest.Mock };
  let audit: { record: jest.Mock };
  let testAccess: { isAllowed: jest.Mock };

  const actor: AuditActor = {
    username: "alice",
    displayName: "Alice",
    profile: "authoring",
  };

  beforeEach(() => {
    prisma = {
      device: {
        findFirst: jest.fn().mockResolvedValue({
          id: "dev-internal-1",
          deviceId: "dev-1001",
          deviceCode: "CN-001",
          testAdventureEpisodeId: null,
          testAdventureEpisodeVersionId: null,
        }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn().mockResolvedValue({}),
      },
      adventureEpisode: {
        findUnique: jest.fn().mockResolvedValue({
          id: "ep1",
          title: "听风原野第一天",
          currentVersionId: "v3",
        }),
      },
      adventureEpisodeVersion: {
        findFirst: jest.fn().mockResolvedValue({ id: "draft-1" }),
        findUnique: jest.fn().mockResolvedValue({
          id: "draft-1",
          version: 2,
          status: "draft",
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      adventureContentAuditLog: { findMany: jest.fn().mockResolvedValue([]) },
      conversationSession: { upsert: jest.fn().mockResolvedValue({}) },
    };
    config = { get: jest.fn().mockReturnValue("true") };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    testAccess = { isAllowed: jest.fn().mockResolvedValue(true) };
    service = new AdventureTestAssignService(
      prisma as never,
      config as never,
      audit as never,
      testAccess as never,
    );
  });

  function enable(value: string | undefined) {
    config.get.mockImplementation((key: string) =>
      key === ADVENTURE_TEST_ENV.enabled ? value : undefined,
    );
  }

  it("assign refuses when the env gate is off", async () => {
    enable(undefined);

    await expect(
      service.assign(
        "ep1",
        { deviceId: "dev-1001", reason: "测试环境验收这一集" },
        actor,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it("assign 403s when the device is not on the test whitelist", async () => {
    testAccess.isAllowed.mockResolvedValue(false);

    await expect(
      service.assign(
        "ep1",
        { deviceId: "dev-1001", reason: "测试环境验收这一集" },
        actor,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(testAccess.isAllowed).toHaveBeenCalledWith("dev-internal-1");
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("assign 404s when the episode is unknown", async () => {
    prisma.adventureEpisode.findUnique.mockResolvedValue(null);

    await expect(
      service.assign(
        "ep-404",
        { deviceId: "dev-1001", reason: "测试环境验收这一集" },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("assign 404s when the device is unknown", async () => {
    prisma.device.findFirst.mockResolvedValue(null);

    await expect(
      service.assign(
        "ep1",
        { deviceId: "dev-404", reason: "测试环境验收这一集" },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("assign rejects a too-short reason before touching anything", async () => {
    await expect(
      service.assign("ep1", { deviceId: "dev-1001", reason: "短" }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it("assign pins the draft snapshot when one exists", async () => {
    const result = await service.assign(
      "ep1",
      { deviceId: "dev-1001", reason: "测试环境验收这一集" },
      actor,
    );

    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: "dev-internal-1" },
      data: {
        testAdventureEpisodeId: "ep1",
        testAdventureEpisodeVersionId: "draft-1",
      },
    });
    expect(prisma.conversationSession.upsert).toHaveBeenCalled();
    expect(testAccess.isAllowed).toHaveBeenCalledWith("dev-internal-1");
    expect(audit.record).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ action: "device_test_assign" }),
    );
    expect(result).toMatchObject({
      ok: true,
      audited: true,
      assignment: { episodeId: "ep1", versionStatus: "draft" },
    });
  });

  it("assign falls back to the published version when no draft exists", async () => {
    prisma.adventureEpisodeVersion.findFirst.mockResolvedValue(null);

    const result = await service.assign(
      "ep1",
      { deviceId: "dev-1001", reason: "测试环境验收这一集" },
      actor,
    );

    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: "dev-internal-1" },
      data: {
        testAdventureEpisodeId: "ep1",
        testAdventureEpisodeVersionId: "v3",
      },
    });
    expect(result.assignment.versionStatus).toBe("published");
  });

  it("assign still succeeds with audited=false when the audit write fails", async () => {
    audit.record.mockRejectedValue(new Error("db down"));

    const result = await service.assign(
      "ep1",
      { deviceId: "dev-1001", reason: "测试环境验收这一集" },
      actor,
    );

    expect(result.ok).toBe(true);
    expect(result.audited).toBe(false);
  });

  it("clear refuses when the env gate is off", async () => {
    enable(undefined);

    await expect(
      service.clear(
        "ep1",
        { deviceId: "dev-1001", reason: "验收完成清除下发" },
        actor,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("clear 409s when the device is assigned a different episode", async () => {
    prisma.device.findFirst.mockResolvedValue({
      id: "dev-internal-1",
      deviceId: "dev-1001",
      deviceCode: "CN-001",
      testAdventureEpisodeId: "ep-other",
      testAdventureEpisodeVersionId: null,
    });

    await expect(
      service.clear(
        "ep1",
        { deviceId: "dev-1001", reason: "验收完成清除下发" },
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it("clear nulls the assignment and leaves an audit row", async () => {
    prisma.device.findFirst.mockResolvedValue({
      id: "dev-internal-1",
      deviceId: "dev-1001",
      deviceCode: "CN-001",
      testAdventureEpisodeId: "ep1",
      testAdventureEpisodeVersionId: "draft-1",
    });

    const result = await service.clear(
      "ep1",
      { deviceId: "dev-1001", reason: "验收完成清除下发" },
      actor,
    );

    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: "dev-internal-1" },
      data: {
        testAdventureEpisodeId: null,
        testAdventureEpisodeVersionId: null,
      },
    });
    expect(audit.record).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ action: "device_test_clear" }),
    );
    // 清除是给脏数据兜底的，不要求设备仍在白名单里。
    expect(testAccess.isAllowed).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("assignment reports disabled without exposing details when env is off", async () => {
    enable(undefined);

    await expect(service.assignment("dev-1001")).resolves.toEqual({
      enabled: false,
      assignment: null,
    });
    expect(prisma.device.findFirst).not.toHaveBeenCalled();
  });

  it("assignment returns null for an unassigned device", async () => {
    await expect(service.assignment("dev-1001")).resolves.toEqual({
      enabled: true,
      whitelisted: true,
      assignment: null,
    });
  });

  it("assignment returns the episode and pinned version for an assigned device", async () => {
    prisma.device.findFirst.mockResolvedValue({
      id: "dev-internal-1",
      deviceId: "dev-1001",
      deviceCode: "CN-001",
      testAdventureEpisodeId: "ep1",
      testAdventureEpisodeVersionId: "draft-1",
    });
    prisma.adventureEpisode.findUnique.mockResolvedValue({
      id: "ep1",
      title: "听风原野第一天",
      episodeNumber: 1,
      characterKey: "elly",
      season: 1,
    });

    const result = await service.assignment("dev-1001");

    expect(result.enabled).toBe(true);
    expect(result.whitelisted).toBe(true);
    expect(result.assignment).toMatchObject({
      episode: { id: "ep1", title: "听风原野第一天" },
      episodeVersion: { id: "draft-1", status: "draft" },
    });
  });

  it("assignment reports whitelisted=false but still returns details for cleanup", async () => {
    testAccess.isAllowed.mockResolvedValue(false);
    prisma.device.findFirst.mockResolvedValue({
      id: "dev-internal-1",
      deviceId: "dev-1001",
      deviceCode: "CN-001",
      testAdventureEpisodeId: "ep1",
      testAdventureEpisodeVersionId: "draft-1",
    });
    prisma.adventureEpisode.findUnique.mockResolvedValue({
      id: "ep1",
      title: "听风原野第一天",
      episodeNumber: 1,
      characterKey: "elly",
      season: 1,
    });

    const result = await service.assignment("dev-1001");

    expect(result.whitelisted).toBe(false);
    expect(result.assignment).toMatchObject({ episode: { id: "ep1" } });
  });

  it("assignment returns a null version when the assigned episode has no pinned snapshot", async () => {
    prisma.device.findFirst.mockResolvedValue({
      id: "dev-internal-1",
      deviceId: "dev-1001",
      deviceCode: "CN-001",
      testAdventureEpisodeId: "ep1",
      testAdventureEpisodeVersionId: null,
    });
    prisma.adventureEpisode.findUnique.mockResolvedValue({
      id: "ep1",
      title: "听风原野第一天",
      episodeNumber: 1,
      characterKey: "elly",
      season: 1,
    });

    const result = await service.assignment("dev-1001");

    expect(result.assignment).toMatchObject({
      episode: { id: "ep1" },
      episodeVersion: null,
    });
  });

  it("list reports disabled without querying when the env gate is off", async () => {
    enable(undefined);

    await expect(service.listByCharacter("elly")).resolves.toEqual({
      enabled: false,
      characterKey: "elly",
      total: 0,
      devices: [],
    });
    expect(prisma.device.findMany).not.toHaveBeenCalled();
    expect(prisma.device.count).not.toHaveBeenCalled();
  });

  it("list returns every device under the IP with episode, pinned version and assignment time", async () => {
    prisma.device.findMany.mockResolvedValue([
      {
        deviceId: "dev-1002",
        deviceCode: null,
        testAdventureEpisodeId: "ep2",
        testAdventureEpisodeVersionId: null,
        testAdventureEpisode: {
          id: "ep2",
          businessKey: "elly/1/2",
          title: "听风原野第二天",
          characterKey: "elly",
          season: 1,
          episodeNumber: 2,
          retiredAt: null,
          currentVersionId: "v9",
        },
        testAdventureEpisodeVersion: null,
      },
      {
        deviceId: "dev-1001",
        deviceCode: "CN-001",
        testAdventureEpisodeId: "ep1",
        testAdventureEpisodeVersionId: "draft-1",
        testAdventureEpisode: {
          id: "ep1",
          businessKey: "elly/1/1",
          title: "听风原野第一天",
          characterKey: "elly",
          season: 1,
          episodeNumber: 1,
          retiredAt: null,
          currentVersionId: "v3",
        },
        testAdventureEpisodeVersion: {
          id: "draft-1",
          version: 2,
          status: "draft",
        },
      },
    ]);
    prisma.device.count.mockResolvedValue(2);
    prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
      { id: "draft-2", episodeId: "ep1" },
    ]);
    prisma.adventureContentAuditLog.findMany.mockResolvedValue([
      {
        businessKey: "dev-1001",
        createdAt: new Date("2026-11-20T10:00:00.000Z"),
      },
    ]);

    const result = await service.listByCharacter("elly");

    expect(prisma.device.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { testAdventureEpisode: { is: { characterKey: "elly" } } },
      }),
    );
    expect(result).toMatchObject({
      enabled: true,
      characterKey: "elly",
      total: 2,
    });
    // 按集号排序，不跟着数据库返回顺序走
    expect(result.devices.map((row) => row.deviceId)).toEqual([
      "dev-1001",
      "dev-1002",
    ]);
    expect(result.devices[0]).toMatchObject({
      deviceId: "dev-1001",
      deviceCode: "CN-001",
      episode: { businessKey: "elly/1/1", episodeNumber: 1 },
      version: { id: "draft-1", version: 2, status: "draft" },
      followsCurrent: false,
      stale: true,
      lastAssignedAt: "2026-11-20T10:00:00.000Z",
    });
    expect(result.devices[1]).toMatchObject({
      deviceId: "dev-1002",
      deviceCode: null,
      version: null,
      followsCurrent: true,
      stale: false,
      lastAssignedAt: null,
    });
  });

  it("list keeps a pinned snapshot fresh when it is the version that would be assigned now", async () => {
    prisma.device.findMany.mockResolvedValue([
      {
        deviceId: "dev-1001",
        deviceCode: "CN-001",
        testAdventureEpisodeId: "ep1",
        testAdventureEpisodeVersionId: "draft-2",
        testAdventureEpisode: {
          id: "ep1",
          businessKey: "elly/1/1",
          title: "听风原野第一天",
          characterKey: "elly",
          season: 1,
          episodeNumber: 1,
          retiredAt: null,
          currentVersionId: "v3",
        },
        testAdventureEpisodeVersion: {
          id: "draft-2",
          version: 3,
          status: "draft",
        },
      },
    ]);
    prisma.device.count.mockResolvedValue(1);
    prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
      { id: "draft-2", episodeId: "ep1" },
    ]);

    const result = await service.listByCharacter("elly");

    expect(result.devices[0]).toMatchObject({
      followsCurrent: false,
      stale: false,
    });
  });

  it("list does not ask for drafts or audits when nobody is assigned", async () => {
    prisma.device.findMany.mockResolvedValue([]);
    prisma.device.count.mockResolvedValue(0);

    const result = await service.listByCharacter("elly");

    expect(result).toEqual({
      enabled: true,
      characterKey: "elly",
      total: 0,
      devices: [],
    });
    expect(prisma.adventureEpisodeVersion.findMany).not.toHaveBeenCalled();
    expect(prisma.adventureContentAuditLog.findMany).not.toHaveBeenCalled();
  });

  it("list skips a device whose episode relation is missing", async () => {
    prisma.device.findMany.mockResolvedValue([
      {
        deviceId: "dev-1001",
        deviceCode: "CN-001",
        testAdventureEpisodeId: "ep1",
        testAdventureEpisodeVersionId: null,
        testAdventureEpisode: null,
        testAdventureEpisodeVersion: null,
      },
    ]);
    prisma.device.count.mockResolvedValue(1);

    const result = await service.listByCharacter("elly");

    expect(result).toMatchObject({ enabled: true, total: 1, devices: [] });
  });
});
