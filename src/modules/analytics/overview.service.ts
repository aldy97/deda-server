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
  AnalyticsTrendQueryDto,
} from "./dto/analytics-query.dto";
import { RetentionService } from "./retention.service";

/** 估算口径：每条 user 消息 = 0.5 分钟（与小程序家长端 learning-stats 同源） */
export const ESTIMATED_SECONDS_PER_USER_MESSAGE = 30;

const TREND_METRIC_KEYS = [
  "dau",
  "avgDuration",
  "poweredOn",
  "newActivated",
  "newUsers",
] as const;

type TrendMetricKey = (typeof TREND_METRIC_KEYS)[number];

@Injectable()
export class OverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly retentionService: RetentionService,
  ) {}

  /** 解析 date 参数：缺省=昨天（Asia/Shanghai 完整自然日 T-1） */
  private resolveDate(date?: string): string {
    const resolved =
      date ?? previousReportDate(new Date(), DEFAULT_REPORT_TIMEZONE);
    if (!isValidReportDate(resolved)) {
      throw new BadRequestException("Invalid date");
    }
    return resolved;
  }

  /** 区间内每台设备的消息日聚合：dateKey -> { devices, turns } */
  private async getDailyActivity(
    deviceIds: string[] | undefined,
    start: Date,
    end: Date,
  ): Promise<Map<string, { devices: Set<string>; turns: number }>> {
    const messages = await this.prisma.message.findMany({
      where: {
        role: "user",
        spokeAt: { gte: start, lt: end },
        ...(deviceIds ? { deviceId: { in: deviceIds } } : {}),
      },
      select: { deviceId: true, spokeAt: true },
    });
    const daily = new Map<string, { devices: Set<string>; turns: number }>();
    for (const message of messages) {
      const dateKey = reportDateInTimezone(
        message.spokeAt,
        DEFAULT_REPORT_TIMEZONE,
      );
      let bucket = daily.get(dateKey);
      if (!bucket) {
        bucket = { devices: new Set<string>(), turns: 0 };
        daily.set(dateKey, bucket);
      }
      bucket.devices.add(message.deviceId);
      bucket.turns += 1;
    }
    return daily;
  }

  private async getActivatedDeviceIds(before: Date): Promise<Set<string>> {
    const bindings = await this.prisma.userDeviceBinding.findMany({
      where: { createdAt: { lt: before } },
      select: { deviceId: true },
      distinct: ["deviceId"],
    });
    return new Set(bindings.map((binding) => binding.deviceId));
  }

  async getOverview(query: AnalyticsDateQueryDto) {
    const date = this.resolveDate(query.date);
    const { start, end } = reportDayRange(date, DEFAULT_REPORT_TIMEZONE);
    const prevDay = reportDayRange(
      shiftReportDate(date, -1),
      DEFAULT_REPORT_TIMEZONE,
    );
    const last7dStart = reportDayRange(
      shiftReportDate(date, -6),
      DEFAULT_REPORT_TIMEZONE,
    ).start;

    const [
      devicesRegistered,
      usersRegistered,
      activatedIds,
      daily,
      prevDaily,
      firstConversationIds,
      active7dIds,
      retention,
    ] = await Promise.all([
      this.prisma.device.count({ where: { createdAt: { lt: end } } }),
      this.prisma.user.count({ where: { createdAt: { lt: end } } }),
      this.getActivatedDeviceIds(end),
      this.getDailyActivity(undefined, start, end),
      this.getDailyActivity(undefined, prevDay.start, prevDay.end),
      this.prisma.message.findMany({
        where: { role: "user", spokeAt: { lt: end } },
        select: { deviceId: true },
        distinct: ["deviceId"],
      }),
      this.prisma.message.findMany({
        where: { role: "user", spokeAt: { gte: last7dStart, lt: end } },
        select: { deviceId: true },
        distinct: ["deviceId"],
      }),
      this.retentionService.getLatestRetention(date),
    ]);

    const dayBucket = daily.get(date);
    const dau = dayBucket?.devices.size ?? 0;
    const turns = dayBucket?.turns ?? 0;
    const prevDau = prevDaily.get(shiftReportDate(date, -1))?.devices.size ?? 0;

    return {
      date,
      totals: {
        devicesRegistered,
        devicesActivated: activatedIds.size,
        usersRegistered,
        // 无出货数据时分母退化为已入库设备数（Swagger 标注）
        activationRate:
          devicesRegistered > 0
            ? Math.round((activatedIds.size / devicesRegistered) * 10000) /
              10000
            : null,
      },
      today: {
        dau,
        dauDeltaPct:
          prevDau > 0
            ? Math.round(((dau - prevDau) / prevDau) * 10000) / 100
            : null,
        avgDurationSecondsPerActiveDevice:
          dau > 0
            ? Math.round((turns * ESTIMATED_SECONDS_PER_USER_MESSAGE) / dau)
            : 0,
        avgTurnsPerActiveDevice:
          dau > 0 ? Math.round((turns / dau) * 100) / 100 : 0,
        // 开机率依赖 device_presence_daily（二期落库），一期恒 null
        devicesPoweredOn: null,
        powerOnRate: null,
        // onlineNow 依赖 Redis 在线集合（二期），一期恒 null
        onlineNow: null,
      },
      retention,
      funnel: {
        shipped: null,
        activated: activatedIds.size,
        firstConversation: firstConversationIds.length,
        active7d: active7dIds.length,
      },
    };
  }

  async getTrend(query: AnalyticsTrendQueryDto) {
    if (
      !isValidReportDate(query.startDate) ||
      !isValidReportDate(query.endDate)
    ) {
      throw new BadRequestException("Invalid date");
    }
    if (query.startDate > query.endDate) {
      throw new BadRequestException("startDate must be <= endDate");
    }
    const granularity = query.granularity ?? "day";

    let metricKeys: TrendMetricKey[] = [...TREND_METRIC_KEYS];
    if (query.metrics) {
      const requested = query.metrics.split(",").map((item) => item.trim());
      const invalid = requested.filter(
        (item): item is string =>
          !TREND_METRIC_KEYS.includes(item as TrendMetricKey),
      );
      if (invalid.length > 0 || requested.length === 0) {
        throw new BadRequestException(`Invalid metrics: ${invalid.join(",")}`);
      }
      metricKeys = requested as TrendMetricKey[];
    }

    // characterKey 过滤：先解析设备范围（messages 表无该字段，需先查 devices）
    let deviceIds: string[] | undefined;
    if (query.characterKey) {
      const devices = await this.prisma.device.findMany({
        where: { characterKey: query.characterKey },
        select: { id: true },
      });
      deviceIds = devices.map((device) => device.id);
    }

    const { start } = reportDayRange(query.startDate, DEFAULT_REPORT_TIMEZONE);
    const { end } = reportDayRange(query.endDate, DEFAULT_REPORT_TIMEZONE);

    const [daily, bindings, users] = await Promise.all([
      this.getDailyActivity(deviceIds, start, end),
      this.prisma.userDeviceBinding.findMany({
        where: { createdAt: { gte: start, lt: end } },
        select: { deviceId: true, createdAt: true },
        distinct: ["deviceId"],
      }),
      this.prisma.user.findMany({
        where: { createdAt: { gte: start, lt: end } },
        select: { createdAt: true },
      }),
    ]);

    const newActivatedByDay = new Map<string, number>();
    for (const binding of bindings) {
      const dateKey = reportDateInTimezone(
        binding.createdAt,
        DEFAULT_REPORT_TIMEZONE,
      );
      newActivatedByDay.set(dateKey, (newActivatedByDay.get(dateKey) ?? 0) + 1);
    }
    const newUsersByDay = new Map<string, number>();
    for (const user of users) {
      const dateKey = reportDateInTimezone(
        user.createdAt,
        DEFAULT_REPORT_TIMEZONE,
      );
      newUsersByDay.set(dateKey, (newUsersByDay.get(dateKey) ?? 0) + 1);
    }

    // 日级数据先展开，再按粒度聚合（week/month 桶内：dau/时长按桶内去重与合计）
    const dayKeys: string[] = [];
    for (
      let cursor = query.startDate;
      cursor <= query.endDate;
      cursor = shiftReportDate(cursor, 1)
    ) {
      dayKeys.push(cursor);
    }

    const buckets = new Map<
      string,
      {
        devices: Set<string>;
        turns: number;
        newActivated: number;
        newUsers: number;
      }
    >();
    const bucketKeyOf = (dateKey: string): string => {
      if (granularity === "day") return dateKey;
      if (granularity === "month") return dateKey.slice(0, 7);
      // week：ISO 周的周一
      const date = new Date(`${dateKey}T00:00:00Z`);
      const dayNum = (date.getUTCDay() + 6) % 7;
      date.setUTCDate(date.getUTCDate() - dayNum);
      return date.toISOString().slice(0, 10);
    };

    for (const dateKey of dayKeys) {
      const key = bucketKeyOf(dateKey);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          devices: new Set<string>(),
          turns: 0,
          newActivated: 0,
          newUsers: 0,
        };
        buckets.set(key, bucket);
      }
      const day = daily.get(dateKey);
      if (day) {
        for (const deviceId of day.devices) {
          bucket.devices.add(deviceId);
        }
        bucket.turns += day.turns;
      }
      bucket.newActivated += newActivatedByDay.get(dateKey) ?? 0;
      bucket.newUsers += newUsersByDay.get(dateKey) ?? 0;
    }

    const series = Array.from(buckets.entries()).map(([bucketKey, bucket]) => {
      const dau = bucket.devices.size;
      const point: Record<string, string | number | null> = {
        date: bucketKey,
      };
      if (metricKeys.includes("dau")) point.dau = dau;
      if (metricKeys.includes("avgDuration")) {
        point.avgDurationSeconds =
          dau > 0
            ? Math.round(
                (bucket.turns * ESTIMATED_SECONDS_PER_USER_MESSAGE) / dau,
              )
            : 0;
      }
      if (metricKeys.includes("poweredOn")) point.devicesPoweredOn = null;
      if (metricKeys.includes("newActivated")) {
        point.newActivatedDevices = bucket.newActivated;
      }
      if (metricKeys.includes("newUsers")) point.newUsers = bucket.newUsers;
      return point;
    });

    return {
      startDate: query.startDate,
      endDate: query.endDate,
      granularity,
      series,
    };
  }
}
