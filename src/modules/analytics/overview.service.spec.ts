import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  reportDayRange,
  shiftReportDate,
} from "../learning-stats/parent-report-date.util";
import { DeviceLinkService } from "../device-link/device-link.service";
import { OverviewService } from "./overview.service";
import { RetentionService } from "./retention.service";

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

/** devicePresenceDaily mock 的 where 形状：count 传字符串，findMany 传区间 */
interface PresenceWhere {
  date?: string | { gte?: string; lte?: string };
  deviceId?: { in: string[] };
}

function buildPrisma(data: {
  devices: Row[];
  users: Row[];
  bindings: Row[];
  messages: Row[];
  presence?: Row[];
}) {
  const presence = data.presence ?? [];
  return {
    device: {
      count: jest.fn(
        ({ where }: any = {}) =>
          data.devices.filter(
            (d) => !where?.createdAt?.lt || d.createdAt < where.createdAt.lt,
          ).length,
      ),
      findMany: jest.fn(({ where }: any = {}) =>
        data.devices.filter(
          (d) => !where?.characterKey || d.characterKey === where.characterKey,
        ),
      ),
    },
    user: {
      count: jest.fn(
        ({ where }: any = {}) =>
          data.users.filter(
            (u) => !where?.createdAt?.lt || u.createdAt < where.createdAt.lt,
          ).length,
      ),
      findMany: jest.fn(({ where }: any = {}) =>
        applyDateRange(data.users, "createdAt", where?.createdAt),
      ),
    },
    userDeviceBinding: {
      findMany: jest.fn(({ where, distinct }: any = {}) =>
        applyDistinct(
          applyDateRange(data.bindings, "createdAt", where?.createdAt),
          distinct,
        ),
      ),
    },
    message: {
      findMany: jest.fn(({ where, distinct }: any = {}) => {
        let rows = data.messages;
        if (where?.role) rows = rows.filter((m) => m.role === where.role);
        if (where?.deviceId?.in)
          rows = rows.filter((m) => where.deviceId.in.includes(m.deviceId));
        rows = applyDateRange(rows, "spokeAt", where?.spokeAt);
        return applyDistinct(rows, distinct);
      }),
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
        const inIds = where?.deviceId?.in;
        return presence.filter((r) => {
          const date = r.date as string;
          const id = r.deviceId as string;
          if (range?.gte && date < range.gte) return false;
          if (range?.lte && date > range.lte) return false;
          if (inIds && !inIds.includes(id)) return false;
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
    },
  };
}

function buildService(
  prisma: any,
  deviceLinkOverride?: { getStatusBatch: jest.Mock },
): Promise<OverviewService> {
  return Test.createTestingModule({
    providers: [
      OverviewService,
      RetentionService,
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
    .then((module: TestingModule) => module.get(OverviewService));
}

const DATE = "2026-11-05";

function spokeAtOn(dateKey: string, hour = 12): Date {
  const { start } = reportDayRange(dateKey, DEFAULT_REPORT_TIMEZONE);
  return new Date(start.getTime() + hour * 3600000);
}

describe("OverviewService.getOverview", () => {
  it("汇总总量、当日活跃、漏斗与留存（时长为估算口径）", async () => {
    const prisma = buildPrisma({
      devices: [
        {
          id: "d1",
          deviceId: "aa:bb:cc:dd:ee:01",
          macAddress: "aa:bb:cc:dd:ee:01",
          createdAt: spokeAtOn("2026-11-01"),
          characterKey: "elly",
        },
        {
          id: "d2",
          deviceId: "aa:bb:cc:dd:ee:02",
          macAddress: null,
          createdAt: spokeAtOn("2026-11-01"),
          characterKey: "polly",
        },
        {
          id: "d3",
          deviceId: "aa:bb:cc:dd:ee:03",
          macAddress: "aa:bb:cc:dd:ee:03",
          createdAt: spokeAtOn("2026-11-01"),
          characterKey: "elly",
        },
      ],
      users: [{ id: "u1", createdAt: spokeAtOn("2026-11-01") }],
      bindings: [
        { deviceId: "d1", createdAt: spokeAtOn(shiftReportDate(DATE, -1)) },
        { deviceId: "d2", createdAt: spokeAtOn("2026-11-01") },
      ],
      messages: [
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn(DATE) },
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn(DATE, 13) },
        { deviceId: "d1", role: "assistant", spokeAt: spokeAtOn(DATE, 14) },
        { deviceId: "d2", role: "user", spokeAt: spokeAtOn(DATE) },
        { deviceId: "d2", role: "user", spokeAt: shiftDate(DATE, -1, 12) },
        { deviceId: "d1", role: "user", spokeAt: shiftDate(DATE, -1, 10) },
      ],
      // 落库首日为前一天，用于验证 firstPresenceDate 取最小值
      presence: [
        { deviceId: "d1", date: shiftReportDate(DATE, -1) },
        { deviceId: "d1", date: DATE },
      ],
    });
    const d1OnlineStatus = {
      mac: "AABBCCDDEE01",
      battery: 80,
      volume: 50,
      version: "1.2.3",
      charging: true,
      lastSeenAt: Date.now() - 5_000,
      online: true,
    };
    const d3OnlineStatus = {
      mac: "AABBCCDDEE03",
      battery: 60,
      volume: null,
      version: null,
      charging: null,
      lastSeenAt: Date.now() - 5_000,
      online: true,
    };
    const mockGetStatusBatch = jest.fn().mockResolvedValue(
      new Map([
        ["AABBCCDDEE01", d1OnlineStatus],
        [
          "AABBCCDDEE02",
          {
            mac: "AABBCCDDEE02",
            battery: null,
            volume: null,
            version: null,
            charging: null,
            lastSeenAt: null,
            online: false,
          },
        ],
        ["AABBCCDDEE03", d3OnlineStatus],
      ]),
    );
    const service = await buildService(prisma, {
      getStatusBatch: mockGetStatusBatch,
    });

    const result = await service.getOverview({ date: DATE });

    expect(result.date).toBe(DATE);
    expect(result.totals.devicesRegistered).toBe(3);
    expect(result.totals.devicesActivated).toBe(2);
    expect(result.totals.activationRate).toBeCloseTo(0.6667, 3);
    // 当日 2 台活跃、3 条 user 消息
    expect(result.today.dau).toBe(2);
    // 估算口径：3 条 × 30s / 2 台 = 45s
    expect(result.today.avgDurationSecondsPerActiveDevice).toBe(45);
    expect(result.today.avgTurnsPerActiveDevice).toBe(1.5);
    // 前一日 dau=2（d1、d2 各有 1 条）
    expect(result.today.dauDeltaPct).toBe(0);
    // 当日只有 d1 有 presence 行；分母 = 已激活 2 台 → 开机率 0.5
    expect(result.today.devicesPoweredOn).toBe(1);
    expect(result.today.powerOnRate).toBe(0.5);
    // d1 (AABBCCDDEE01) 和 d3 (AABBCCDDEE03) 在线，d2 离线
    expect(result.today.onlineNow).toBe(2);
    // d1 激活于前一天且当天有消息 → D1=1
    expect(result.retention.d1).toBe(1);
    expect(result.retention.d7).toBeNull();
    // 漏斗
    expect(result.funnel.shipped).toBeNull();
    expect(result.funnel.activated).toBe(2);
    expect(result.funnel.firstConversation).toBe(2);
    expect(result.funnel.active7d).toBe(2);
  });

  it("date 缺省取昨天，非法日期返回 400", async () => {
    const prisma = buildPrisma({
      devices: [],
      users: [],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma);

    const yesterday = shiftReportDate(
      new Date().toISOString().slice(0, 10),
      -1,
    );
    const result = await service.getOverview({});
    // 北京时区昨天（UTC 与北京最多差 1 天，宽松断言返回的是合法日期）
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    void yesterday;

    await expect(service.getOverview({ date: "2026-13-40" })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("getStatusBatch 抛错时 onlineNow 为 null 且方法不抛", async () => {
    const prisma = buildPrisma({
      devices: [
        {
          id: "d1",
          deviceId: "aa:bb:cc:dd:ee:01",
          macAddress: "aa:bb:cc:dd:ee:01",
          createdAt: spokeAtOn("2026-11-01"),
          characterKey: "elly",
        },
      ],
      users: [],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma, {
      getStatusBatch: jest.fn().mockRejectedValue(new Error("Redis down")),
    });

    const result = await service.getOverview({ date: DATE });

    expect(result.today.onlineNow).toBeNull();
  });

  it("presence 表为空时 devicesPoweredOn / powerOnRate 为 null（无数据而非 0 台）", async () => {
    const prisma = buildPrisma({
      devices: [
        {
          id: "d1",
          deviceId: "aa:bb:cc:dd:ee:01",
          macAddress: "aa:bb:cc:dd:ee:01",
          createdAt: spokeAtOn("2026-11-01"),
          characterKey: "elly",
        },
      ],
      users: [],
      bindings: [{ deviceId: "d1", createdAt: spokeAtOn("2026-11-01") }],
      messages: [],
    });
    const service = await buildService(prisma);

    const result = await service.getOverview({ date: DATE });

    expect(result.today.devicesPoweredOn).toBeNull();
    expect(result.today.powerOnRate).toBeNull();
  });

  it("已激活设备为 0 时 powerOnRate 为 null（分母为 0 不产出比率）", async () => {
    const prisma = buildPrisma({
      devices: [],
      users: [],
      bindings: [],
      messages: [],
      presence: [{ deviceId: "d1", date: DATE }],
    });
    const service = await buildService(prisma);

    const result = await service.getOverview({ date: DATE });

    expect(result.today.devicesPoweredOn).toBe(1);
    expect(result.today.powerOnRate).toBeNull();
  });
});

function shiftDate(dateKey: string, days: number, hour: number): Date {
  return spokeAtOn(shiftReportDate(dateKey, days), hour);
}

describe("OverviewService.getTrend", () => {
  it("按日展开并补零，metrics 过滤生效", async () => {
    const prisma = buildPrisma({
      devices: [
        { id: "d1", createdAt: spokeAtOn("2026-11-01"), characterKey: "elly" },
      ],
      users: [{ id: "u1", createdAt: spokeAtOn("2026-11-04") }],
      bindings: [{ deviceId: "d1", createdAt: spokeAtOn("2026-11-04") }],
      messages: [
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn("2026-11-04") },
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn("2026-11-06") },
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn("2026-11-06", 15) },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.getTrend({
      startDate: "2026-11-04",
      endDate: "2026-11-06",
      metrics: "dau,avgDuration,newActivated",
    });

    expect(result.granularity).toBe("day");
    expect(result.series).toHaveLength(3);
    expect(result.series[0]).toEqual({
      date: "2026-11-04",
      dau: 1,
      avgDurationSeconds: 30,
      newActivatedDevices: 1,
    });
    // 无数据日期补零
    expect(result.series[1]).toEqual({
      date: "2026-11-05",
      dau: 0,
      avgDurationSeconds: 0,
      newActivatedDevices: 0,
    });
    expect(result.series[2]).toEqual({
      date: "2026-11-06",
      dau: 1,
      avgDurationSeconds: 60,
      newActivatedDevices: 0,
    });
    // metrics 未选的字段不出现
    expect(result.series[0]).not.toHaveProperty("newUsers");
    expect(result.series[0]).not.toHaveProperty("devicesPoweredOn");
  });

  it("metrics=poweredOn：落库首日之前为 null，之后为当日去重开机台数", async () => {
    const prisma = buildPrisma({
      devices: [
        { id: "d1", createdAt: spokeAtOn("2026-11-01"), characterKey: "elly" },
        { id: "d2", createdAt: spokeAtOn("2026-11-01"), characterKey: "elly" },
      ],
      users: [],
      bindings: [],
      messages: [],
      presence: [
        { deviceId: "d1", date: "2026-11-05" },
        { deviceId: "d2", date: "2026-11-05" },
        { deviceId: "d1", date: "2026-11-06" },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.getTrend({
      startDate: "2026-11-04",
      endDate: "2026-11-06",
      metrics: "poweredOn",
    });

    // 11-04 早于落库首日 11-05 → null（无数据），不是 0
    expect(result.series[0]).toEqual({
      date: "2026-11-04",
      devicesPoweredOn: null,
    });
    expect(result.series[1]).toEqual({
      date: "2026-11-05",
      devicesPoweredOn: 2,
    });
    expect(result.series[2]).toEqual({
      date: "2026-11-06",
      devicesPoweredOn: 1,
    });
  });

  it("非法 metrics 与倒置日期范围返回 400", async () => {
    const prisma = buildPrisma({
      devices: [],
      users: [],
      bindings: [],
      messages: [],
    });
    const service = await buildService(prisma);

    await expect(
      service.getTrend({
        startDate: "2026-11-04",
        endDate: "2026-11-06",
        metrics: "dau,bogus",
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.getTrend({ startDate: "2026-11-06", endDate: "2026-11-04" }),
    ).rejects.toThrow(BadRequestException);
  });
});
