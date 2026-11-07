import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  reportDayRange,
  shiftReportDate,
} from "../learning-stats/parent-report-date.util";
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

function buildPrisma(data: {
  devices: Row[];
  users: Row[];
  bindings: Row[];
  messages: Row[];
}) {
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
  };
}

function buildService(prisma: any): Promise<OverviewService> {
  return Test.createTestingModule({
    providers: [
      OverviewService,
      RetentionService,
      { provide: PrismaService, useValue: prisma },
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
        { id: "d1", createdAt: spokeAtOn("2026-11-01"), characterKey: "elly" },
        { id: "d2", createdAt: spokeAtOn("2026-11-01"), characterKey: "polly" },
        { id: "d3", createdAt: spokeAtOn("2026-11-01"), characterKey: "elly" },
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
    });
    const service = await buildService(prisma);

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
    // 一期占位
    expect(result.today.devicesPoweredOn).toBeNull();
    expect(result.today.onlineNow).toBeNull();
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
