import { DeviceNetworkAggregationService } from "./device-network-aggregation.service";

function buildPrisma() {
  return {
    deviceNetworkDaily: {
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

describe("DeviceNetworkAggregationService", () => {
  let prisma: ReturnType<typeof buildPrisma>;
  let service: DeviceNetworkAggregationService;

  beforeEach(() => {
    prisma = buildPrisma();
    service = new DeviceNetworkAggregationService(prisma as never);
  });

  it("内存累加 WiFi/4G/切网心跳，flush 时写当日聚合行", async () => {
    const first = new Date("2026-11-27T16:30:00Z"); // 北京 11-28 00:30
    const last = new Date("2026-11-27T16:35:00Z");
    service.record("AABBCCDDEEFF", "wifi", first);
    service.record("AABBCCDDEEFF", "wifi", last);
    service.record("AABBCCDDEEFF", "4g", last);
    service.record("AABBCCDDEEFF", null, last);

    await service.flush();

    expect(prisma.deviceNetworkDaily.upsert).toHaveBeenCalledWith({
      where: {
        date_deviceId: { date: "2026-11-28", deviceId: "aabbccddeeff" },
      },
      create: {
        date: "2026-11-28",
        deviceId: "aabbccddeeff",
        wifiHeartbeats: 2,
        fourGHeartbeats: 1,
        unknownHeartbeats: 1,
        firstSeenAt: first,
        lastSeenAt: last,
      },
      update: {
        wifiHeartbeats: { increment: 2 },
        fourGHeartbeats: { increment: 1 },
        unknownHeartbeats: { increment: 1 },
        lastSeenAt: last,
      },
    });
  });

  it("老固件缺省 networkMode 不上报，不计数", async () => {
    service.record("dev-1", undefined, new Date());

    await service.flush();

    expect(prisma.deviceNetworkDaily.upsert).not.toHaveBeenCalled();
  });

  it("已 flush 的增量不会重复写", async () => {
    service.record("dev-1", "wifi", new Date("2026-11-27T02:00:00Z"));
    await service.flush();
    prisma.deviceNetworkDaily.upsert.mockClear();

    await service.flush();

    expect(prisma.deviceNetworkDaily.upsert).not.toHaveBeenCalled();
  });

  it("flush 失败不推进 flushed 计数，下次重试同一增量", async () => {
    service.record("dev-1", "wifi", new Date("2026-11-27T02:00:00Z"));
    prisma.deviceNetworkDaily.upsert.mockRejectedValueOnce(
      new Error("db down"),
    );

    await service.flush();
    expect(prisma.deviceNetworkDaily.upsert).toHaveBeenCalledTimes(1);

    await service.flush();
    expect(prisma.deviceNetworkDaily.upsert).toHaveBeenCalledTimes(2);
  });

  it("P2002 并发冲突时走 update 增量", async () => {
    service.record("dev-1", "wifi", new Date("2026-11-27T02:00:00Z"));
    prisma.deviceNetworkDaily.upsert.mockRejectedValueOnce({ code: "P2002" });

    await service.flush();

    expect(prisma.deviceNetworkDaily.update).toHaveBeenCalledWith({
      where: {
        date_deviceId: { date: "2026-11-27", deviceId: "dev-1" },
      },
      data: {
        wifiHeartbeats: { increment: 1 },
        lastSeenAt: new Date("2026-11-27T02:00:00Z"),
      },
    });
  });
});
