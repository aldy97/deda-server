import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  reportDayRange,
  shiftReportDate,
} from "../learning-stats/parent-report-date.util";
import { EngagementService } from "./engagement.service";

type Row = Record<string, any>;

function spokeAtOn(dateKey: string, hour = 12): Date {
  const { start } = reportDayRange(dateKey, DEFAULT_REPORT_TIMEZONE);
  return new Date(start.getTime() + hour * 3600000);
}

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
  messages: Row[];
  bindings: Row[];
  sleepConfigs: Row[];
  adventureProgresses: Row[];
  habitPlans: Row[];
}) {
  return {
    message: {
      findMany: jest.fn(({ where, distinct }: any = {}) => {
        let rows = data.messages;
        if (where?.role) rows = rows.filter((m) => m.role === where.role);
        if (where?.mode) rows = rows.filter((m) => m.mode === where.mode);
        rows = applyDateRange(rows, "spokeAt", where?.spokeAt);
        if (distinct?.includes("deviceId")) {
          const seen = new Set<string>();
          rows = rows.filter((m) =>
            seen.has(m.deviceId) ? false : (seen.add(m.deviceId), true),
          );
        }
        return rows;
      }),
    },
    userDeviceBinding: {
      findMany: jest.fn(({ distinct }: any = {}) => {
        if (!distinct?.includes("deviceId")) return data.bindings;
        const seen = new Set<string>();
        return data.bindings.filter((b) =>
          seen.has(b.deviceId) ? false : (seen.add(b.deviceId), true),
        );
      }),
    },
    sleepConfig: {
      count: jest.fn(
        ({ where }: any = {}) =>
          data.sleepConfigs.filter((s) => !where?.enabled || s.enabled).length,
      ),
    },
    adventureProgress: {
      findMany: jest.fn(() => data.adventureProgresses),
    },
    habitPlan: {
      findMany: jest.fn(({ where }: any = {}) =>
        data.habitPlans.filter(
          (p) => !where?.status || p.status === where.status,
        ),
      ),
    },
  };
}

async function buildService(prisma: any): Promise<EngagementService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      EngagementService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return module.get(EngagementService);
}

