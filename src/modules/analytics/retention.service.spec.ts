import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  reportDateInTimezone,
  reportDayRange,
  shiftReportDate,
} from "../learning-stats/parent-report-date.util";
import { RetentionService } from "./retention.service";

type Row = Record<string, any>;

function spokeAtOn(dateKey: string, hour = 12): Date {
  const { start } = reportDayRange(dateKey, DEFAULT_REPORT_TIMEZONE);
  return new Date(start.getTime() + hour * 3600000);
}

function buildPrisma(data: { bindings: Row[]; messages: Row[] }) {
  return {
    userDeviceBinding: {
      findMany: jest.fn(() => data.bindings),
    },
    message: {
      findMany: jest.fn(({ where }: any = {}) =>
        where?.role
          ? data.messages.filter((m) => m.role === where.role)
          : data.messages,
      ),
    },
  };
}

async function buildService(prisma: any): Promise<RetentionService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [RetentionService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return module.get(RetentionService);
}

const TODAY = reportDateInTimezone(new Date(), DEFAULT_REPORT_TIMEZONE);

describe("RetentionService.getCohorts", () => {
  it("按周聚合 cohort，n=0 恒为 1，按 7 天周期判定留存", async () => {
    // cohort 周：21 天前；设备 d1 在第 1 周（+8 天）与第 2 周（+15 天）活跃；d2 流失
    const cohortDate = shiftReportDate(TODAY, -21);
    const prisma = buildPrisma({
      bindings: [
        { deviceId: "d1", createdAt: spokeAtOn(cohortDate) },
        { deviceId: "d2", createdAt: spokeAtOn(cohortDate) },
      ],
      messages: [
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn(cohortDate) },
        {
          deviceId: "d1",
          role: "user",
          spokeAt: spokeAtOn(shiftReportDate(cohortDate, 8)),
        },
        {
          deviceId: "d1",
          role: "user",
          spokeAt: spokeAtOn(shiftReportDate(cohortDate, 15)),
        },
        { deviceId: "d2", role: "user", spokeAt: spokeAtOn(cohortDate) },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.getCohorts({
      startDate: shiftReportDate(TODAY, -30),
      endDate: TODAY,
    });

    expect(result.basis).toBe("activation");
    expect(result.granularity).toBe("week");
    expect(result.cohorts).toHaveLength(1);
    const cohort = result.cohorts[0];
    expect(cohort.size).toBe(2);
    expect(cohort.retention[0]).toEqual({ n: 0, rate: 1 });
    expect(cohort.retention.find((p) => p.n === 1)?.rate).toBe(0.5);
    expect(cohort.retention.find((p) => p.n === 2)?.rate).toBe(0.5);
    // 第 3 周尚未完整经过（今天恰好 +21 天，period 3 区间未结束也算可算）
    expect(cohort.retention.find((p) => p.n === 3)?.rate).toBe(0);
  });

  it("范围外 cohort 不计入；非法日期返回 400", async () => {
    const prisma = buildPrisma({
      bindings: [
        { deviceId: "d1", createdAt: spokeAtOn(shiftReportDate(TODAY, -60)) },
      ],
      messages: [],
    });
    const service = await buildService(prisma);

    const result = await service.getCohorts({
      startDate: shiftReportDate(TODAY, -10),
      endDate: TODAY,
    });
    expect(result.cohorts).toHaveLength(0);

    await expect(
      service.getCohorts({ startDate: "2026-13-01", endDate: "2026-11-01" }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe("RetentionService.getCurve", () => {
  it("只有激活满 N 天的设备计入该点分母", async () => {
    // d1 激活 40 天前，第 30 天活跃；d2 激活 10 天前（不计入 d30 分母）
    const d1Date = shiftReportDate(TODAY, -40);
    const d2Date = shiftReportDate(TODAY, -10);
    const prisma = buildPrisma({
      bindings: [
        { deviceId: "d1", createdAt: spokeAtOn(d1Date) },
        { deviceId: "d2", createdAt: spokeAtOn(d2Date) },
      ],
      messages: [
        {
          deviceId: "d1",
          role: "user",
          spokeAt: spokeAtOn(shiftReportDate(d1Date, 30)),
        },
        {
          deviceId: "d1",
          role: "user",
          spokeAt: spokeAtOn(shiftReportDate(d1Date, 7)),
        },
        {
          deviceId: "d2",
          role: "user",
          spokeAt: spokeAtOn(shiftReportDate(d2Date, 7)),
        },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.getCurve({});

    expect(result.cohortSize).toBe(2);
    const byDay = new Map(result.points.map((p) => [p.day, p.rate]));
    expect(byDay.get(7)).toBe(1); // 两台都在第 7 天活跃
    expect(byDay.get(30)).toBe(1); // 只有 d1 计入且活跃
    expect(byDay.get(60)).toBeNull(); // 无设备激活满 60 天
    expect(byDay.get(90)).toBeNull();
  });
});

describe("RetentionService.getActivationFunnel", () => {
  it("shipped 恒 null，转化率按相邻步骤计算", async () => {
    const start = shiftReportDate(TODAY, -40);
    const end = TODAY;
    const cohortDate = shiftReportDate(TODAY, -35);
    const prisma = buildPrisma({
      bindings: [
        { deviceId: "d1", createdAt: spokeAtOn(cohortDate) },
        { deviceId: "d2", createdAt: spokeAtOn(cohortDate) },
      ],
      messages: [
        { deviceId: "d1", role: "user", spokeAt: spokeAtOn(cohortDate) },
        {
          deviceId: "d1",
          role: "user",
          spokeAt: spokeAtOn(shiftReportDate(cohortDate, 7)),
        },
        {
          deviceId: "d1",
          role: "user",
          spokeAt: spokeAtOn(shiftReportDate(cohortDate, 30)),
        },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.getActivationFunnel({
      startDate: start,
      endDate: end,
    });

    const steps = new Map(result.steps.map((s) => [s.key, s.value]));
    expect(steps.get("shipped")).toBeNull();
    expect(steps.get("activated")).toBe(2);
    expect(steps.get("first_conversation")).toBe(1); // 仅 d1 有消息
    expect(steps.get("active_d7")).toBe(1);
    expect(steps.get("active_d30")).toBe(1);

    const rates = new Map(result.conversionRates.map((r) => [r.to, r.rate]));
    expect(rates.get("activated")).toBeNull(); // 上一步 shipped 为 null
    expect(rates.get("first_conversation")).toBe(0.5);
    expect(rates.get("active_d7")).toBe(1);
  });
});

describe("RetentionService.getLatestRetention", () => {
  it("cohort 分母为 0 时返回 null", async () => {
    const prisma = buildPrisma({ bindings: [], messages: [] });
    const service = await buildService(prisma);

    await expect(service.getLatestRetention(TODAY)).resolves.toEqual({
      d1: null,
      d7: null,
      d30: null,
    });
  });
});
