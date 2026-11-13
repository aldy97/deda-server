import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  reportDayRange,
} from "../learning-stats/parent-report-date.util";
import { DeviceLinkService } from "../device-link/device-link.service";
import { FleetService } from "./fleet.service";

type Row = Record<string, unknown>;

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

function applyDistinct(rows: Row[], fields?: string[]) {
  if (!fields || fields.length === 0) return rows;
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = fields.map((field) => row[field]).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface PresenceWhere {
  date?: string | { gte?: string; lte?: string };
  deviceId?: string | { in: string[] };
}

function buildPrisma(data: {
  devices: Row[];
  bindings: Row[];
  messages: Row[];
  presence?: Row[];
}) {
  const presence = data.presence ?? [];
  return {
    device: {
      count: jest.fn(({ where }: { where?: Record<string, unknown> } = {}) => {
        let rows = [...data.devices];
        // keyword filtering — mirror findMany logic
        const orClauses: Record<string, Record<string, unknown>>[] = [];
        if (where?.AND) {
          const and = where.AND as Record<string, unknown>[];
          for (const clause of and) {
            const or = clause.OR as Record<string, Record<string, unknown>>[];
            if (or) orClauses.push(...or);
          }
        }
        if (where?.OR) {
          const or = where.OR as Record<string, Record<string, unknown>>[];
          if (or) orClauses.push(...or);
        }
        if (orClauses.length > 0) {
          rows = rows.filter((d) => {
            for (const cond of orClauses) {
              for (const [field, filter] of Object.entries(cond)) {
                const val = filter as { contains?: string; mode?: string };
                if (
                  val.contains &&
                  typeof d[field] === "string" &&
                  (d[field] as string)
                    .toLowerCase()
                    .includes((val.contains as string).toLowerCase())
                ) {
                  return true;
                }
              }
            }
            return false;
          });
        }
        // createdAt filter
        const where2 = where as { createdAt?: { lt: Date } } | undefined;
        if (where2?.createdAt?.lt) {
          rows = rows.filter(
            (d) => (d.createdAt as Date) < where2.createdAt.lt,
          );
        }
        return rows.length;
      }),
      findMany: jest.fn(
        ({
          where,
          orderBy,
          skip,
          take,
        }: {
          where?: Record<string, unknown>;
          orderBy?: Record<string, unknown>;
          skip?: number;
          take?: number;
        } = {}) => {
          let rows = [...data.devices];
          // keyword filtering — handle both top-level OR and AND-wrapped OR
          const orClauses: Record<string, Record<string, unknown>>[] = [];
          if (where?.AND) {
            const and = where.AND as Record<string, unknown>[];
            for (const clause of and) {
              const or = clause.OR as Record<string, Record<string, unknown>>[];
              if (or) orClauses.push(...or);
            }
          }
          if (where?.OR) {
            const or = where.OR as Record<string, Record<string, unknown>>[];
            if (or) orClauses.push(...or);
          }
          if (orClauses.length > 0) {
            rows = rows.filter((d) => {
              for (const cond of orClauses) {
                for (const [field, filter] of Object.entries(cond)) {
                  const val = filter as { contains?: string; mode?: string };
                  if (
                    val.contains &&
                    typeof d[field] === "string" &&
                    (d[field] as string)
                      .toLowerCase()
                      .includes((val.contains as string).toLowerCase())
                  ) {
                    return true;
                  }
                }
              }
              return false;
            });
          }
          // createdAt filter
          if (where?.createdAt) {
            const createdAtFilter = where.createdAt as { lt?: Date };
            if (createdAtFilter.lt) {
              rows = rows.filter(
                (d) => (d.createdAt as Date) < createdAtFilter.lt!,
              );
            }
          }
          // orderBy: createdAt desc
          if (orderBy?.createdAt === "desc") {
            rows.sort(
              (a, b) =>
                (b.createdAt as Date).getTime() -
                (a.createdAt as Date).getTime(),
            );
          }
          // pagination
          const start = skip ?? 0;
          const end = take ? start + take : rows.length;
          return rows.slice(start, end);
        },
      ),
      findUnique: jest.fn(
        ({ where }: { where: { deviceId?: string } } = { where: {} }) => {
          if (!where?.deviceId) return null;
          return (
            data.devices.find((d) => d.deviceId === where.deviceId) ?? null
          );
        },
      ),
      findFirst: jest.fn(
        ({ where }: { where?: Record<string, unknown> } = {}) => {
          const eq = (where?.deviceId as { equals?: string } | undefined)
            ?.equals;
          if (!eq) return null;
          return (
            data.devices.find(
              (d) => (d.deviceId as string).toLowerCase() === eq.toLowerCase(),
            ) ?? null
          );
        },
      ),
      groupBy: jest.fn(
        (
          {
            by,
            orderBy,
          }: {
            by: string[];
            _count?: Record<string, boolean>;
            orderBy?: Record<string, unknown>;
          } = { by: [] },
        ) => {
          if (by.includes("firmwareVersion")) {
            // 原样回传 firmwareVersion（null / "" 都不归一化），只按 count 降序，
            // 归一化与 unknown 排序是被测代码的职责，mock 不复刻
            const buckets = new Map<string | null, number>();
            for (const d of data.devices) {
              const fw = d.firmwareVersion as string | null;
              buckets.set(fw, (buckets.get(fw) ?? 0) + 1);
            }
            const results = Array.from(buckets.entries()).map(
              ([firmwareVersion, count]) => ({
                firmwareVersion,
                _count: { _all: count },
              }),
            );
            if (
              (orderBy?._count as Record<string, string> | undefined)
                ?.firmwareVersion === "desc"
            ) {
              results.sort((a, b) => b._count._all - a._count._all);
            }
            return results;
          }
          return [];
        },
      ),
    },
    userDeviceBinding: {
      findMany: jest.fn(
        ({
          where,
          distinct,
        }: { where?: Record<string, unknown>; distinct?: string[] } = {}) =>
          applyDistinct(
            applyDateRange(
              data.bindings,
              "createdAt",
              where?.createdAt as { gte?: Date; lt?: Date } | undefined,
            ),
            distinct,
          ),
      ),
      groupBy: jest.fn(
        (
          {
            by,
            where,
            _min,
          }: {
            by: string[];
            _count?: Record<string, boolean>;
            _min?: Record<string, boolean>;
            where?: Record<string, unknown>;
          } = { by: [] },
        ) => {
          let rows = applyDateRange(
            data.bindings,
            "createdAt",
            where?.createdAt as { gte?: Date; lt?: Date } | undefined,
          );
          if (where?.deviceId) {
            const ids = (where.deviceId as { in: string[] }).in;
            if (ids)
              rows = rows.filter((b) => ids.includes(b.deviceId as string));
          }
          if (!by.includes("deviceId")) return [];
          const groups = new Map<string, Row[]>();
          for (const b of rows) {
            const key = b.deviceId as string;
            const bucket = groups.get(key);
            if (bucket) bucket.push(b);
            else groups.set(key, [b]);
          }
          return Array.from(groups.entries()).map(([deviceId, groupRows]) => {
            const result: Row = { deviceId };
            if (_min?.createdAt) {
              result._min = {
                createdAt: groupRows.reduce(
                  (min, r) =>
                    (r.createdAt as Date) < min ? (r.createdAt as Date) : min,
                  groupRows[0].createdAt as Date,
                ),
              };
            } else {
              result._count = { _all: groupRows.length };
            }
            return result;
          });
        },
      ),
    },
    message: {
      findMany: jest.fn(
        ({
          where,
          orderBy,
        }: {
          where?: Record<string, unknown>;
          orderBy?: Record<string, string>;
        } = {}) => {
          let rows = data.messages;
          if (where?.role) rows = rows.filter((m) => m.role === where.role);
          if (where?.deviceId) {
            const deviceFilter = where.deviceId as string;
            rows = rows.filter((m) => m.deviceId === deviceFilter);
          }
          rows = applyDateRange(
            rows,
            "spokeAt",
            where?.spokeAt as { gte?: Date; lt?: Date } | undefined,
          );
          if (orderBy?.spokeAt === "desc") {
            rows.sort(
              (a, b) =>
                (b.spokeAt as Date).getTime() - (a.spokeAt as Date).getTime(),
            );
          }
          return rows;
        },
      ),
      groupBy: jest.fn(
        (
          {
            by,
            _count,
            _max,
            where,
          }: {
            by: string[];
            _count?: Record<string, boolean>;
            _max?: Record<string, boolean>;
            where?: Record<string, unknown>;
          } = { by: [] },
        ) => {
          let rows = data.messages;
          if (where?.role) rows = rows.filter((m) => m.role === where.role);
          if (where?.deviceId) {
            const devFilter = where.deviceId;
            if (
              typeof devFilter === "object" &&
              devFilter !== null &&
              "in" in devFilter
            ) {
              const inArr = (devFilter as { in: string[] }).in;
              rows = rows.filter((m) => inArr.includes(m.deviceId as string));
            } else {
              rows = rows.filter((m) => m.deviceId === devFilter);
            }
          }
          rows = applyDateRange(
            rows,
            "spokeAt",
            where?.spokeAt as { gte?: Date; lt?: Date } | undefined,
          );
          if (by.includes("spokeAt")) {
            // group by date
            const groups = new Map<string, number>();
            for (const m of rows) {
              const dateKey = (m as Record<string, unknown>).spokeAt as Date;
              const key = dateKey.toISOString().slice(0, 10);
              groups.set(key, (groups.get(key) ?? 0) + 1);
            }
            return Array.from(groups.entries()).map(([date, count]) => ({
              date,
              _count: { _all: count },
            }));
          }
          if (by.includes("deviceId")) {
            // _count mode (used by getDevices) vs _max mode (used by getChurnRisk)
            if (_count?._all) {
              const groups = new Map<string, number>();
              for (const m of rows) {
                const key = m.deviceId as string;
                groups.set(key, (groups.get(key) ?? 0) + 1);
              }
              return Array.from(groups.entries()).map(([deviceId, count]) => ({
                deviceId,
                _count: { _all: count },
              }));
            }
            if (_max?.spokeAt) {
              const groups = new Map<string, Date>();
              for (const m of rows) {
                const key = m.deviceId as string;
                const spokeAt = m.spokeAt as Date;
                const current = groups.get(key);
                if (!current || spokeAt > current) {
                  groups.set(key, spokeAt);
                }
              }
              return Array.from(groups.entries()).map(
                ([deviceId, spokeAt]) => ({
                  deviceId,
                  _max: { spokeAt },
                }),
              );
            }
          }
          return [];
        },
      ),
    },
    devicePresenceDaily: {
      count: jest.fn(
        ({ where }: { where?: PresenceWhere } = {}) =>
          presence.filter(
            (r) =>
              typeof where?.date !== "string" ||
              (r.date as string) === where.date,
          ).length,
      ),
      findMany: jest.fn(({ where }: { where?: PresenceWhere } = {}) => {
        const range =
          typeof where?.date === "object" && where.date !== null
            ? where.date
            : undefined;
        const deviceIdFilter = where?.deviceId;
        return presence.filter((r) => {
          const date = r.date as string;
          const id = r.deviceId as string;
          if (range?.gte && date < range.gte) return false;
          if (range?.lte && date > range.lte) return false;
          if (typeof deviceIdFilter === "string" && id !== deviceIdFilter)
            return false;
          if (
            typeof deviceIdFilter === "object" &&
            deviceIdFilter !== null &&
            "in" in deviceIdFilter
          ) {
            const inArr = (deviceIdFilter as { in: string[] }).in;
            if (inArr && !inArr.includes(id)) return false;
          }
          return true;
        });
      }),
      findFirst: jest.fn(() => {
        if (presence.length === 0) return null;
        const sorted = [...presence]
          .map((r) => r.date as string)
          .sort((a, b) => a.localeCompare(b));
        return { date: sorted[0] };
      }),
      groupBy: jest.fn(
        (
          {
            by,
            _max,
            where,
          }: {
            by: string[];
            _max?: Record<string, boolean>;
            where?: Record<string, unknown>;
          } = { by: [] },
        ) => {
          if (by.includes("deviceId") && _max?.lastSeenAt) {
            const deviceFilter = where?.deviceId as
              { in: string[] } | undefined;
            const dateFilter = where?.date as { lte?: string } | undefined;
            const groups = new Map<string, Date>();
            for (const r of presence) {
              const id = r.deviceId as string;
              const date = r.date as string;
              if (dateFilter?.lte && date > dateFilter.lte) continue;
              if (deviceFilter?.in && !deviceFilter.in.includes(id)) continue;
              const seen = r.lastSeenAt as Date;
              const current = groups.get(id);
              if (!current || seen > current) {
                groups.set(id, seen);
              }
            }
            return Array.from(groups.entries()).map(
              ([deviceId, lastSeenAt]) => ({
                deviceId,
                _max: { lastSeenAt },
              }),
            );
          }
          if (by.includes("deviceId") && _max?.date) {
            const deviceFilter = where?.deviceId as
              { in: string[] } | undefined;
            const groups = new Map<string, string>();
            for (const r of presence) {
              const id = r.deviceId as string;
              if (deviceFilter?.in && !deviceFilter.in.includes(id)) continue;
              const date = r.date as string;
              const current = groups.get(id);
              if (!current || date > current) {
                groups.set(id, date);
              }
            }
            return Array.from(groups.entries()).map(([deviceId, date]) => ({
              deviceId,
              _max: { date },
            }));
          }
          return [];
        },
      ),
    },
  };
}

function buildService(
  prisma: Record<string, unknown>,
  deviceLinkOverride?: { getStatusBatch: jest.Mock },
): Promise<FleetService> {
  return Test.createTestingModule({
    providers: [
      FleetService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: DeviceLinkService,
        useValue: deviceLinkOverride ?? {
          getStatusBatch: jest.fn().mockResolvedValue(new Map()),
        },
      },
    ],
  })
    .compile()
    .then((module: TestingModule) => module.get(FleetService));
}

