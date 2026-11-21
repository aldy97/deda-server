import { Test } from "@nestjs/testing";
import { SleepModeService } from "./sleep-mode.service";
import { SLEEP_MODE_SPEED, SLEEP_MODE_VOLUME_CAP } from "./sleep-mode.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import { DeviceLinkService } from "@/modules/device-link/device-link.service";
import { VOICE_RECONCILE_PORT } from "@/modules/baidu-agent/baidu-agent.types";

const DEVICE_ID = "device-uuid-001";
const DEVICE_ROW = {
  id: DEVICE_ID,
  macAddress: "AABBCCDDEEFF",
  deviceId: "aabbccddeeff",
  characterKey: "elly",
};

describe("SleepModeService", () => {
  let service: SleepModeService;

  const prisma = {
    device: { findUnique: jest.fn() },
  };
  const deviceLink = {
    getStatus: jest.fn(),
    setVolume: jest.fn(),
  };
  const redis = {
    getValue: jest.fn(),
    setValue: jest.fn(),
    deleteValue: jest.fn(),
  };
  const voiceReconcile = {
    getTimbreForCharacter: jest.fn(),
    applySpd: jest.fn(),
    readDesired: jest.fn(),
    resolveSpd: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.device.findUnique.mockResolvedValue(DEVICE_ROW);
    const module = await Test.createTestingModule({
      providers: [
        SleepModeService,
        { provide: PrismaService, useValue: prisma },
        { provide: DeviceLinkService, useValue: deviceLink },
        { provide: RedisService, useValue: redis },
        { provide: VOICE_RECONCILE_PORT, useValue: voiceReconcile },
      ],
    }).compile();
    service = module.get(SleepModeService);
  });

  it("exposes the sleep-mode speed constant as 0.5", () => {
    expect(SLEEP_MODE_SPEED).toBe(0.5);
  });

  describe("enter", () => {
    it("快照当前音量并把音量压到 50 上限（当前 80 → 快照 80 + 下发 50）", async () => {
      deviceLink.getStatus.mockResolvedValue({ volume: 80 });

      await service.enter(DEVICE_ID);

      expect(redis.setValue).toHaveBeenCalledWith(
        expect.stringContaining("AABBCCDDEEFF"),
        JSON.stringify({ volume: 80 }),
        expect.any(Number),
      );
      expect(deviceLink.setVolume).toHaveBeenCalledWith("AABBCCDDEEFF", 50);
    });

    it("当前音量低于上限时不抬升（当前 30 → 快照 30 + 下发 30）", async () => {
      deviceLink.getStatus.mockResolvedValue({ volume: 30 });

      await service.enter(DEVICE_ID);

      expect(redis.setValue).toHaveBeenCalledWith(
        expect.stringContaining("AABBCCDDEEFF"),
        JSON.stringify({ volume: 30 }),
        expect.any(Number),
      );
      expect(deviceLink.setVolume).toHaveBeenCalledWith("AABBCCDDEEFF", 30);
    });

    it("当前音量未知时快照 null 并下发 50", async () => {
      deviceLink.getStatus.mockResolvedValue({ volume: null });

      await service.enter(DEVICE_ID);

      expect(redis.setValue).toHaveBeenCalledWith(
        expect.stringContaining("AABBCCDDEEFF"),
        JSON.stringify({ volume: null }),
        expect.any(Number),
      );
      expect(deviceLink.setVolume).toHaveBeenCalledWith("AABBCCDDEEFF", 50);
    });

    it("有音色时切音速到 0.5", async () => {
      deviceLink.getStatus.mockResolvedValue({ volume: 80 });
      voiceReconcile.getTimbreForCharacter.mockReturnValue("1000957");

      await service.enter(DEVICE_ID);

      expect(voiceReconcile.applySpd).toHaveBeenCalledWith(
        "AABBCCDDEEFF",
        "1000957",
        SLEEP_MODE_SPEED,
      );
    });

    it("无音色时不切音速（不抛错）", async () => {
      deviceLink.getStatus.mockResolvedValue({ volume: 80 });
      voiceReconcile.getTimbreForCharacter.mockReturnValue(null);

      await expect(service.enter(DEVICE_ID)).resolves.toBeUndefined();
      expect(voiceReconcile.applySpd).not.toHaveBeenCalled();
    });

    it("设备不存在时静默返回", async () => {
      prisma.device.findUnique.mockResolvedValue(null);

      await expect(service.enter(DEVICE_ID)).resolves.toBeUndefined();
      expect(deviceLink.setVolume).not.toHaveBeenCalled();
    });

    it("macAddress 为空时用 deviceId 兜底", async () => {
      prisma.device.findUnique.mockResolvedValue({
        ...DEVICE_ROW,
        macAddress: null,
      });
      deviceLink.getStatus.mockResolvedValue({ volume: 80 });
      voiceReconcile.getTimbreForCharacter.mockReturnValue(null);

      await service.enter(DEVICE_ID);

      expect(deviceLink.setVolume).toHaveBeenCalledWith(
        "aabbccddeeff",
        SLEEP_MODE_VOLUME_CAP,
      );
    });

    it("编排异常时吞掉不抛错（getStatus 抛错）", async () => {
      deviceLink.getStatus.mockRejectedValue(new Error("mqtt down"));

      await expect(service.enter(DEVICE_ID)).resolves.toBeUndefined();
    });
  });

  describe("exit", () => {
    it("恢复快照音量", async () => {
      redis.getValue.mockResolvedValue(JSON.stringify({ volume: 80 }));
      voiceReconcile.getTimbreForCharacter.mockReturnValue(null);

      await service.exit(DEVICE_ID);

      expect(deviceLink.setVolume).toHaveBeenCalledWith("AABBCCDDEEFF", 80);
    });

    it("快照音量为 null 时不恢复音量", async () => {
      redis.getValue.mockResolvedValue(JSON.stringify({ volume: null }));
      voiceReconcile.getTimbreForCharacter.mockReturnValue(null);

      await service.exit(DEVICE_ID);

      expect(deviceLink.setVolume).not.toHaveBeenCalled();
    });

    it("无快照时不恢复音量（不抛错）", async () => {
      redis.getValue.mockResolvedValue(null);
      voiceReconcile.getTimbreForCharacter.mockReturnValue(null);

      await expect(service.exit(DEVICE_ID)).resolves.toBeUndefined();
      expect(deviceLink.setVolume).not.toHaveBeenCalled();
    });

    it("有音色时切回档位音速", async () => {
      redis.getValue.mockResolvedValue(JSON.stringify({ volume: 80 }));
      voiceReconcile.getTimbreForCharacter.mockReturnValue("1000957");
      voiceReconcile.readDesired.mockResolvedValue({
        vcn: "1000957",
        speechRate: "slow",
      });
      voiceReconcile.resolveSpd.mockReturnValue(0.8);

      await service.exit(DEVICE_ID);

      expect(voiceReconcile.applySpd).toHaveBeenCalledWith(
        "AABBCCDDEEFF",
        "1000957",
        0.8,
      );
    });

    it("档位无法解析时回落基础语速 1", async () => {
      redis.getValue.mockResolvedValue(JSON.stringify({ volume: 80 }));
      voiceReconcile.getTimbreForCharacter.mockReturnValue("1000957");
      voiceReconcile.readDesired.mockResolvedValue({
        vcn: null,
        speechRate: null,
      });
      voiceReconcile.resolveSpd.mockReturnValue(null);

      await service.exit(DEVICE_ID);

      expect(voiceReconcile.applySpd).toHaveBeenCalledWith(
        "AABBCCDDEEFF",
        "1000957",
        1,
      );
    });

    it("无音色时不切音速，但仍删快照", async () => {
      redis.getValue.mockResolvedValue(JSON.stringify({ volume: 80 }));
      voiceReconcile.getTimbreForCharacter.mockReturnValue(null);

      await service.exit(DEVICE_ID);

      expect(voiceReconcile.applySpd).not.toHaveBeenCalled();
      expect(redis.deleteValue).toHaveBeenCalledWith(
        expect.stringContaining("AABBCCDDEEFF"),
      );
    });

    it("设备不存在时静默返回", async () => {
      prisma.device.findUnique.mockResolvedValue(null);

      await expect(service.exit(DEVICE_ID)).resolves.toBeUndefined();
      expect(redis.deleteValue).not.toHaveBeenCalled();
    });

    it("编排异常时吞掉不抛错（getValue 抛错）", async () => {
      redis.getValue.mockRejectedValue(new Error("redis down"));

      await expect(service.exit(DEVICE_ID)).resolves.toBeUndefined();
    });
  });
});
