import { ParentsAnalyticsService } from "./parents-analytics.service";

function buildPrisma(options: {
  user?: Record<string, unknown> | null;
  bindings?: any[];
  feedbackCount?: number;
  presence?: Array<{ deviceId: string; date: string }>;
}) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(options.user ?? null),
    },
    userDeviceBinding: {
      findMany: jest.fn().mockResolvedValue(options.bindings ?? []),
    },
    feedback: {
      count: jest.fn().mockResolvedValue(options.feedbackCount ?? 0),
    },
    devicePresenceDaily: {
      groupBy: jest.fn(async ({ where }: any) => {
        const rows = options.presence ?? [];
        const result = new Map<string, string>();
        for (const row of rows) {
          if (
            where?.deviceId?.in &&
            !where.deviceId.in.includes(row.deviceId)
          ) {
            continue;
          }
          const current = result.get(row.deviceId);
          if (!current || row.date > current)
            result.set(row.deviceId, row.date);
        }
        return Array.from(result.entries()).map(([deviceId, date]) => ({
          deviceId,
          _max: { date },
        }));
      }),
    },
  };
  return { prisma, service: new ParentsAnalyticsService(prisma as never) };
}

function binding(overrides: {
  device: Record<string, unknown>;
  isOwner?: boolean;
  createdAt?: Date;
}) {
  return {
    isOwner: overrides.isOwner ?? true,
    createdAt: overrides.createdAt ?? new Date("2026-11-01T02:00:00Z"),
    device: {
      id: "d-internal",
      deviceId: "dev-1",
      deviceCode: null,
      characterKey: "elly",
      firmwareVersion: null,
      networkType: null,
      childProfile: null,
      bindings: [{ userId: "u1" }],
      ...overrides.device,
    },
  };
}

describe("ParentsAnalyticsService.getParentDetail", () => {
  const user = {
    id: "u1",
    nickname: "熊熊妈妈",
    phone: "13800000000",
    phoneBrand: "iPhone15,2",
    createdAt: new Date("2026-10-01T02:00:00Z"),
  };

  it("家长不存在返回 null", async () => {
    const { service } = buildPrisma({ user: null });

    await expect(service.getParentDetail("missing")).resolves.toBeNull();
  });

  it("多设备聚合：排序、boundUserCount、presence、childProfile、计数", async () => {
    const { prisma, service } = buildPrisma({
      user,
      feedbackCount: 3,
      bindings: [
        binding({
          device: {
            id: "d2-internal",
            deviceId: "dev-2",
            characterKey: "polly",
            childProfile: null,
            bindings: [{ userId: "u1" }],
          },
          createdAt: new Date("2026-11-03T02:00:00Z"),
        }),
        binding({
          device: {
            id: "d1-internal",
            deviceId: "dev-1",
            deviceCode: "DEV001",
            firmwareVersion: "1.2.3",
            networkType: "wifi",
            childProfile: {
              name: "小明",
              englishName: "Ming",
              gender: "male",
              birthday: "2021-05-04",
            },
            bindings: [{ userId: "u1" }, { userId: "u2" }],
          },
          createdAt: new Date("2026-11-02T02:00:00Z"),
        }),
      ],
      presence: [
        { deviceId: "d1-internal", date: "2026-11-20" },
        { deviceId: "d1-internal", date: "2026-11-22" },
        { deviceId: "d1-internal", date: "2026-11-21" },
      ],
    });

    const result = await service.getParentDetail("u1");

    expect(prisma.userDeviceBinding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1" },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
    );
    expect(prisma.feedback.count).toHaveBeenCalledWith({
      where: { userId: "u1" },
    });

    expect(result).toEqual({
      user: {
        id: "u1",
        nickname: "熊熊妈妈",
        phone: "13800000000",
        registeredAt: "2026-10-01T02:00:00.000Z",
        // 与 /analytics/users/phone-brands 同一口径：下发展示名 makerLabel
        phoneMaker: "Apple",
      },
      summary: { deviceCount: 2, childCount: 1, feedbackCount: 3 },
      devices: [
        {
          deviceId: "dev-2",
          deviceCode: null,
          characterKey: "polly",
          firmwareVersion: null,
          networkType: null,
          isOwner: true,
          boundAt: "2026-11-03T02:00:00.000Z",
          boundUserCount: 1,
          lastPresenceDate: null,
          childProfile: null,
        },
        {
          deviceId: "dev-1",
          deviceCode: "DEV001",
          characterKey: "elly",
          firmwareVersion: "1.2.3",
          networkType: "wifi",
          isOwner: true,
          boundAt: "2026-11-02T02:00:00.000Z",
          boundUserCount: 2,
          lastPresenceDate: "2026-11-22",
          childProfile: {
            name: "小明",
            englishName: "Ming",
            gender: "male",
            birthday: "2021-05-04",
          },
        },
      ],
    });
  });

  it("响应里没有任何 openid（对象键锁死，全 JSON 不含）", async () => {
    const { service } = buildPrisma({
      user,
      bindings: [
        binding({
          device: {
            id: "d1-internal",
            deviceId: "dev-1",
            childProfile: {
              name: null,
              englishName: null,
              gender: null,
              birthday: null,
            },
          },
        }),
      ],
    });

    const result = await service.getParentDetail("u1");

    expect(Object.keys(result!.user).sort()).toEqual([
      "id",
      "nickname",
      "phone",
      "phoneMaker",
      "registeredAt",
    ]);
    expect(result!.user).not.toHaveProperty("openid");
    expect(JSON.stringify(result)).not.toContain("openid");
  });

  it("0 台设备：devices 为空数组，计数为 0，不查 presence", async () => {
    const { prisma, service } = buildPrisma({
      user: { ...user, phoneBrand: null, phone: null, nickname: null },
      bindings: [],
      feedbackCount: 0,
    });

    const result = await service.getParentDetail("u1");

    expect(result).toEqual({
      user: {
        id: "u1",
        nickname: null,
        phone: null,
        registeredAt: "2026-10-01T02:00:00.000Z",
        phoneMaker: null,
      },
      summary: { deviceCount: 0, childCount: 0, feedbackCount: 0 },
      devices: [],
    });
    expect(prisma.devicePresenceDaily.groupBy).not.toHaveBeenCalled();
  });

  it("childProfile 未填写的字段按 null 下发", async () => {
    const { service } = buildPrisma({
      user,
      bindings: [
        binding({
          device: {
            childProfile: {
              name: null,
              englishName: "Ming",
              gender: null,
              birthday: null,
            },
          },
        }),
      ],
    });

    const result = await service.getParentDetail("u1");

    expect(result!.devices[0].childProfile).toEqual({
      name: null,
      englishName: "Ming",
      gender: null,
      birthday: null,
    });
    expect(result!.summary.childCount).toBe(1);
  });
});