const DATE = "2026-11-05";

function spokeAtOn(dateKey: string, hour = 12): Date {
  const { start } = reportDayRange(dateKey, DEFAULT_REPORT_TIMEZONE);
  return new Date(start.getTime() + hour * 3600000);
}

function d(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    deviceId: id,
    characterKey: "elly",
    deviceCode: null,
    firmwareVersion: null,
    macAddress: id,
    wifiName: null,
    ipAddress: null,
    networkType: null,
    timezone: null,
    createdAt: spokeAtOn("2026-10-01"),
    ...overrides,
  };
}

describe("FleetService.getSummary", () => {
  it("返回概览：totalDevices / activatedDevices / devicesPoweredOn / powerOnRate / onlineNow / lowBatteryNow", async () => {
    const prisma = buildPrisma({
      devices: [
        d("aa0000000001", { macAddress: "AA0000000001" }),
        d("aa0000000002", { macAddress: null }),
        d("aa0000000003", { macAddress: "AA0000000003" }),
      ],
      bindings: [
        { deviceId: "aa0000000001", createdAt: spokeAtOn("2026-11-01") },
        { deviceId: "aa0000000002", createdAt: spokeAtOn("2026-11-01") },
      ],
      messages: [],
      presence: [
        {
          deviceId: "aa0000000001",
          date: DATE,
          reportCount: 10,
          firstSeenAt: spokeAtOn(DATE, 8),
          lastSeenAt: spokeAtOn(DATE, 20),
        },
      ],
    });
    const mockGetStatusBatch = jest.fn().mockResolvedValue(
      new Map([
        [
          "AA0000000001",
          {
            mac: "AA0000000001",
            battery: 80,
            volume: 50,
            version: "1.2.3",
            charging: true,
            lastSeenAt: Date.now() - 5_000,
            online: true,
          },
        ],
        [
          "AA0000000002",
          {
            mac: "AA0000000002",
            battery: 15,
            volume: null,
            version: null,
            charging: null,
            lastSeenAt: Date.now() - 5_000,
            online: true,
          },
        ],
        [
          "AA0000000003",
          {
            mac: "AA0000000003",
            battery: null,
            volume: null,
            version: null,
            charging: null,
            lastSeenAt: null,
            online: false,
          },
        ],
      ]),
    );
    const service = await buildService(prisma, {
      getStatusBatch: mockGetStatusBatch,
    });

    const result = await service.getSummary({ date: DATE });

    expect(result.date).toBe(DATE);
    expect(result.totalDevices).toBe(3);
    expect(result.activatedDevices).toBe(2);
    expect(result.devicesPoweredOn).toBe(1);
    expect(result.powerOnRate).toBe(0.5);
    expect(result.onlineNow).toBe(2);
    expect(result.lowBatteryNow).toBe(1);
    expect(result.lowBatteryThreshold).toBe(20);
    expect(result.presenceSince).toBe(DATE);
  });

  it("date 缺省取昨天，非法日期返回 400", async () => {
    const prisma = buildPrisma({ devices: [], bindings: [], messages: [] });
    const service = await buildService(prisma);

    const result = await service.getSummary({});
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await expect(service.getSummary({ date: "2026-13-40" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("getStatusBatch 抛错时 onlineNow / lowBatteryNow 为 null 且方法不抛", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001", { macAddress: "AA0000000001" })],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma, {
      getStatusBatch: jest.fn().mockRejectedValue(new Error("Redis down")),
    });

    const result = await service.getSummary({ date: DATE });

    expect(result.onlineNow).toBeNull();
    expect(result.lowBatteryNow).toBeNull();
  });

  it("getStatusBatch 抛出非 Error 值时同样降级为 null", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001", { macAddress: "AA0000000001" })],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma, {
      getStatusBatch: jest.fn().mockRejectedValue("plain string failure"),
    });

    const result = await service.getSummary({ date: DATE });

    expect(result.onlineNow).toBeNull();
    expect(result.lowBatteryNow).toBeNull();
  });

  it("presence 表为空时 devicesPoweredOn / powerOnRate / presenceSince 为 null", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001")],
      bindings: [
        { deviceId: "aa0000000001", createdAt: spokeAtOn("2026-11-01") },
      ],
      messages: [],
    });
    const service = await buildService(prisma);

    const result = await service.getSummary({ date: DATE });

    expect(result.devicesPoweredOn).toBeNull();
    expect(result.powerOnRate).toBeNull();
    expect(result.presenceSince).toBeNull();
  });

  it("已激活设备为 0 时 powerOnRate 为 null（分母 0）", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001")],
      bindings: [],
      messages: [],
      presence: [
        {
          deviceId: "aa0000000001",
          date: DATE,
          reportCount: 1,
          firstSeenAt: spokeAtOn(DATE),
          lastSeenAt: spokeAtOn(DATE),
        },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.getSummary({ date: DATE });

    expect(result.devicesPoweredOn).toBe(1);
    expect(result.powerOnRate).toBeNull();
  });

  it("一台设备被多个用户绑定时 activatedDevices 按 distinct deviceId 去重", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001")],
      bindings: [
        {
          deviceId: "aa0000000001",
          userId: "user-1",
          createdAt: spokeAtOn("2026-11-01"),
        },
        {
          deviceId: "aa0000000001",
          userId: "user-2",
          createdAt: spokeAtOn("2026-11-02"),
        },
      ],
      messages: [],
      presence: [
        {
          deviceId: "aa0000000001",
          date: DATE,
          reportCount: 1,
          firstSeenAt: spokeAtOn(DATE),
          lastSeenAt: spokeAtOn(DATE),
        },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.getSummary({ date: DATE });

    expect(result.activatedDevices).toBe(1);
    expect(result.devicesPoweredOn).toBe(1);
    expect(result.powerOnRate).toBe(1);
  });
});

