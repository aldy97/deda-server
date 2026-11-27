import { UsersAnalyticsService } from "./users-analytics.service";

function buildService(
  groups: Array<{ phoneBrand: string | null; count: number }>,
  totalUsers: number,
  firstReportedAt: Date | null = null,
) {
  const prisma = {
    user: {
      count: jest.fn().mockResolvedValue(totalUsers),
      groupBy: jest.fn().mockResolvedValue(
        groups.map((g) => ({
          phoneBrand: g.phoneBrand,
          _count: { _all: g.count },
        })),
      ),
      aggregate: jest.fn().mockResolvedValue({
        _min: { phoneBrandReportedAt: firstReportedAt },
      }),
    },
  };
  return { prisma, service: new UsersAnalyticsService(prisma as never) };
}

describe("UsersAnalyticsService.getPhoneBrands", () => {
  it("按厂商归并、算占已上报与占总人数比例、未知单列", async () => {
    const { prisma, service } = buildService(
      [
        { phoneBrand: "Apple", count: 3 },
        { phoneBrand: "HUAWEI", count: 2 },
        { phoneBrand: "Xiaomi", count: 2 },
        { phoneBrand: "Redmi", count: 1 },
        { phoneBrand: "BrandX", count: 1 },
        { phoneBrand: null, count: 1 },
      ],
      10,
      new Date("2026-11-27T01:00:00Z"),
    );

    const result = await service.getPhoneBrands();

    expect(prisma.user.groupBy).toHaveBeenCalledWith({
      by: ["phoneBrand"],
      _count: { _all: true },
    });
    expect(result).toMatchObject({
      totalUsers: 10,
      reportedUsers: 9,
      unknownUsers: 1,
      coverage: 0.9,
      firstReportedAt: "2026-11-27T01:00:00.000Z",
    });

    expect(result.brands).toEqual([
      {
        makerKey: "apple",
        makerLabel: "Apple",
        users: 3,
        shareOfReported: 0.3333,
        shareOfTotal: 0.3,
        rawBrands: [{ brand: "Apple", users: 3 }],
      },
      {
        makerKey: "xiaomi",
        makerLabel: "小米",
        users: 3,
        shareOfReported: 0.3333,
        shareOfTotal: 0.3,
        rawBrands: [
          { brand: "Redmi", users: 1 },
          { brand: "Xiaomi", users: 2 },
        ],
      },
      {
        makerKey: "huawei",
        makerLabel: "华为",
        users: 2,
        shareOfReported: 0.2222,
        shareOfTotal: 0.2,
        rawBrands: [{ brand: "HUAWEI", users: 2 }],
      },
      {
        makerKey: "other",
        makerLabel: "其他",
        users: 1,
        shareOfReported: 0.1111,
        shareOfTotal: 0.1,
        rawBrands: [{ brand: "BrandX", users: 1 }],
      },
    ]);
  });

  it("空用户池返回 0 与 null", async () => {
    const { service } = buildService([], 0);

    const result = await service.getPhoneBrands();

    expect(result).toEqual({
      totalUsers: 0,
      reportedUsers: 0,
      unknownUsers: 0,
      coverage: null,
      firstReportedAt: null,
      brands: [],
    });
  });

  it("全部未上报时 reportedUsers=0、覆盖率为 0", async () => {
    const { service } = buildService([{ phoneBrand: null, count: 4 }], 4);

    const result = await service.getPhoneBrands();

    expect(result.reportedUsers).toBe(0);
    expect(result.unknownUsers).toBe(4);
    expect(result.coverage).toBe(0);
    expect(result.brands).toEqual([]);
  });
});
