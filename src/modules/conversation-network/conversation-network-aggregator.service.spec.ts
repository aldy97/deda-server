import { ConversationNetworkAggregator } from "./conversation-network-aggregator.service";

function buildPrisma() {
  return {
    conversationNetworkDaily: {
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

describe("ConversationNetworkAggregator", () => {
  let prisma: ReturnType<typeof buildPrisma>;
  let aggregator: ConversationNetworkAggregator;

  beforeEach(() => {
    prisma = buildPrisma();
    aggregator = new ConversationNetworkAggregator(prisma as never);
  });

  it("WiFi 轮次首次写入时创建当日行", async () => {
    await aggregator.recordTurn({
      deviceId: "AABBCCDDEEFF",
      networkMode: "wifi",
      spokeAt: new Date("2026-11-27T16:30:00Z"), // 北京 11-28 00:30
    });

    expect(prisma.conversationNetworkDaily.upsert).toHaveBeenCalledWith({
      where: {
        date_deviceId: { date: "2026-11-28", deviceId: "aabbccddeeff" },
      },
      create: {
        date: "2026-11-28",
        deviceId: "aabbccddeeff",
        wifiTurns: 1,
        fourGTurns: 0,
        unknownTurns: 0,
        firstSeenAt: new Date("2026-11-27T16:30:00Z"),
        lastSeenAt: new Date("2026-11-27T16:30:00Z"),
      },
      update: {
        wifiTurns: { increment: 1 },
        lastSeenAt: new Date("2026-11-27T16:30:00Z"),
      },
    });
  });

  it("4G 轮次与未知轮次分别累加对应列", async () => {
    const spokeAt = new Date("2026-11-27T02:00:00Z");
    await aggregator.recordTurn({
      deviceId: "dev-1",
      networkMode: "4g",
      spokeAt,
    });
    await aggregator.recordTurn({
      deviceId: "dev-1",
      networkMode: null,
      spokeAt,
    });

    expect(prisma.conversationNetworkDaily.upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        update: { fourGTurns: { increment: 1 }, lastSeenAt: spokeAt },
      }),
    );
    expect(prisma.conversationNetworkDaily.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        update: { unknownTurns: { increment: 1 }, lastSeenAt: spokeAt },
      }),
    );
  });

  it("空 deviceId 不写库", async () => {
    await aggregator.recordTurn({
      deviceId: "   ",
      networkMode: "wifi",
      spokeAt: new Date(),
    });

    expect(prisma.conversationNetworkDaily.upsert).not.toHaveBeenCalled();
  });

  it("P2002 并发冲突时重试 update 增量", async () => {
    prisma.conversationNetworkDaily.upsert.mockRejectedValue({ code: "P2002" });

    await aggregator.recordTurn({
      deviceId: "dev-1",
      networkMode: "wifi",
      spokeAt: new Date("2026-11-27T02:00:00Z"),
    });

    expect(prisma.conversationNetworkDaily.update).toHaveBeenCalledWith({
      where: {
        date_deviceId: { date: "2026-11-27", deviceId: "dev-1" },
      },
      data: {
        wifiTurns: { increment: 1 },
        lastSeenAt: new Date("2026-11-27T02:00:00Z"),
      },
    });
  });

  it("写库失败只记日志，不向调用方抛错", async () => {
    prisma.conversationNetworkDaily.upsert.mockRejectedValue(
      new Error("db down"),
    );

    await expect(
      aggregator.recordTurn({
        deviceId: "dev-1",
        networkMode: "wifi",
        spokeAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });
});
