import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  DeviceTestAccessService,
  TEST_DEVICE_ENV,
} from "./device-test-access.service";
import { ADVENTURE_TEST_ENV } from "@/modules/adventure/adventure.constants";

/**
 * 测试设备白名单：冒险测试的设备级资格闸。
 *
 * 这里钉住的是「谁能被放开、放开/收回留下什么、环境关时写不进去」四条口径。
 * 页面与 HTTP 层只做转发，真正的安全语义都在本服务。
 */
describe("DeviceTestAccessService", () => {
  const actor = { username: "alice", displayName: "Alice" };

  const device = {
    id: "dev-uuid-1",
    deviceId: "aa:bb:cc:dd:ee:ff",
    deviceCode: "CN-001",
    macAddress: "AA:BB:CC:DD:EE:FF",
    characterKey: "elly",
    firmwareVersion: "1.2.3",
    testAdventureEpisodeId: null as string | null,
    testAdventureEpisodeVersionId: null as string | null,
  };

  let prisma: {
    device: { findFirst: jest.Mock; update: jest.Mock };
    deviceTestWhitelist: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let config: { get: jest.Mock };
  let service: DeviceTestAccessService;

  const whitelistRow = {
    id: "wl-1",
    deviceId: "dev-uuid-1",
    active: true,
    note: "3 号样机",
    addedBy: "alice",
    addedAt: new Date("2026-11-22T10:00:00.000Z"),
    addedReason: "需要验证新一集内容",
    revokedBy: null as string | null,
    revokedAt: null as Date | null,
    revokeReason: null as string | null,
    updatedAt: new Date("2026-11-22T10:00:00.000Z"),
    device,
  };

  beforeEach(() => {
    prisma = {
      device: {
        findFirst: jest.fn().mockResolvedValue(device),
        update: jest.fn().mockResolvedValue({}),
      },
      deviceTestWhitelist: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    );
    config = {
      get: jest.fn((key: string) => {
        if (key === TEST_DEVICE_ENV.adventure) {
          return "true";
        }
        return undefined;
      }),
    };
    service = new DeviceTestAccessService(prisma as never, config as never);
  });

  describe("环境开关常量", () => {
    it("与冒险测试开关逐字一致，避免白名单放行却运行时没开", () => {
      expect(TEST_DEVICE_ENV.adventure).toBe(ADVENTURE_TEST_ENV.enabled);
    });
  });

  describe("isAllowed", () => {
    it("只认 active=true 的行", async () => {
      prisma.deviceTestWhitelist.count.mockResolvedValue(1);

      await expect(service.isAllowed("dev-uuid-1")).resolves.toBe(true);
      expect(prisma.deviceTestWhitelist.count).toHaveBeenCalledWith({
        where: { deviceId: "dev-uuid-1", active: true },
      });
    });

    it("没有行或已撤销都返回 false", async () => {
      prisma.deviceTestWhitelist.count.mockResolvedValue(0);

      await expect(service.isAllowed("dev-uuid-1")).resolves.toBe(false);
    });
  });

  describe("add", () => {
    it("新设备落库，记录添加人与理由", async () => {
      prisma.device.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(device);
      prisma.deviceTestWhitelist.findUnique.mockResolvedValue(null);
      prisma.deviceTestWhitelist.create.mockResolvedValue(whitelistRow);

      await expect(
        service.add(
          {
            deviceId: " CN-001 ",
            note: " 3 号样机 ",
            reason: "需要验证新一集内容",
          },
          actor,
        ),
      ).resolves.toEqual({
        item: expect.objectContaining({
          id: "wl-1",
          active: true,
          addedBy: "alice",
          addedReason: "需要验证新一集内容",
          device: expect.objectContaining({ deviceId: device.deviceId }),
        }),
        reactivated: false,
      });

      expect(prisma.device.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deviceCode: { equals: "CN-001", mode: "insensitive" } },
        }),
      );
      expect(prisma.deviceTestWhitelist.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            deviceId: "dev-uuid-1",
            note: "3 号样机",
            addedBy: "alice",
            addedReason: "需要验证新一集内容",
          },
        }),
      );
    });

    it("已 active 的设备返回 409，不重复写", async () => {
      prisma.deviceTestWhitelist.findUnique.mockResolvedValue(whitelistRow);

      await expect(
        service.add(
          { deviceId: device.deviceId, reason: "需要验证新一集内容" },
          actor,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.deviceTestWhitelist.create).not.toHaveBeenCalled();
      expect(prisma.deviceTestWhitelist.update).not.toHaveBeenCalled();
    });

    it("已撤销的设备原地恢复，并清空撤销痕迹", async () => {
      prisma.deviceTestWhitelist.findUnique.mockResolvedValue({
        ...whitelistRow,
        active: false,
        revokedBy: "bob",
        revokedAt: new Date("2026-11-21T00:00:00.000Z"),
        revokeReason: "临时收回",
      });
      prisma.deviceTestWhitelist.update.mockResolvedValue({
        ...whitelistRow,
        addedAt: new Date("2026-11-22T12:00:00.000Z"),
      });

      const result = await service.add(
        { deviceId: device.deviceId, reason: "重新开始验证新一集" },
        actor,
      );

      expect(result.reactivated).toBe(true);
      expect(prisma.deviceTestWhitelist.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deviceId: "dev-uuid-1" },
          data: expect.objectContaining({
            active: true,
            revokedBy: null,
            revokedAt: null,
            revokeReason: null,
            addedBy: "alice",
          }),
        }),
      );
      expect(prisma.deviceTestWhitelist.create).not.toHaveBeenCalled();
    });

    it("设备不存在返回 404", async () => {
      prisma.device.findFirst.mockResolvedValue(null);

      await expect(
        service.add(
          { deviceId: "no-such-device", reason: "需要验证新一集内容" },
          actor,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("理由不足 8 字直接 400，且不查设备", async () => {
      await expect(
        service.add({ deviceId: device.deviceId, reason: "太短" }, actor),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: "REASON_REQUIRED" }),
      });
      expect(prisma.device.findFirst).not.toHaveBeenCalled();
    });

    it("并发撞唯一索引时翻译成 409", async () => {
      prisma.deviceTestWhitelist.findUnique.mockResolvedValue(null);
      prisma.deviceTestWhitelist.create.mockRejectedValue({ code: "P2002" });

      await expect(
        service.add(
          { deviceId: device.deviceId, reason: "需要验证新一集内容" },
          actor,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("冒险测试开关关时写操作 403（prod 只读）", async () => {
      config.get.mockReturnValue(undefined);

      await expect(
        service.add(
          { deviceId: device.deviceId, reason: "需要验证新一集内容" },
          actor,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.device.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("revoke", () => {
    it("撤销并清空该设备已下发的测试冒险集", async () => {
      prisma.device.findFirst.mockResolvedValue({
        ...device,
        testAdventureEpisodeId: "ep-1",
        testAdventureEpisodeVersionId: "ver-1",
      });
      prisma.deviceTestWhitelist.findUnique.mockResolvedValue(whitelistRow);

      await expect(
        service.revoke(
          { deviceId: device.deviceId, reason: "验证结束，收回资格" },
          actor,
        ),
      ).resolves.toEqual({ ok: true, clearedAdventureAssignment: true });

      expect(prisma.deviceTestWhitelist.update).toHaveBeenCalledWith({
        where: { deviceId: "dev-uuid-1" },
        data: expect.objectContaining({
          active: false,
          revokedBy: "alice",
          revokeReason: "验证结束，收回资格",
        }),
      });
      expect(prisma.device.update).toHaveBeenCalledWith({
        where: { id: "dev-uuid-1" },
        data: {
          testAdventureEpisodeId: null,
          testAdventureEpisodeVersionId: null,
        },
      });
    });

    it("设备本来没有下发时不额外写设备行", async () => {
      prisma.deviceTestWhitelist.findUnique.mockResolvedValue(whitelistRow);

      await expect(
        service.revoke(
          { deviceId: device.deviceId, reason: "验证结束，收回资格" },
          actor,
        ),
      ).resolves.toEqual({ ok: true, clearedAdventureAssignment: false });

      expect(prisma.device.update).not.toHaveBeenCalled();
    });

    it("不在白名单的设备返回 404", async () => {
      prisma.deviceTestWhitelist.findUnique.mockResolvedValue(null);

      await expect(
        service.revoke(
          { deviceId: device.deviceId, reason: "验证结束，收回资格" },
          actor,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("已经撤销过的设备返回 409", async () => {
      prisma.deviceTestWhitelist.findUnique.mockResolvedValue({
        ...whitelistRow,
        active: false,
      });

      await expect(
        service.revoke(
          { deviceId: device.deviceId, reason: "验证结束，收回资格" },
          actor,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.deviceTestWhitelist.update).not.toHaveBeenCalled();
    });

    it("理由不足 8 字直接 400", async () => {
      await expect(
        service.revoke({ deviceId: device.deviceId, reason: "收回" }, actor),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.device.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("默认只看 active，分页参数落到 skip/take", async () => {
      prisma.deviceTestWhitelist.findMany.mockResolvedValue([whitelistRow]);
      prisma.deviceTestWhitelist.count.mockResolvedValue(1);

      const result = await service.list({ page: 2, pageSize: 10 });

      expect(prisma.deviceTestWhitelist.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { active: true },
          skip: 10,
          take: 10,
        }),
      );
      expect(prisma.deviceTestWhitelist.count).toHaveBeenCalledWith({
        where: { active: true },
      });
      expect(result).toEqual({
        enabled: { adventure: true },
        total: 1,
        items: [expect.objectContaining({ id: "wl-1", active: true })],
      });
    });

    it("关键字同时匹配业务设备号 / 设备编码 / MAC", async () => {
      prisma.deviceTestWhitelist.findMany.mockResolvedValue([]);
      prisma.deviceTestWhitelist.count.mockResolvedValue(0);

      await service.list({ keyword: " aa:bb ", includeRevoked: true });

      const arg = prisma.deviceTestWhitelist.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({
        device: {
          is: {
            OR: [
              { deviceId: { contains: "aa:bb", mode: "insensitive" } },
              { deviceCode: { contains: "aa:bb", mode: "insensitive" } },
              { macAddress: { contains: "aa:bb", mode: "insensitive" } },
            ],
          },
        },
      });
      expect(arg.skip).toBe(0);
    });

    it("includeRevoked=true 时不加 active 过滤", async () => {
      await service.list({ includeRevoked: true });

      const arg = prisma.deviceTestWhitelist.findMany.mock.calls[0][0];
      expect(arg.where).toEqual({});
    });

    it("环境开关关时 enabled 如实反映，列表仍可读", async () => {
      config.get.mockReturnValue(undefined);

      await expect(service.list({})).resolves.toEqual({
        enabled: { adventure: false },
        total: 0,
        items: [],
      });
    });

    it("pageSize 超过上限时钳到 200", async () => {
      await service.list({ pageSize: 999 });

      const arg = prisma.deviceTestWhitelist.findMany.mock.calls[0][0];
      expect(arg.take).toBe(200);
    });
  });
});
