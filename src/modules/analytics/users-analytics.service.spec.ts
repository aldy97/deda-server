import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import { UsersAnalyticsService } from "./users-analytics.service";

type Row = Record<string, any>;

function applyDateRange(
  rows: Row[],
  field: string,
  range?: { gte?: Date; lt?: Date },
) {
  if (!range) return rows;
  return rows.filter((row) => {
    const value = row[field] as Date;
    if (range.gte && value < range.gte) return false;
    if (range.lt && value >= range.lt) return false;
    return true;
  });
}

function buildPrisma(data: {
  users: Row[];
  bindings: Row[];
  childProfiles: Row[];
  devices: Row[];
}) {
  return {
    user: {
      count: jest.fn(
        ({ where }: any = {}) =>
          applyDateRange(data.users, "createdAt", where?.createdAt).length,
      ),
      findMany: jest.fn(() => data.users),
    },
    userDeviceBinding: {
      findMany: jest.fn(() => data.bindings),
    },
    childProfile: {
      findMany: jest.fn(({ where }: any = {}) =>
        data.childProfiles.filter(
          (p) => !where?.deviceId?.not || p.deviceId !== null,
        ),
      ),
      groupBy: jest.fn(({ by }: any) => {
        const groups = new Map<string, number>();
        for (const profile of data.childProfiles) {
          const key = by.map((f: string) => profile[f]).join("|");
          groups.set(key, (groups.get(key) ?? 0) + 1);
        }
        return Array.from(groups.entries()).map(([key, count]) => ({
          userId: key,
          _count: { _all: count },
        }));
      }),
    },
    device: {
      findMany: jest.fn(() => data.devices),
    },
  };
}

async function buildService(prisma: any): Promise<UsersAnalyticsService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      UsersAnalyticsService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return module.get(UsersAnalyticsService);
}

