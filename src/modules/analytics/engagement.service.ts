import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  isValidReportDate,
  previousReportDate,
  reportDateInTimezone,
  reportDayRange,
  shiftReportDate,
} from "../learning-stats/parent-report-date.util";
import {
  AnalyticsDateQueryDto,
  AnalyticsDateRangeQueryDto,
} from "./dto/analytics-query.dto";
import { ESTIMATED_SECONDS_PER_USER_MESSAGE } from "./overview.service";

const DURATION_BUCKETS = [
  { range: "0-5min", max: 300 },
  { range: "5-15min", max: 900 },
  { range: "15-30min", max: 1800 },
  { range: "30-60min", max: 3600 },
  { range: "60min+", max: Infinity },
] as const;

function percentile(sorted: number[], p: number): number {
  if (sortedEmpty(sorted)) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function sortedEmpty(sorted: number[]): boolean {
  return sorted.length === 0;
}

/** 指定时区下的 (周一=0..周日=6, 小时 0-23) */
function weekdayHourInTimezone(
  date: Date,
  timeZone: string,
): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const map = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return {
    weekday: weekdayNames.indexOf(map.get("weekday") ?? "Mon"),
    hour: Number(map.get("hour") ?? 0),
  };
}

@Injectable()
export class EngagementService {
  constructor(private readonly prisma: PrismaService) {}

  private resolveRange(startDate: string, endDate: string) {
    if (!isValidReportDate(startDate) || !isValidReportDate(endDate)) {
      throw new BadRequestException("Invalid date");
    }
    if (startDate > endDate) {
      throw new BadRequestException("startDate must be <= endDate");
    }
    const { start } = reportDayRange(startDate, DEFAULT_REPORT_TIMEZONE);
    const { end } = reportDayRange(endDate, DEFAULT_REPORT_TIMEZONE);
    return { start, end };
  }

  private resolveDate(date?: string): string {
    const resolved =
      date ?? previousReportDate(new Date(), DEFAULT_REPORT_TIMEZONE);
    if (!isValidReportDate(resolved)) {
      throw new BadRequestException("Invalid date");
    }
    return resolved;
  }

  /** 区间内每设备聚合：turns / 活跃日期集合 / (weekday,hour) 活跃样本 */
  private async getDeviceActivity(start: Date, end: Date) {
    const messages = await this.prisma.message.findMany({
      where: { role: "user", spokeAt: { gte: start, lt: end } },
      select: { deviceId: true, spokeAt: true },
    });

    const perDevice = new Map<
      string,
      { turns: number; activeDays: Set<string> }
    >();
    const heatmapDevices: Set<string>[] = [];
    for (let i = 0; i < 7 * 24; i++) {
      heatmapDevices.push(new Set<string>());
    }

    for (const message of messages) {
      let bucket = perDevice.get(message.deviceId);
      if (!bucket) {
        bucket = { turns: 0, activeDays: new Set<string>() };
        perDevice.set(message.deviceId, bucket);
      }
      bucket.turns += 1;
      bucket.activeDays.add(
        reportDateInTimezone(message.spokeAt, DEFAULT_REPORT_TIMEZONE),
      );
      const { weekday, hour } = weekdayHourInTimezone(
        message.spokeAt,
        DEFAULT_REPORT_TIMEZONE,
      );
      if (weekday >= 0) {
        heatmapDevices[weekday * 24 + hour].add(message.deviceId);
      }
    }
    return { perDevice, heatmapDevices };
  }

  async getSummary(query: AnalyticsDateRangeQueryDto) {
    const { start, end } = this.resolveRange(query.startDate, query.endDate);
    const { perDevice } = await this.getDeviceActivity(start, end);

    const activeDevices = perDevice.size;
    const deviceStats = Array.from(perDevice.values());
    const totalTurns = deviceStats.reduce((sum, s) => sum + s.turns, 0);
    const durations = deviceStats
      .map((s) => s.turns * ESTIMATED_SECONDS_PER_USER_MESSAGE)
      .sort((a, b) => a - b);
    const turnsList = deviceStats.map((s) => s.turns).sort((a, b) => a - b);
    const totalActiveDays = deviceStats.reduce(
      (sum, s) => sum + s.activeDays.size,
      0,
    );

    return {
      activeDevices,
      avgDurationSecondsPerDevice:
        activeDevices > 0
          ? Math.round(
              (totalTurns * ESTIMATED_SECONDS_PER_USER_MESSAGE) / activeDevices,
            )
          : 0,
      durationP50Seconds: percentile(durations, 50),
      durationP90Seconds: percentile(durations, 90),
      avgTurnsPerDevice:
        activeDevices > 0
          ? Math.round((totalTurns / activeDevices) * 100) / 100
          : 0,
      turnsP50: percentile(turnsList, 50),
      avgActiveDaysPerDevice:
        activeDevices > 0
          ? Math.round((totalActiveDays / activeDevices) * 100) / 100
          : 0,
      totalTurns,
    };
  }

  async getDurationDistribution(query: AnalyticsDateQueryDto) {
    const date = this.resolveDate(query.date);
    const { start, end } = reportDayRange(date, DEFAULT_REPORT_TIMEZONE);
    const { perDevice } = await this.getDeviceActivity(start, end);

    const buckets = DURATION_BUCKETS.map(({ range }) => ({
      range,
      devices: 0,
    }));
    for (const stats of perDevice.values()) {
      const seconds = stats.turns * ESTIMATED_SECONDS_PER_USER_MESSAGE;
      const index = DURATION_BUCKETS.findIndex(
        (bucket) => seconds <= bucket.max,
      );
      buckets[index === -1 ? buckets.length - 1 : index].devices += 1;
    }
    return { date, buckets };
  }

