import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { AdventureAuditService, AuditActor } from "./adventure-audit.service";
import { AdventureService } from "@/modules/adventure/adventure.service";
import { AdventureTestAccessService } from "@/modules/adventure/adventure-test-access.service";
import { ADVENTURE_TEST_DEFAULTS } from "@/modules/adventure/adventure.constants";
import { AdventureDeviceTestService } from "./adventure-device-test.service";

/**
 * 管理台试播服务的单测：钉住环境闸、设备/标题校验、审计归属与
 * 「审计写失败不吞结果」的口径（与 recordRecoveryAction 一致）。
 */
describe("AdventureDeviceTestService", () => {
  let service: AdventureDeviceTestService;
  let prisma: {
    device: { findFirst: jest.Mock; findMany: jest.Mock };
    conversationSession: { upsert: jest.Mock };
    adventureEpisode: { findMany: jest.Mock };
    adventureEvent: { findMany: jest.Mock };
  };
  let adventure: {
    armTestSessionByTitle: jest.Mock;
    restartTestRun: jest.Mock;
  };
  let testAccess: {
    isEnabled: jest.Mock;
    listArmed: jest.Mock;
    peek: jest.Mock;
    clear: jest.Mock;
  };
  let audit: { record: jest.Mock };

  const actor: AuditActor = {
    username: "alice",
    displayName: "Alice",
    profile: "authoring",
  };

  const session = {
    deviceInternalId: "dev-internal-1",
    episodeId: "ep1",
    episodeVersionId: null,
    title: "听风原野第一天",
    source: "admin_api" as const,
    armedBy: "alice",
    runSeq: 2,
    armedAt: "2026-11-20T00:00:00.000Z",
    expiresAt: "2026-11-20T02:00:00.000Z",
  };

  beforeEach(() => {
    prisma = {
      device: {
        findFirst: jest.fn().mockResolvedValue({
          id: "dev-internal-1",
          deviceId: "dev-1001",
          deviceCode: "CN-001",
          characterKey: "elly",
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      conversationSession: { upsert: jest.fn().mockResolvedValue({}) },
      adventureEpisode: { findMany: jest.fn().mockResolvedValue([]) },
      adventureEvent: { findMany: jest.fn().mockResolvedValue([]) },
    };
    adventure = {
      armTestSessionByTitle: jest.fn().mockResolvedValue(session),
      restartTestRun: jest.fn().mockResolvedValue(session),
    };
    testAccess = {
      isEnabled: jest.fn().mockReturnValue(true),
      listArmed: jest.fn().mockResolvedValue([]),
      peek: jest.fn().mockResolvedValue(null),
      clear: jest.fn().mockResolvedValue(undefined),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new AdventureDeviceTestService(
      prisma as never,
      adventure as never,
      testAccess as never,
      audit as never,
    );
  });

  it("state reports disabled with an empty session list when the env gate is off", async () => {
    testAccess.isEnabled.mockReturnValue(false);

    await expect(service.state()).resolves.toEqual({
      enabled: false,
      ttlMinutes: ADVENTURE_TEST_DEFAULTS.sessionTtlMinutes,
      sessions: [],
    });
    expect(testAccess.listArmed).not.toHaveBeenCalled();
  });

  it("state joins armed sessions with device and episode info", async () => {
    testAccess.listArmed.mockResolvedValue([session]);
    prisma.device.findMany.mockResolvedValue([
      {
        id: "dev-internal-1",
        deviceId: "dev-1001",
        deviceCode: "CN-001",
        characterKey: "elly",
      },
    ]);
    prisma.adventureEpisode.findMany.mockResolvedValue([
      {
        id: "ep1",
        title: "听风原野第一天",
        episodeNumber: 1,
        characterKey: "elly",
        season: 1,
        currentVersionId: null,
      },
    ]);

    const result = await service.state();

    expect(result.enabled).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      device: {
        id: "dev-internal-1",
        deviceId: "dev-1001",
        deviceCode: "CN-001",
      },
      episode: { id: "ep1", title: "听风原野第一天", episodeNumber: 1 },
      runSeq: 2,
      armedBy: "alice",
      source: "admin_api",
    });
  });

  it("refuses all writes when the env gate is off", async () => {
    testAccess.isEnabled.mockReturnValue(false);

    await expect(
      service.arm(
        {
          deviceId: "dev-1001",
          title: "听风原野第一天",
          reason: "测试环境验收这一集",
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.restart("dev-1001", actor, "手动重开验证重玩"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.clear("dev-1001", actor, "验收完成解除武装"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("404s when the device is unknown", async () => {
    prisma.device.findFirst.mockResolvedValue(null);

    await expect(
      service.arm(
        {
          deviceId: "dev-404",
          title: "听风原野第一天",
          reason: "测试环境验收这一集",
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("400s when the title resolves to no episode", async () => {
    adventure.armTestSessionByTitle.mockResolvedValue(null);

    await expect(
      service.arm(
        {
          deviceId: "dev-1001",
          title: "不存在的故事",
          reason: "测试环境验收这一集",
        },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("rejects a too-short reason via assertReason before touching anything", async () => {
    await expect(
      service.arm(
        { deviceId: "dev-1001", title: "听风原野第一天", reason: "短" },
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(adventure.armTestSessionByTitle).not.toHaveBeenCalled();
  });

  it("arms a device, resets its sticky session and leaves an audit row", async () => {
    const result = await service.arm(
      {
        deviceId: "dev-1001",
        title: "听风原野第一天",
        reason: "测试环境验收这一集",
      },
      actor,
    );

    expect(adventure.armTestSessionByTitle).toHaveBeenCalledWith(
      "dev-internal-1",
      "听风原野第一天",
      { source: "admin_api", armedBy: "alice" },
    );
    expect(prisma.conversationSession.upsert).toHaveBeenCalledWith({
      where: { deviceId: "dev-internal-1" },
      create: {
        deviceId: "dev-internal-1",
        currentMode: "free_chat",
        expiresAt: null,
      },
      update: { currentMode: "free_chat", expiresAt: null },
    });
    expect(audit.record).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        action: "device_test_arm",
        entityType: "device",
        businessKey: "dev-1001",
        reason: "测试环境验收这一集",
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.audited).toBe(true);
  });

  it("still succeeds with audited=false when the audit write fails", async () => {
    audit.record.mockRejectedValue(new Error("db down"));

    const result = await service.arm(
      {
        deviceId: "dev-1001",
        title: "听风原野第一天",
        reason: "测试环境验收这一集",
      },
      actor,
    );

    expect(result.ok).toBe(true);
    expect(result.audited).toBe(false);
  });

  it("still succeeds with audited=false when the sticky-session reset fails", async () => {
    prisma.conversationSession.upsert.mockRejectedValue(new Error("db down"));

    const result = await service.arm(
      {
        deviceId: "dev-1001",
        title: "听风原野第一天",
        reason: "测试环境验收这一集",
      },
      actor,
    );

    expect(result.ok).toBe(true);
  });

  it("400s on restart when nothing is armed", async () => {
    adventure.restartTestRun.mockResolvedValue(null);

    await expect(
      service.restart("dev-1001", actor, "手动重开验证重玩"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("restarts an armed run and leaves an audit row", async () => {
    const result = await service.restart("dev-1001", actor, "手动重开验证重玩");

    expect(adventure.restartTestRun).toHaveBeenCalledWith("dev-internal-1");
    expect(audit.record).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ action: "device_test_restart" }),
    );
    expect(result.ok).toBe(true);
  });

  it("clears a session idempotently and leaves an audit row", async () => {
    testAccess.peek.mockResolvedValue(session);

    const result = await service.clear("dev-1001", actor, "验收完成解除武装");

    expect(testAccess.clear).toHaveBeenCalledWith("dev-internal-1");
    expect(audit.record).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ action: "device_test_clear" }),
    );
    expect(result.ok).toBe(true);
  });

  it("sessionDetail returns the session and recent test events", async () => {
    testAccess.peek.mockResolvedValue(session);
    prisma.adventureEvent.findMany.mockResolvedValue([
      {
        eventType: "completed",
        eventKey: "daily:d:completed:run:1",
        createdAt: new Date(),
      },
    ]);

    const result = await service.sessionDetail("dev-1001");

    expect(testAccess.peek).toHaveBeenCalledWith("dev-internal-1");
    expect(result.session?.runSeq).toBe(2);
    expect(result.recentEvents).toHaveLength(1);
    expect(prisma.adventureEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deviceId: "dev-internal-1",
          payload: { path: ["test"], equals: true },
        }),
      }),
    );
  });

  it("sessionDetail returns session null for an unarmed device", async () => {
    const result = await service.sessionDetail("dev-1001");

    expect(result.session).toBeNull();
  });
});
