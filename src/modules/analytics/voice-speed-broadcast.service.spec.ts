import { Test } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import { VOICE_RECONCILE_PORT } from "@/modules/baidu-agent/baidu-agent.types";
import { botCurrentKey } from "@/modules/client-api/client-api.constants";
import { VoiceSpeedBroadcastService } from "./voice-speed-broadcast.service";

const CONFIG = { normalSpd: 0.7, sleepSpd: 0.5 };

function device(mac: string, extra: Record<string, unknown> = {}) {
  return {
    id: `uuid-${mac}`,
    deviceId: mac,
    macAddress: mac,
    characterKey: "elly",
    ...extra,
  };
}

describe("VoiceSpeedBroadcastService", () => {
  let service: VoiceSpeedBroadcastService;
  let prisma: {
    device: { findMany: jest.Mock };
    conversationSession: { findMany: jest.Mock };
  };
  let redis: { mGetValue: jest.Mock };
  let reconcile: {
    getTimbreForCharacter: jest.Mock;
    applySpd: jest.Mock;
  };

  const setActiveInstances = (macs: string[]) => {
    redis.mGetValue.mockImplementation(async (keys: string[]) =>
      keys.map((key) => {
        const mac = key.slice(botCurrentKey("").length);
        return macs.includes(mac) ? `instance-${mac}` : null;
      }),
    );
  };

  beforeEach(async () => {
    prisma = {
      device: { findMany: jest.fn().mockResolvedValue([]) },
      conversationSession: { findMany: jest.fn().mockResolvedValue([]) },
    };
    redis = { mGetValue: jest.fn().mockResolvedValue([]) };
    reconcile = {
      getTimbreForCharacter: jest.fn().mockResolvedValue("1000957"),
      applySpd: jest.fn().mockResolvedValue({ applied: "live" }),
    };

    const module = await Test.createTestingModule({
      providers: [
        VoiceSpeedBroadcastService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: VOICE_RECONCILE_PORT, useValue: reconcile },
      ],
    }).compile();
    service = module.get(VoiceSpeedBroadcastService);
  });

  it("applies normal and sleep speeds to the matching active devices", async () => {
    prisma.device.findMany.mockResolvedValue([
      device("aabbccddee01"),
      device("aabbccddee02"),
      device("aabbccddee03"),
    ]);
    setActiveInstances(["aabbccddee01", "aabbccddee02"]);
    prisma.conversationSession.findMany.mockResolvedValue([
      {
        deviceId: "uuid-aabbccddee02",
        currentMode: "sleep_story",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);

    const result = await service.apply(CONFIG);

    expect(reconcile.applySpd).toHaveBeenNthCalledWith(
      1,
      "aabbccddee01",
      "1000957",
      0.7,
      { force: true },
    );
    expect(reconcile.applySpd).toHaveBeenNthCalledWith(
      2,
      "aabbccddee02",
      "1000957",
      0.5,
      { force: true },
    );
    expect(result).toMatchObject({
      targeted: 2,
      live: 2,
      deferred: 0,
      skipped: 1,
    });
  });

  it("skips devices without a timbre mapping", async () => {
    prisma.device.findMany.mockResolvedValue([device("aabbccddee01")]);
    setActiveInstances(["aabbccddee01"]);
    reconcile.getTimbreForCharacter.mockResolvedValue(null);

    const result = await service.apply(CONFIG);

    expect(reconcile.applySpd).not.toHaveBeenCalled();
    expect(result).toMatchObject({ targeted: 0, skipped: 1 });
  });

  it("only targets the explicit mac list when provided", async () => {
    prisma.device.findMany.mockImplementation(
      async (args: { where?: { deviceId?: { in?: string[] } } }) => {
        const wanted = args.where?.deviceId?.in ?? [];
        return [device("aabbccddee01"), device("aabbccddee02")].filter((item) =>
          wanted.includes(item.deviceId),
        );
      },
    );
    setActiveInstances(["aabbccddee01", "aabbccddee02"]);

    const result = await service.apply(CONFIG, {
      macs: ["AA:BB:CC:DD:EE:01"],
    });

    expect(prisma.device.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deviceId: { in: ["aabbccddee01"] } },
      }),
    );
    expect(reconcile.applySpd).toHaveBeenCalledTimes(1);
    expect(result.targeted).toBe(1);
  });

  it("isolates a per-device failure and keeps processing the rest", async () => {
    prisma.device.findMany.mockResolvedValue([
      device("aabbccddee01"),
      device("aabbccddee02"),
    ]);
    setActiveInstances(["aabbccddee01", "aabbccddee02"]);
    reconcile.applySpd
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ applied: "deferred", reason: "upstream_error" });

    const result = await service.apply(CONFIG);

    expect(result).toMatchObject({
      targeted: 2,
      live: 0,
      deferred: 2,
    });
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: "aabbccddee01",
          applied: "deferred",
          reason: "internal_error",
        }),
        expect.objectContaining({
          deviceId: "aabbccddee02",
          applied: "deferred",
          reason: "upstream_error",
        }),
      ]),
    );
  });

  it("limits in-flight switch calls", async () => {
    const macs = Array.from({ length: 8 }, (_, i) => `aabbccddee0${i + 1}`);
    prisma.device.findMany.mockResolvedValue(macs.map((mac) => device(mac)));
    setActiveInstances(macs);

    let inFlight = 0;
    let peak = 0;
    reconcile.applySpd.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { applied: "live" };
    });

    await service.apply(CONFIG);

    expect(peak).toBeLessThanOrEqual(5);
  });

  it("returns zeroed counts when there are no devices", async () => {
    const result = await service.apply(CONFIG);

    expect(result).toEqual({
      targeted: 0,
      live: 0,
      deferred: 0,
      skipped: 0,
      results: [],
    });
  });
});