describe("UsersAnalyticsService.getSummary", () => {
  it("汇总用户、绑定、多孩家庭；无范围时 newUsersInRange=null", async () => {
    const prisma = buildPrisma({
      users: [
        { id: "u1", createdAt: new Date("2026-11-01T02:00:00Z") },
        { id: "u2", createdAt: new Date("2026-11-03T02:00:00Z") },
        { id: "u3", createdAt: new Date("2026-11-05T02:00:00Z") },
      ],
      bindings: [
        { userId: "u1", deviceId: "d1" },
        { userId: "u1", deviceId: "d2" },
        { userId: "u2", deviceId: "d3" },
      ],
      childProfiles: [
        { userId: "u1", deviceId: "d1" },
        { userId: "u1", deviceId: "d2" },
        { userId: "u2", deviceId: "d3" },
      ],
      devices: [],
    });
    const service = await buildService(prisma);

    const all = await service.getSummary({});
    expect(all.totalUsers).toBe(3);
    expect(all.newUsersInRange).toBeNull();
    expect(all.usersWithBoundDevice).toBe(2);
    expect(all.avgDevicesPerUser).toBe(1.5);
    expect(all.multiChildFamilies).toBe(1); // u1 有两个孩子档案

    const ranged = await service.getSummary({
      startDate: "2026-11-02",
      endDate: "2026-11-04",
    });
    expect(ranged.newUsersInRange).toBe(1); // u2
  });

  it("非法日期返回 400", async () => {
    const prisma = buildPrisma({
      users: [],
      bindings: [],
      childProfiles: [],
      devices: [],
    });
    const service = await buildService(prisma);

    await expect(
      service.getSummary({ startDate: "2026-13-01" }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.getSummary({
        startDate: "2026-11-06",
        endDate: "2026-11-04",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("multiDeviceFamilies：1 台不算、2 台算、0 台不算，且不新增查询", async () => {
    const prisma = buildPrisma({
      users: [
        { id: "u1", createdAt: new Date("2026-11-01T02:00:00Z") },
        { id: "u2", createdAt: new Date("2026-11-01T02:00:00Z") },
        { id: "u3", createdAt: new Date("2026-11-01T02:00:00Z") },
        { id: "u4", createdAt: new Date("2026-11-01T02:00:00Z") },
      ],
      bindings: [
        { userId: "u1", deviceId: "d1" },
        { userId: "u2", deviceId: "d2" },
        { userId: "u2", deviceId: "d3" },
        { userId: "u3", deviceId: "d4" },
        // u4 无绑定：0 台，不算多设备家庭
      ],
      childProfiles: [],
      devices: [],
    });
    const service = await buildService(prisma);

    const result = await service.getSummary({});

    expect(result.multiDeviceFamilies).toBe(1);
    expect(prisma.userDeviceBinding.findMany).toHaveBeenCalledTimes(1);
    // 既有字段与顺序不变，只追加 multiDeviceFamilies
    expect(Object.keys(result).sort()).toEqual([
      "avgDevicesPerUser",
      "multiChildFamilies",
      "multiDeviceFamilies",
      "newUsersInRange",
      "totalUsers",
      "usersWithBoundDevice",
    ]);
  });
});

describe("UsersAnalyticsService.getDemographics", () => {
  it("年龄段/性别/型号/绑定数分布；无生日计入 unknown", async () => {
    const today = new Date();
    const fourYearsAgo = `${today.getFullYear() - 4}-01-01`;
    const prisma = buildPrisma({
      users: [],
      bindings: [
        { userId: "u1", deviceId: "d1" },
        { userId: "u1", deviceId: "d2" },
        { userId: "u2", deviceId: "d2" },
        { userId: "u3", deviceId: "d2" },
        { userId: "u4", deviceId: "d3" },
      ],
      childProfiles: [
        {
          userId: "u1",
          deviceId: "d1",
          birthday: fourYearsAgo,
          gender: "male",
        },
        { userId: "u1", deviceId: "d2", birthday: null, gender: null },
      ],
      devices: [
        { id: "d1", characterKey: "elly" },
        { id: "d2", characterKey: "polly" },
        { id: "d3", characterKey: "elly" },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.getDemographics();

    const byRange = new Map(
      result.ageDistribution.map((a) => [a.range, a.devices]),
    );
    expect(byRange.get("3-6")).toBe(1);
    expect(byRange.get("unknown")).toBe(1);

    expect(result.genderSplit).toEqual({ male: 1, female: 0, unset: 1 });
    expect(result.characterKeySplit[0]).toEqual({
      characterKey: "elly",
      devices: 2,
    });
    const byCount = new Map(
      result.bindingsPerDevice.map((b) => [String(b.count), b.devices]),
    );
    expect(byCount.get("1")).toBe(2); // d1、d3
    expect(byCount.get("3+")).toBe(1); // d2 三个绑定
  });

  it("getDemographics female 与绑定数=2", async () => {
    const prisma = buildPrisma({
      users: [],
      bindings: [
        { userId: "u1", deviceId: "d1" },
        { userId: "u2", deviceId: "d1" },
      ],
      childProfiles: [
        {
          userId: "u1",
          deviceId: "d1",
          birthday: "2020-01-01",
          gender: "female",
        },
        { userId: "u2", deviceId: "d1", birthday: "2025-01-01", gender: null },
      ],
      devices: [{ id: "d1", characterKey: "elly" }],
    });
    const service = await buildService(prisma);
    const result = await service.getDemographics();
    expect(result.genderSplit.female).toBe(1);
    const byCount = new Map(
      result.bindingsPerDevice.map((b) => [String(b.count), b.devices]),
    );
    expect(byCount.get("2")).toBe(1);
  });

  it("getDemographics 非法生日 → unknown", async () => {
    const prisma = buildPrisma({
      users: [],
      bindings: [{ userId: "u1", deviceId: "d1" }],
      childProfiles: [
        { userId: "u1", deviceId: "d1", birthday: "not-a-date", gender: null },
      ],
      devices: [{ id: "d1", characterKey: "elly" }],
    });
    const service = await buildService(prisma);
    const result = await service.getDemographics();
    const byRange = new Map(
      result.ageDistribution.map((a) => [a.range, a.devices]),
    );
    expect(byRange.get("unknown")).toBe(1);
  });
});

describe("边界补测", () => {
  it("getSummary 无绑定设备 → avgDevicesPerUser 0", async () => {
    const prisma = buildPrisma({
      users: [],
      bindings: [],
      childProfiles: [],
      devices: [],
    });
    const service = await buildService(prisma);
    const result = await service.getSummary({});
    expect(result.usersWithBoundDevice).toBe(0);
    expect(result.avgDevicesPerUser).toBe(0);
  });

  it("未来生日 → unknown（年龄为负）", async () => {
    const futureYear = new Date().getFullYear() + 1;
    const prisma = buildPrisma({
      users: [],
      bindings: [{ userId: "u1", deviceId: "d1" }],
      childProfiles: [
        {
          userId: "u1",
          deviceId: "d1",
          birthday: `${futureYear}-01-01`,
          gender: null,
        },
      ],
      devices: [{ id: "d1", characterKey: "elly" }],
    });
    const service = await buildService(prisma);
    const result = await service.getDemographics();
    const byRange = new Map(
      result.ageDistribution.map((a) => [a.range, a.devices]),
    );
    expect(byRange.get("unknown")).toBe(1);
  });
});

describe("UsersAnalyticsService.getParentDemographics", () => {
  /** 取一个稳定落在目标年龄的生日（5 月，避开跨年边界）。 */
  function birthdayForAge(age: number): string {
    const year = new Date().getFullYear() - age;
    return `${year}-05-01`;
  }

  it("按家长账号统计性别与年龄段，生日缺失/非法归 unknown", async () => {
    const prisma = buildPrisma({
      users: [
        { gender: "male", birthday: birthdayForAge(17) },
        { gender: "female", birthday: birthdayForAge(18) },
        { gender: "female", birthday: birthdayForAge(24) },
        { gender: null, birthday: birthdayForAge(25) },
        { gender: "male", birthday: birthdayForAge(34) },
        { gender: "female", birthday: birthdayForAge(35) },
        { gender: "male", birthday: birthdayForAge(44) },
        { gender: "female", birthday: birthdayForAge(45) },
        { gender: null, birthday: null },
        { gender: "male", birthday: "not-a-date" },
      ],
      bindings: [],
      childProfiles: [],
      devices: [],
    });
    const service = await buildService(prisma);

    const result = await service.getParentDemographics();
    const byRange = new Map(
      result.ageDistribution.map((item) => [item.range, item.users]),
    );

    expect(result.totalUsers).toBe(10);
    expect(result.genderSplit).toEqual({ male: 4, female: 4, unset: 2 });
    expect(byRange.get("<18")).toBe(1);
    expect(byRange.get("18-24")).toBe(2);
    expect(byRange.get("25-34")).toBe(2);
    expect(byRange.get("35-44")).toBe(2);
    expect(byRange.get("45+")).toBe(1);
    expect(byRange.get("unknown")).toBe(2);
  });

  it("空表返回全零分布，unknown 桶仍存在", async () => {
    const prisma = buildPrisma({
      users: [],
      bindings: [],
      childProfiles: [],
      devices: [],
    });
    const service = await buildService(prisma);

    const result = await service.getParentDemographics();

    expect(result.totalUsers).toBe(0);
    expect(result.genderSplit).toEqual({ male: 0, female: 0, unset: 0 });
    expect(result.ageDistribution.map((item) => item.range)).toEqual([
      "<18",
      "18-24",
      "25-34",
      "35-44",
      "45+",
      "unknown",
    ]);
    expect(result.ageDistribution.every((item) => item.users === 0)).toBe(true);
  });
});
