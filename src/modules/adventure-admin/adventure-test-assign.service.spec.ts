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
    device: { findFirst: jest.Mock; update: jest.Mock };
    adventureEpisode: { findUnique: jest.Mock };
    adventureEpisodeVersion: { findFirst: jest.Mock; findUnique: jest.Mock };
    conversationSession: { upsert: jest.Mock };
  };
  let config: { get: jest.Mock };
  let audit: { record: jest.Mock };

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
      },
      conversationSession: { upsert: jest.fn().mockResolvedValue({}) },
    };
    config = { get: jest.fn().mockReturnValue("true") };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new AdventureTestAssignService(
      prisma as never,
      config as never,
      audit as never,
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
    expect(result.assignment).toMatchObject({
      episode: { id: "ep1", title: "听风原野第一天" },
      episodeVersion: { id: "draft-1", status: "draft" },
    });
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
});
