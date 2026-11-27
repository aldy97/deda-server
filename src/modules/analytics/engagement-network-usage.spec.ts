import { BadRequestException } from "@nestjs/common";
import { EngagementService } from "./engagement.service";

type Row = {
  date: string;
  deviceId: string;
  wifiTurns: number;
  fourGTurns: number;
  unknownTurns: number;
};

function buildService(rows: Row[]) {
  const prisma = {
    conversationNetworkDaily: {
      findMany: jest.fn().mockResolvedValue(rows),
    },
  };
  return {
    prisma,
    service: new EngagementService(prisma as never),
  };
}

describe("EngagementService.getNetworkUsage", () => {
  it("汇总轮次、设备数、覆盖率与按日序列", async () => {
    const { prisma, service } = buildService([
      {
        date: "2026-11-27",
        deviceId: "d2",
        wifiTurns: 0,
        fourGTurns: 0,
        unknownTurns: 1,
      },
      {
        date: "2026-11-26",
        deviceId: "d1",
        wifiTurns: 1,
        fourGTurns: 0,
        unknownTurns: 0,
      },
      {
        date: "2026-11-27",
        deviceId: "d1",
        wifiTurns: 1,
        fourGTurns: 1,
        unknownTurns: 1,
      },
    ]);

    const result = await service.getNetworkUsage({
      startDate: "2026-11-26",
      endDate: "2026-11-27",
    });

    expect(prisma.conversationNetworkDaily.findMany).toHaveBeenCalledWith({
      where: { date: { gte: "2026-11-26", lte: "2026-11-27" } },
      select: {
        date: true,
        deviceId: true,
        wifiTurns: true,
        fourGTurns: true,
        unknownTurns: true,
      },
      orderBy: { date: "asc" },
    });

    expect(result).toMatchObject({
      startDate: "2026-11-26",
      endDate: "2026-11-27",
      totalTurns: 5,
      knownTurns: 3,
      unknownTurns: 2,
      coverage: 0.6,
      deviceCount: 2,
      firstTrackedDate: "2026-11-26",
      wifi: {
        turns: 2,
        devices: 1,
        shareOfKnown: 0.6667,
        shareOfTotal: 0.4,
      },
      fourG: {
        turns: 1,
        devices: 1,
        shareOfKnown: 0.3333,
        shareOfTotal: 0.2,
      },
      unknown: {
        turns: 2,
        devices: 2,
        shareOfTotal: 0.4,
      },
    });

    expect(result.series).toEqual([
      {
        date: "2026-11-26",
        wifiTurns: 1,
        fourGTurns: 0,
        unknownTurns: 0,
        wifiShareOfKnown: 1,
        fourGShareOfKnown: 0,
      },
      {
        date: "2026-11-27",
        wifiTurns: 1,
        fourGTurns: 1,
        unknownTurns: 2,
        wifiShareOfKnown: 0.5,
        fourGShareOfKnown: 0.5,
      },
    ]);
  });

  it("空区间返回 0 与 null，不返回 NaN", async () => {
    const { service } = buildService([]);

    const result = await service.getNetworkUsage({
      startDate: "2026-11-01",
      endDate: "2026-11-02",
    });

    expect(result).toEqual({
      startDate: "2026-11-01",
      endDate: "2026-11-02",
      totalTurns: 0,
      knownTurns: 0,
      unknownTurns: 0,
      coverage: null,
      deviceCount: 0,
      firstTrackedDate: null,
      wifi: {
        turns: 0,
        devices: 0,
        shareOfKnown: null,
        shareOfTotal: null,
      },
      fourG: {
        turns: 0,
        devices: 0,
        shareOfKnown: null,
        shareOfTotal: null,
      },
      unknown: { turns: 0, devices: 0, shareOfTotal: null },
      series: [],
    });
  });

  it("非法日期与倒置区间抛 400", async () => {
    const { service } = buildService([]);

    await expect(
      service.getNetworkUsage({
        startDate: "2026-11-32",
        endDate: "2026-11-27",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.getNetworkUsage({
        startDate: "2026-11-28",
        endDate: "2026-11-27",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