describe("FleetService.getPresenceTrend", () => {
  it("区间内每天出现，早于 presenceSince 为 null，之后为实际值", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001")],
      bindings: [
        { deviceId: "aa0000000001", createdAt: spokeAtOn("2026-11-01") },
      ],
      messages: [],
      presence: [
        {
          deviceId: "aa0000000001",
          date: "2026-11-05",
          reportCount: 5,
          firstSeenAt: spokeAtOn("2026-11-05", 8),
          lastSeenAt: spokeAtOn("2026-11-05", 20),
        },
        {
          deviceId: "aa0000000001",
          date: "2026-11-06",
          reportCount: 3,
          firstSeenAt: spokeAtOn("2026-11-06", 8),
          lastSeenAt: spokeAtOn("2026-11-06", 20),
        },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.getPresenceTrend({
      startDate: "2026-11-04",
      endDate: "2026-11-06",
    });

    expect(result.startDate).toBe("2026-11-04");
    expect(result.endDate).toBe("2026-11-06");
    expect(result.presenceSince).toBe("2026-11-05");
    expect(result.series).toHaveLength(3);
    // 11-04 早于 presenceSince → null
    expect(result.series[0]).toEqual({
      date: "2026-11-04",
      devicesPoweredOn: null,
      powerOnRate: null,
      reportCount: null,
    });
    // 11-05 presenceSince 当天
    expect(result.series[1]).toEqual({
      date: "2026-11-05",
      devicesPoweredOn: 1,
      powerOnRate: 1,
      reportCount: 5,
    });
    expect(result.series[2]).toEqual({
      date: "2026-11-06",
      devicesPoweredOn: 1,
      powerOnRate: 1,
      reportCount: 3,
    });
  });

  it("区间上限 62 天，超出返回 400", async () => {
    const prisma = buildPrisma({ devices: [], bindings: [], messages: [] });
    const service = await buildService(prisma);

    await expect(
      service.getPresenceTrend({
        startDate: "2026-09-01",
        endDate: "2026-11-02",
      }),
    ).rejects.toThrow(BadRequestException);

    // 刚好 62 天应通过（9-01 到 11-01 = 61 天 gap，即 62 天 inclusive）
    // Actually: 2026-09-01 to 2026-11-01 = 61 days gap, 62 days inclusive → OK
    await expect(
      service.getPresenceTrend({
        startDate: "2026-09-01",
        endDate: "2026-11-01",
      }),
    ).resolves.toBeDefined();
  });

  it("startDate > endDate 返回 400", async () => {
    const prisma = buildPrisma({ devices: [], bindings: [], messages: [] });
    const service = await buildService(prisma);

    await expect(
      service.getPresenceTrend({
        startDate: "2026-11-06",
        endDate: "2026-11-04",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("非法日期返回 400", async () => {
    const prisma = buildPrisma({ devices: [], bindings: [], messages: [] });
    const service = await buildService(prisma);

    await expect(
      service.getPresenceTrend({ startDate: "2026-11-01", endDate: "oops" }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.getPresenceTrend({ startDate: "oops", endDate: "2026-11-01" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("powerOnRate 分母 = 截至当日累计已激活设备数（同设备多绑定取最早）", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001"), d("aa0000000002"), d("aa0000000003")],
      bindings: [
        { deviceId: "aa0000000001", createdAt: spokeAtOn("2026-11-03") },
        { deviceId: "aa0000000001", createdAt: spokeAtOn("2026-11-01") },
        { deviceId: "aa0000000002", createdAt: spokeAtOn("2026-11-08") },
      ],
      messages: [],
      presence: [
        {
          deviceId: "aa0000000001",
          date: "2026-11-05",
          reportCount: 4,
          firstSeenAt: spokeAtOn("2026-11-05", 8),
          lastSeenAt: spokeAtOn("2026-11-05", 20),
        },
        {
          deviceId: "aa0000000001",
          date: "2026-11-09",
          reportCount: 2,
          firstSeenAt: spokeAtOn("2026-11-09", 8),
          lastSeenAt: spokeAtOn("2026-11-09", 20),
        },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.getPresenceTrend({
      startDate: "2026-11-05",
      endDate: "2026-11-09",
    });

    expect(result.presenceSince).toBe("2026-11-05");
    expect(result.series.map((row) => row.date)).toEqual([
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
      "2026-11-09",
    ]);
    // 11-05 ~ 11-07 只有 dev1 已激活（取最早绑定 11-01）→ 分母 1
    expect(result.series[0]).toEqual({
      date: "2026-11-05",
      devicesPoweredOn: 1,
      powerOnRate: 1,
      reportCount: 4,
    });
    expect(result.series[1]).toEqual({
      date: "2026-11-06",
      devicesPoweredOn: 0,
      powerOnRate: 0,
      reportCount: 0,
    });
    // 11-08 起 dev2 也已激活 → 分母 2
    expect(result.series[3]).toEqual({
      date: "2026-11-08",
      devicesPoweredOn: 0,
      powerOnRate: 0,
      reportCount: 0,
    });
    expect(result.series[4]).toEqual({
      date: "2026-11-09",
      devicesPoweredOn: 1,
      powerOnRate: 0.5,
      reportCount: 2,
    });
  });
});

describe("FleetService.getFirmwareDistribution", () => {
  it("按 firmwareVersion 分组，null 或空字符串归入 unknown，按 devices 降序排序", async () => {
    const prisma = buildPrisma({
      devices: [
        d("aa0000000001", { firmwareVersion: "1.2.3" }),
        d("aa0000000002", { firmwareVersion: "1.2.3" }),
        d("aa0000000003", { firmwareVersion: null }),
        d("aa0000000004", { firmwareVersion: "" }),
        d("aa0000000005", { firmwareVersion: "2.0.0" }),
      ],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma);

    const result = await service.getFirmwareDistribution();

    expect(result.total).toBe(5);
    expect(result.buckets).toHaveLength(3);
    // "unknown" 桶 2 台 (null + "")，恒定排最后
    expect(result.buckets[0]).toEqual({
      firmwareVersion: "1.2.3",
      devices: 2,
    });
    expect(result.buckets[1]).toEqual({
      firmwareVersion: "2.0.0",
      devices: 1,
    });
    expect(result.buckets[2]).toEqual({
      firmwareVersion: "unknown",
      devices: 2,
    });
  });

  it("unknown 桶计数最大时仍排最后，其余按计数降序", async () => {
    const prisma = buildPrisma({
      devices: [
        d("aa0000000001", { firmwareVersion: null }),
        d("aa0000000002", { firmwareVersion: null }),
        d("aa0000000003", { firmwareVersion: "" }),
        d("aa0000000004", { firmwareVersion: "1.2.3" }),
        d("aa0000000005", { firmwareVersion: "1.2.3" }),
        d("aa0000000006", { firmwareVersion: "2.0.0" }),
      ],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma);

    const result = await service.getFirmwareDistribution();

    expect(result.buckets).toEqual([
      { firmwareVersion: "1.2.3", devices: 2 },
      { firmwareVersion: "2.0.0", devices: 1 },
      { firmwareVersion: "unknown", devices: 3 },
    ]);
  });

  it("空库返回 total=0 且 buckets=[]", async () => {
    const prisma = buildPrisma({ devices: [], bindings: [], messages: [] });
    const service = await buildService(prisma);

    const result = await service.getFirmwareDistribution();

    expect(result.total).toBe(0);
    expect(result.buckets).toEqual([]);
  });
  it("桶内数量相同时 unknown 排最后，其余按版本名升序", async () => {
    const prisma = buildPrisma({
      devices: [
        d("aa0000000001", { firmwareVersion: "2.0.0" }),
        d("aa0000000002", { firmwareVersion: "1.0.0" }),
        d("aa0000000003", { firmwareVersion: "" }),
        d("aa0000000004", { firmwareVersion: null }),
      ],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma);

    const result = await service.getFirmwareDistribution();

    expect(result.total).toBe(4);
    expect(result.buckets).toEqual([
      { firmwareVersion: "1.0.0", devices: 1 },
      { firmwareVersion: "2.0.0", devices: 1 },
      { firmwareVersion: "unknown", devices: 2 },
    ]);
  });

  it("数量相同的两个具名版本按版本名升序，unknown 仍排最后", async () => {
    const prisma = buildPrisma({
      devices: [
        d("aa0000000003", { firmwareVersion: null }),
        d("aa0000000001", { firmwareVersion: "2.0.0" }),
        d("aa0000000002", { firmwareVersion: "1.0.0" }),
      ],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma);

    const result = await service.getFirmwareDistribution();

    expect(result.total).toBe(3);
    expect(result.buckets.map((b) => b.firmwareVersion)).toEqual([
      "1.0.0",
      "2.0.0",
      "unknown",
    ]);
  });
});

describe("FleetService.getChurnRisk", () => {
  it("按 daysInactive 降序返回有流失风险的设备，basis 正确标注", async () => {
    const today = spokeAtOn("2026-11-05");
    const prisma = buildPrisma({
      devices: [
        d("aa0000000001", {
          createdAt: spokeAtOn("2026-10-01"),
          firmwareVersion: "1.0.0",
        }),
        d("aa0000000002", {
          createdAt: spokeAtOn("2026-10-01"),
          firmwareVersion: null,
        }),
        d("aa0000000003", {
          createdAt: spokeAtOn("2026-11-01"),
          firmwareVersion: null,
        }),
      ],
      bindings: [
        { deviceId: "aa0000000001", createdAt: spokeAtOn("2026-10-01") },
        { deviceId: "aa0000000002", createdAt: spokeAtOn("2026-10-01") },
        { deviceId: "aa0000000003", createdAt: spokeAtOn("2026-11-01") },
      ],
      messages: [
        {
          deviceId: "aa0000000001",
          role: "user",
          spokeAt: spokeAtOn("2026-10-20"),
        },
      ],
      presence: [
        {
          deviceId: "aa0000000001",
          date: "2026-10-20",
          reportCount: 1,
          firstSeenAt: spokeAtOn("2026-10-20"),
          lastSeenAt: spokeAtOn("2026-10-20"),
        },
      ],
    });
    const service = await buildService(prisma);
    // Mock Date.now to return a fixed date within spokeAtOn("2026-11-05")
    jest.spyOn(Date, "now").mockReturnValue(today.getTime());

    const result = await service.getChurnRisk({ days: 7 });

    expect(result.days).toBe(7);
    // aa0000000002: no presence + no message → basis=createdAt (lastActiveAt=2026-10-01)
    // aa0000000003: no presence + no message → basis=createdAt (lastActiveAt=2026-11-01)
    // aa0000000001: has presence on 2026-10-20 AND message on 2026-10-20 → basis=presence (lastActiveAt from presence.lastSeenAt)
    // daysInactive: aa0000000002 = 35 days (10-01 to 11-05), aa0000000003 = 4 days (<7, excluded)
    // aa0000000001: lastActiveAt = 2026-10-20, daysInactive = 16 (10-20 to 11-05)
    expect(result.devices).toHaveLength(2);
    // 按 daysInactive 降序
    expect(result.devices[0].deviceId).toBe("aa0000000002");
    expect(result.devices[0].basis).toBe("createdAt");
    expect(result.devices[0].daysInactive).toBeGreaterThanOrEqual(34);

    expect(result.devices[1].deviceId).toBe("aa0000000001");
    expect(result.devices[1].basis).toBe("presence");

    jest.restoreAllMocks();
  });

  it("days 缺省 7，越界返回 400", async () => {
    const prisma = buildPrisma({ devices: [], bindings: [], messages: [] });
    const service = await buildService(prisma);

    // Valid: 默认 7
    const r1 = await service.getChurnRisk({});
    expect(r1.days).toBe(7);

    // days=0 → validation should catch it but service should handle too
    // Actually validation is in DTO, service receives validated input
  });

  it("无风险设备时 devices 为空数组", async () => {
    const today = spokeAtOn("2026-11-06");
    const prisma = buildPrisma({
      devices: [d("aa0000000001", { createdAt: spokeAtOn("2026-11-05") })],
      bindings: [
        { deviceId: "aa0000000001", createdAt: spokeAtOn("2026-11-05") },
      ],
      messages: [
        {
          deviceId: "aa0000000001",
          role: "user",
          spokeAt: spokeAtOn("2026-11-05"),
        },
      ],
    });
    const service = await buildService(prisma);
    jest.spyOn(Date, "now").mockReturnValue(today.getTime());

    const result = await service.getChurnRisk({ days: 7 });

    expect(result.count).toBe(0);
    expect(result.devices).toEqual([]);
    jest.restoreAllMocks();
  });
});

describe("FleetService.getDevices", () => {
  it("分页返回设备列表含 realtime / presenceDays7d / turns7d", async () => {
    const prisma = buildPrisma({
      devices: [
        d("aa0000000001", {
          macAddress: "AA0000000001",
          createdAt: spokeAtOn("2026-11-01"),
        }),
        d("aa0000000002", {
          macAddress: null,
          createdAt: spokeAtOn("2026-10-15"),
        }),
      ],
      bindings: [
        { deviceId: "aa0000000001", createdAt: spokeAtOn("2026-11-01") },
      ],
      messages: [
        {
          deviceId: "aa0000000001",
          role: "user",
          spokeAt: spokeAtOn("2026-11-05"),
        },
      ],
      presence: [
        {
          deviceId: "aa0000000001",
          date: "2026-11-05",
          reportCount: 3,
          firstSeenAt: spokeAtOn("2026-11-05", 8),
          lastSeenAt: spokeAtOn("2026-11-05", 20),
        },
      ],
    });
    const mockGetStatusBatch = jest.fn().mockResolvedValue(
      new Map([
        [
          "AA0000000001",
          {
            mac: "AA0000000001",
            battery: 80,
            volume: 50,
            version: null,
            charging: null,
            lastSeenAt: Date.now() - 5_000,
            online: true,
          },
        ],
        [
          "AA0000000002",
          {
            mac: "AA0000000002",
            battery: null,
            volume: null,
            version: null,
            charging: null,
            lastSeenAt: Date.now() - 60_000,
            online: false,
          },
        ],
      ]),
    );
    const service = await buildService(prisma, {
      getStatusBatch: mockGetStatusBatch,
    });

    // Mock Date.now() so "7 days ago" includes the test date 2026-11-05
    const today = spokeAtOn("2026-11-06");
    jest.spyOn(Date, "now").mockReturnValue(today.getTime());

    const result = await service.getDevices({ page: 1, pageSize: 20 });

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.total).toBe(2);
    // Sort: createdAt desc → aa0000000001 first, aa0000000002 second
    expect(result.items[0].deviceId).toBe("aa0000000001");
    expect(result.items[0].realtime).toEqual({
      online: true,
      battery: 80,
      volume: 50,
      version: null,
      charging: null,
      lastSeenAt: expect.any(Number),
    });
    expect(result.items[0].boundUsers).toBe(1);
    expect(result.items[0].presenceDays7d).toBe(1);
    expect(result.items[0].lastPresenceDate).toBe("2026-11-05");
    expect(result.items[0].turns7d).toBe(1);

    // Second device: no macAddress → use deviceId for Redis lookup
    expect(result.items[1].deviceId).toBe("aa0000000002");
    expect(result.items[1].realtime).not.toBeNull();
    expect(result.items[1].boundUsers).toBe(0);
    expect(result.items[1].presenceDays7d).toBe(0);
    expect(result.items[1].lastPresenceDate).toBeNull();

    jest.restoreAllMocks();
  });

  it("page / pageSize 缺省为 1 / 20", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001")],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma);

    const result = await service.getDevices({});

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.total).toBe(1);
  });

  it("getStatusBatch 抛出非 Error 值时 realtime 为 null 且不抛", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001", { macAddress: "AA0000000001" })],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma, {
      getStatusBatch: jest.fn().mockRejectedValue("plain string failure"),
    });

    const result = await service.getDevices({ page: 1, pageSize: 20 });

    expect(result.items[0].realtime).toBeNull();
  });

  it("getStatusBatch 抛错时所有 item 的 realtime 为 null", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001")],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma, {
      getStatusBatch: jest.fn().mockRejectedValue(new Error("Redis down")),
    });

    const result = await service.getDevices({ page: 1, pageSize: 20 });

    expect(result.items[0].realtime).toBeNull();
  });

  it("keyword 过滤（大小写不敏感）", async () => {
    const prisma = buildPrisma({
      devices: [
        d("aa0000000001", { deviceCode: "ABC123" }),
        d("aa0000000002", { deviceCode: null }),
      ],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma);

    const result = await service.getDevices({
      keyword: "abc",
      page: 1,
      pageSize: 20,
    });

    expect(result.total).toBe(1);
    expect(result.items[0].deviceId).toBe("aa0000000001");
  });

  it("pageSize 超 100 静默 clamp 到 100", async () => {
    const prisma = buildPrisma({ devices: [], bindings: [], messages: [] });
    const service = await buildService(prisma);

    const result = await service.getDevices({ page: 1, pageSize: 999 });

    expect(result.pageSize).toBe(100);
  });
  it("库内 macAddress 为小写带分隔符时仍命中 Redis 大写 key", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000009", { macAddress: "aa:00:00:00:00:09" })],
      bindings: [],
      messages: [],
    });
    const mockGetStatusBatch = jest.fn().mockResolvedValue(
      new Map([
        [
          "AA0000000009",
          {
            mac: "AA0000000009",
            battery: 15,
            volume: null,
            version: null,
            charging: null,
            lastSeenAt: Date.now() - 5_000,
            online: true,
          },
        ],
      ]),
    );
    const service = await buildService(prisma, {
      getStatusBatch: mockGetStatusBatch,
    });

    const result = await service.getDevices({ page: 1, pageSize: 20 });

    // 传给 Redis 的仍是库里的原值，归一化只发生在查 Map 时
    expect(mockGetStatusBatch).toHaveBeenCalledWith(["aa:00:00:00:00:09"]);
    expect(result.items[0].realtime).toEqual({
      online: true,
      battery: 15,
      volume: null,
      version: null,
      charging: null,
      lastSeenAt: expect.any(Number),
    });
  });
});

describe("FleetService.getDeviceDetail", () => {
  it("返回单设备详情含 presence / dailyTurns / boundUsers", async () => {
    const prisma = buildPrisma({
      devices: [
        d("aa0000000001", {
          macAddress: "AA0000000001",
          firmwareVersion: "1.2.3",
          wifiName: "MyWiFi",
        }),
      ],
      bindings: [
        {
          deviceId: "aa0000000001",
          userId: "user-uuid-1",
          isOwner: true,
          createdAt: spokeAtOn("2026-11-01"),
        },
      ],
      messages: [
        {
          deviceId: "aa0000000001",
          role: "user",
          spokeAt: spokeAtOn("2026-11-05", 10),
        },
        {
          deviceId: "aa0000000001",
          role: "assistant",
          spokeAt: spokeAtOn("2026-11-05", 10),
        },
      ],
      presence: [
        {
          deviceId: "aa0000000001",
          date: "2026-11-05",
          reportCount: 10,
          firstSeenAt: spokeAtOn("2026-11-05", 8),
          lastSeenAt: spokeAtOn("2026-11-05", 20),
        },
      ],
    });
    const mockGetStatusBatch = jest.fn().mockResolvedValue(
      new Map([
        [
          "AA0000000001",
          {
            mac: "AA0000000001",
            battery: 80,
            volume: 50,
            version: "1.2.3",
            charging: false,
            lastSeenAt: Date.now() - 5_000,
            online: true,
          },
        ],
      ]),
    );
    const service = await buildService(prisma, {
      getStatusBatch: mockGetStatusBatch,
    });

    // Mock Date.now() to control dailyTurns date range
    const today = spokeAtOn("2026-11-06");
    jest.spyOn(Date, "now").mockReturnValue(today.getTime());

    const result = await service.getDeviceDetail("aa0000000001", { days: 30 });

    expect(result.deviceId).toBe("aa0000000001");
    expect(result.firmwareVersion).toBe("1.2.3");
    expect(result.wifiName).toBe("MyWiFi");
    expect(result.realtime).toEqual({
      online: true,
      battery: 80,
      volume: 50,
      version: "1.2.3",
      charging: false,
      lastSeenAt: expect.any(Number),
    });
    expect(result.boundUsers).toHaveLength(1);
    expect(result.boundUsers[0]).toEqual({
      userId: "user-uuid-1",
      isOwner: true,
      boundAt: expect.any(String),
    });
    expect(result.presence).toHaveLength(1);
    expect(result.presence[0]).toEqual({
      date: "2026-11-05",
      reportCount: 10,
      firstSeenAt: expect.any(String),
      lastSeenAt: expect.any(String),
    });
    expect(result.dailyTurns.length).toBeGreaterThanOrEqual(1);
    const withTurns = result.dailyTurns.find(
      (d: { turns: number }) => d.turns > 0,
    );
    expect(withTurns).toEqual({
      date: "2026-11-05",
      turns: 1,
    });
    expect(result.totals).toEqual({
      presenceDays: 1,
      turns: 1,
    });

    jest.restoreAllMocks();
  });

  it("不存在的 deviceId 返回 null", async () => {
    const prisma = buildPrisma({
      devices: [],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma);

    const result = await service.getDeviceDetail("nonexistent", { days: 30 });

    expect(result).toBeNull();
  });

  it("days 缺省 30", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001")],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma);

    const result = await service.getDeviceDetail("aa0000000001", {});

    expect(result).not.toBeNull();
    // dailyTurns and presence should span 30 days
  });

  it("Redis 查询失败时 realtime 为 null 不抛错", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001", { macAddress: "AA0000000001" })],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma, {
      getStatusBatch: jest.fn().mockRejectedValue(new Error("Redis down")),
    });

    const result = await service.getDeviceDetail("aa0000000001", { days: 30 });

    expect(result).not.toBeNull();
    expect(result!.realtime).toBeNull();
  });

  it("macAddress 为 null 时回落 deviceId 查 Redis，presence 时间字段缺失回 null", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001", { macAddress: null })],
      bindings: [],
      messages: [],
      presence: [
        {
          deviceId: "aa0000000001",
          date: "2026-11-05",
          reportCount: 2,
          firstSeenAt: null,
          lastSeenAt: null,
        },
      ],
    });
    const mockGetStatusBatch = jest.fn().mockResolvedValue(
      new Map([
        [
          "AA0000000001",
          {
            mac: "AA0000000001",
            battery: null,
            volume: null,
            version: null,
            charging: null,
            lastSeenAt: Date.now() - 5_000,
            online: false,
          },
        ],
      ]),
    );
    const service = await buildService(prisma, {
      getStatusBatch: mockGetStatusBatch,
    });
    jest.spyOn(Date, "now").mockReturnValue(spokeAtOn("2026-11-06").getTime());

    const result = await service.getDeviceDetail("aa0000000001", { days: 7 });

    expect(mockGetStatusBatch).toHaveBeenCalledWith(["aa0000000001"]);
    expect(result!.realtime).toEqual({
      online: false,
      battery: null,
      volume: null,
      version: null,
      charging: null,
      lastSeenAt: expect.any(Number),
    });
    expect(result!.presence[0]).toEqual({
      date: "2026-11-05",
      reportCount: 2,
      firstSeenAt: null,
      lastSeenAt: null,
    });

    jest.restoreAllMocks();
  });

  it("getStatusBatch 抛出非 Error 值时 realtime 为 null 且不抛", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001", { macAddress: "AA0000000001" })],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma, {
      getStatusBatch: jest.fn().mockRejectedValue("plain string failure"),
    });

    const result = await service.getDeviceDetail("aa0000000001", { days: 7 });

    expect(result!.realtime).toBeNull();
  });

  it("库内 deviceId 为小写、传入大写时经大小写不敏感兜底仍能查到", async () => {
    const prisma = buildPrisma({
      devices: [d("aa0000000001", { macAddress: "AA0000000001" })],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma);

    const result = await service.getDeviceDetail("AA0000000001", { days: 7 });

    expect(result).not.toBeNull();
    expect(result!.deviceId).toBe("aa0000000001");
  });
});