describe("EngagementService", () => {
  it("summary：活跃设备、时长估算、P50/P90、活跃天数", async () => {
    const prisma = buildPrisma({
      messages: [
        // d1：2 天活跃，共 4 轮（120s）
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn("2026-11-04") },
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn("2026-11-04", 15) },
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn("2026-11-05") },
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn("2026-11-05", 16) },
        // d2：1 天 1 轮（30s）
        { deviceId: "d2", role: "user", spokeAt: spokeAtOn("2026-11-05") },
        // assistant 不计入
        {
          deviceId: "d2",
          role: "assistant",
          spokeAt: spokeAtOn("2026-11-05", 17),
        },
      ],
      bindings: [],
      sleepConfigs: [],
      adventureProgresses: [],
      habitPlans: [],
    });
    const service = await buildService(prisma);

    const result = await service.getSummary({
      startDate: "2026-11-04",
      endDate: "2026-11-05",
    });

    expect(result.activeDevices).toBe(2);
    expect(result.totalTurns).toBe(5);
    expect(result.avgDurationSecondsPerDevice).toBe(75); // 150/2
    expect(result.durationP50Seconds).toBe(30);
    expect(result.durationP90Seconds).toBe(120);
    expect(result.avgActiveDaysPerDevice).toBe(1.5);
    expect(result.avgTurnsPerDevice).toBe(2.5);
  });

  it("duration-distribution：按估算秒数分桶", async () => {
    const prisma = buildPrisma({
      messages: [
        // d1：2 轮 = 60s → 0-5min
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn("2026-11-05") },
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn("2026-11-05", 13) },
        // d2：40 轮 = 1200s → 15-30min
        ...Array.from({ length: 40 }, (_, i) => ({
          deviceId: "d2",
          role: "user",
          spokeAt:
            spokeAtOn("2026-11-05", 12) &&
            new Date(spokeAtOn("2026-11-05").getTime() + i * 60000),
        })),
      ],
      bindings: [],
      sleepConfigs: [],
      adventureProgresses: [],
      habitPlans: [],
    });
    const service = await buildService(prisma);

    const result = await service.getDurationDistribution({
      date: "2026-11-05",
    });

    expect(result.date).toBe("2026-11-05");
    const byRange = new Map(result.buckets.map((b) => [b.range, b.devices]));
    expect(byRange.get("0-5min")).toBe(1);
    expect(byRange.get("15-30min")).toBe(1);
    expect(byRange.get("60min+")).toBe(0);
  });

  it("hourly-heatmap：7×24 网格，按设备去重", async () => {
    // 2026-11-02 是周一（Asia/Shanghai）
    const monday = "2026-11-02";
    const prisma = buildPrisma({
      messages: [
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn(monday, 17) },
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn(monday, 17) },
        { deviceId: "d2", role: "user", spokeAt: spokeAtOn(monday, 17) },
        { deviceId: "d2", role: "user", spokeAt: spokeAtOn(monday, 9) },
      ],
      bindings: [],
      sleepConfigs: [],
      adventureProgresses: [],
      habitPlans: [],
    });
    const service = await buildService(prisma);

    const result = await service.getHourlyHeatmap({
      startDate: monday,
      endDate: monday,
    });

    expect(result.grid).toHaveLength(7);
    expect(result.grid[0]).toHaveLength(24);
    expect(result.grid[0][17]).toBe(2); // 周一 17 点两台设备
    expect(result.grid[0][9]).toBe(1);
    expect(result.maxValue).toBe(2);
  });

  it("mode-usage：按日期 × 模式聚合，口径与 learning-stats 一致", async () => {
    const prisma = buildPrisma({
      messages: [
        {
          deviceId: "d1",
          role: "user",
          mode: "free_chat",
          spokeAt: spokeAtOn("2026-11-04"),
        },
        {
          deviceId: "d1",
          role: "user",
          mode: "english_chat",
          spokeAt: spokeAtOn("2026-11-04", 15),
        },
        {
          deviceId: "d2",
          role: "user",
          mode: "free_chat",
          spokeAt: spokeAtOn("2026-11-04", 16),
        },
      ],
      bindings: [],
      sleepConfigs: [],
      adventureProgresses: [],
      habitPlans: [],
    });
    const service = await buildService(prisma);

    const result = await service.getModeUsage({
      startDate: "2026-11-04",
      endDate: "2026-11-04",
    });

    expect(result.series).toHaveLength(1);
    const modes = result.series[0].modes;
    expect(modes[0]).toEqual({
      mode: "free_chat",
      turns: 2,
      devices: 2,
    });
    expect(modes[1].mode).toBe("english_chat");
  });

  it("feature-adoption：渗透率分母为已激活设备", async () => {
    const prisma = buildPrisma({
      messages: [
        {
          deviceId: "d1",
          role: "user",
          mode: "english_chat",
          spokeAt: spokeAtOn("2026-11-05"),
        },
      ],
      bindings: [
        { deviceId: "d1" },
        { deviceId: "d2" },
        { deviceId: "d3" },
        { deviceId: "d4" },
      ],
      sleepConfigs: [{ deviceId: "d1", enabled: true }],
      adventureProgresses: [
        { deviceId: "d1", status: "completed" },
        { deviceId: "d2", status: "in_progress" },
      ],
      habitPlans: [
        {
          deviceId: "d1",
          status: "active",
          targetDays: 21,
          dailyRecords: [{ completed: true }, { completed: false }],
        },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.getFeatureAdoption({ date: "2026-11-05" });
    const byKey = new Map(result.features.map((f) => [f.key, f]));

    expect(byKey.get("sleep_mode")?.penetrationRate).toBe(0.25);
    expect(byKey.get("adventure")?.activeDevices).toBe(2);
    expect(byKey.get("adventure")?.completionRate).toBe(0.5);
    expect(byKey.get("habit_plan")?.avgCompletionRate).toBeCloseTo(0.0476, 3);
    expect(byKey.get("english")?.activeDevices).toBe(1);
  });

  it("非法日期范围返回 400", async () => {
    const prisma = buildPrisma({
      messages: [],
      bindings: [],
      sleepConfigs: [],
      adventureProgresses: [],
      habitPlans: [],
    });
    const service = await buildService(prisma);

    await expect(
      service.getSummary({ startDate: "2026-11-06", endDate: "2026-11-04" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("shiftReportDate 可用性自检", () => {
    expect(shiftReportDate("2026-11-05", -1)).toBe("2026-11-04");
  });
});