  async getHourlyHeatmap(query: AnalyticsDateRangeQueryDto) {
    const { start, end } = this.resolveRange(query.startDate, query.endDate);
    const { heatmapDevices } = await this.getDeviceActivity(start, end);

    // grid[weekday][hour]，周一=0
    const grid: number[][] = [];
    let maxValue = 0;
    for (let weekday = 0; weekday < 7; weekday++) {
      const row: number[] = [];
      for (let hour = 0; hour < 24; hour++) {
        const value = heatmapDevices[weekday * 24 + hour].size;
        row.push(value);
        if (value > maxValue) maxValue = value;
      }
      grid.push(row);
    }
    return { grid, maxValue };
  }

  async getModeUsage(query: AnalyticsDateRangeQueryDto) {
    const { start, end } = this.resolveRange(query.startDate, query.endDate);
    const messages = await this.prisma.message.findMany({
      where: { role: "user", spokeAt: { gte: start, lt: end } },
      select: {
        deviceId: true,
        spokeAt: true,
        mode: true,
        conversationModeKey: true,
      },
    });

    // date -> mode|subMode -> { turns, devices }
    const byDate = new Map<
      string,
      Map<
        string,
        {
          mode: string;
          conversationModeKey: string | null;
          turns: number;
          devices: Set<string>;
        }
      >
    >();
    for (const message of messages) {
      const dateKey = reportDateInTimezone(
        message.spokeAt,
        DEFAULT_REPORT_TIMEZONE,
      );
      const mode = message.mode ?? "unknown";
      const subKey = message.conversationModeKey ?? null;
      const groupKey = `${mode}|${subKey ?? ""}`;

      let dateBucket = byDate.get(dateKey);
      if (!dateBucket) {
        dateBucket = new Map();
        byDate.set(dateKey, dateBucket);
      }
      let modeBucket = dateBucket.get(groupKey);
      if (!modeBucket) {
        modeBucket = {
          mode,
          conversationModeKey: subKey,
          turns: 0,
          devices: new Set<string>(),
        };
        dateBucket.set(groupKey, modeBucket);
      }
      modeBucket.turns += 1;
      modeBucket.devices.add(message.deviceId);
    }

    const series = Array.from(byDate.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, modes]) => ({
        date,
        modes: Array.from(modes.values())
          .map((bucket) => ({
            mode: bucket.mode,
            conversationModeKey: bucket.conversationModeKey,
            turns: bucket.turns,
            devices: bucket.devices.size,
          }))
          .sort((a, b) => b.turns - a.turns || a.mode.localeCompare(b.mode)),
      }));

    return { series };
  }

  async getFeatureAdoption(query: AnalyticsDateQueryDto) {
    const date = this.resolveDate(query.date);
    const { end } = reportDayRange(date, DEFAULT_REPORT_TIMEZONE);
    // 功能渗透按"近 30 天活跃"口径（含 date 当天共 30 个自然日）
    const { start: last30dStart } = reportDayRange(
      shiftReportDate(date, -29),
      DEFAULT_REPORT_TIMEZONE,
    );

    const bindings = await this.prisma.userDeviceBinding.findMany({
      select: { deviceId: true },
      distinct: ["deviceId"],
    });
    const activatedCount = bindings.length;

    const [sleepEnabled, adventureRows, habitPlans, englishMessages] =
      await Promise.all([
        this.prisma.sleepConfig.count({ where: { enabled: true } }),
        this.prisma.adventureProgress.findMany({
          select: { deviceId: true, status: true },
        }),
        this.prisma.habitPlan.findMany({
          where: { status: "active" },
          select: {
            deviceId: true,
            targetDays: true,
            dailyRecords: {
              select: { completed: true },
            },
          },
        }),
        this.prisma.message.findMany({
          where: {
            role: "user",
            mode: "english_chat",
            spokeAt: { gte: last30dStart, lt: end },
          },
          select: { deviceId: true },
          distinct: ["deviceId"],
        }),
      ]);

    const penetration = (count: number) =>
      activatedCount > 0
        ? Math.round((count / activatedCount) * 10000) / 10000
        : null;

    const adventureDevices = new Set(adventureRows.map((row) => row.deviceId));
    const adventureCompleted = adventureRows.filter(
      (row) => row.status === "completed",
    ).length;

    const habitDevices = new Set(habitPlans.map((plan) => plan.deviceId));
    const habitCompletionRates = habitPlans.map((plan) =>
      plan.targetDays > 0
        ? plan.dailyRecords.filter((record) => record.completed).length /
          plan.targetDays
        : 0,
    );
    const avgHabitCompletion =
      habitCompletionRates.length > 0
        ? Math.round(
            (habitCompletionRates.reduce((sum, rate) => sum + rate, 0) /
              habitCompletionRates.length) *
              10000,
          ) / 10000
        : null;

    return {
      date,
      features: [
        {
          key: "sleep_mode",
          label: "哄睡",
          enabledDevices: sleepEnabled,
          penetrationRate: penetration(sleepEnabled),
        },
        {
          key: "adventure",
          label: "冒险故事",
          activeDevices: adventureDevices.size,
          penetrationRate: penetration(adventureDevices.size),
          completionRate:
            adventureRows.length > 0
              ? Math.round(
                  (adventureCompleted / adventureRows.length) * 10000,
                ) / 10000
              : null,
        },
        {
          key: "habit_plan",
          label: "习惯打卡",
          activeDevices: habitDevices.size,
          penetrationRate: penetration(habitDevices.size),
          avgCompletionRate: avgHabitCompletion,
        },
        {
          key: "english",
          label: "英语对话",
          activeDevices: englishMessages.length,
          penetrationRate: penetration(englishMessages.length),
        },
      ],
    };
  }
}
