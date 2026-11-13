import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { DeviceLinkService } from "../device-link/device-link.service";
import type { DeviceLinkStatus } from "../device-link/device-link.types";
import {
  DEFAULT_REPORT_TIMEZONE,
  isValidReportDate,
  previousReportDate,
  reportDateInTimezone,
  reportDayRange,
  shiftReportDate,
} from "../learning-stats/parent-report-date.util";
import {
  FleetChurnRiskQueryDto,
  FleetDeviceDetailQueryDto,
  FleetDevicesQueryDto,
  FleetPresenceTrendQueryDto,
  FleetSummaryQueryDto,
} from "./dto/fleet-query.dto";

const LOW_BATTERY_THRESHOLD = 20;
const MAX_PRESENCE_TREND_DAYS = 62;
const MAX_PAGE_SIZE = 100;

type DeviceLinkEntry = DeviceLinkStatus & { online: boolean };

export interface RealtimeSnapshot {
  online: boolean;
  battery: number | null;
  volume: number | null;
  version: string | null;
  charging: boolean | null;
  lastSeenAt: number | null;
}

/**
 * Redis 侧 MAC key 归一化，与 DeviceLinkService.normalizeMac（private）同口径：
 * 去分隔符 + 大写。getStatusBatch 返回的 Map 以归一化大写 MAC 为 key，而 Prisma
 * 侧 macAddress / deviceId 存的是小写，直接拿库里的值查必然全量 miss。
 */
function normalizeMac(raw: string): string {
  return raw.replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
}

/** Redis 无记录（lastSeenAt === null）或查询失败 → null，不得当作「离线」渲染 */
function toRealtime(status?: DeviceLinkEntry): RealtimeSnapshot | null {
  if (!status || status.lastSeenAt === null) return null;
  const { online, battery, volume, version, charging, lastSeenAt } = status;
  return { online, battery, volume, version, charging, lastSeenAt };
}

/** 设备详情与 404 判定共用的字段投影 */
const DEVICE_DETAIL_SELECT = {
  deviceId: true,
  id: true,
  characterKey: true,
  deviceCode: true,
  firmwareVersion: true,
  macAddress: true,
  wifiName: true,
  ipAddress: true,
  networkType: true,
  timezone: true,
  createdAt: true,
} as const;

@Injectable()
export class FleetService {
  private readonly logger = new Logger(FleetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deviceLink: DeviceLinkService,
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

  private async getFirstPresenceDate(): Promise<string | null> {
    const row = await this.prisma.devicePresenceDaily.findFirst({
      orderBy: { date: "asc" },
      select: { date: true },
    });
    return row?.date ?? null;
  }

  // ── 1. Summary ────────────────────────────────────────────────────────

  async getSummary(query: FleetSummaryQueryDto) {
    const date = this.resolveDate(query.date);
    const { end } = reportDayRange(date, DEFAULT_REPORT_TIMEZONE);

    const [totalDevices, activatedBindings, poweredOnCount, firstPresenceDate] =
      await Promise.all([
        this.prisma.device.count({ where: { createdAt: { lt: end } } }),
        // 已激活 = distinct deviceId（与 overview.service / engagement.service 同口径）；
        // 一台设备可被多个用户绑定，按绑定行数 count 会让开机率分母虚高
        this.prisma.userDeviceBinding.findMany({
          where: { createdAt: { lt: end } },
          select: { deviceId: true },
          distinct: ["deviceId"],
        }),
        // @@unique([deviceId, date]) 保证一台设备一天最多一行，故 count 即去重台数
        this.prisma.devicePresenceDaily.count({ where: { date } }),
        this.getFirstPresenceDate(),
      ]);
    const activatedCount = activatedBindings.length;

    // device_presence_daily 自上线日才有数据；早于该日的日期返回 null（「无数据」），而非 0（「零台开机」）
    const hasPresenceData =
      firstPresenceDate !== null && date >= firstPresenceDate;
    const devicesPoweredOn: number | null = hasPresenceData
      ? poweredOnCount
      : null;
    const powerOnRate: number | null =
      devicesPoweredOn !== null && activatedCount > 0
        ? Math.round((devicesPoweredOn / activatedCount) * 10000) / 10000
        : null;

    // 实时口径
    let onlineNow: number | null = null;
    let lowBatteryNow: number | null = null;
    try {
      const devices = await this.prisma.device.findMany({
        where: { createdAt: { lt: end } },
        select: { deviceId: true, macAddress: true },
      });
      const macs = devices.map(
        (d: { deviceId: string; macAddress: string | null }) =>
          d.macAddress ?? d.deviceId,
      );
      const statuses = await this.deviceLink.getStatusBatch(macs);
      let online = 0;
      let lowBattery = 0;
      for (const [, s] of statuses) {
        if (s.online) {
          online++;
          if (s.battery !== null && s.battery <= LOW_BATTERY_THRESHOLD)
            lowBattery++;
        }
      }
      onlineNow = online;
      lowBatteryNow = lowBattery;
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to query device online status: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return {
      date,
      totalDevices,
      activatedDevices: activatedCount,
      devicesPoweredOn,
      powerOnRate,
      onlineNow,
      lowBatteryNow,
      lowBatteryThreshold: LOW_BATTERY_THRESHOLD,
      presenceSince: firstPresenceDate,
    };
  }

  // ── 2. Presence Trend ─────────────────────────────────────────────────

  async getPresenceTrend(query: FleetPresenceTrendQueryDto) {
    if (
      !isValidReportDate(query.startDate) ||
      !isValidReportDate(query.endDate)
    ) {
      throw new BadRequestException("Invalid date");
    }
    if (query.startDate > query.endDate) {
      throw new BadRequestException("startDate must be <= endDate");
    }

    // 计算天数差
    const start = new Date(`${query.startDate}T00:00:00Z`);
    const end = new Date(`${query.endDate}T00:00:00Z`);
    const dayDiff =
      (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24) + 1;
    if (dayDiff > MAX_PRESENCE_TREND_DAYS) {
      throw new BadRequestException(
        `Date range exceeds ${MAX_PRESENCE_TREND_DAYS} days maximum`,
      );
    }

    const [presenceRows, firstPresenceDate, bindings] = await Promise.all([
      this.prisma.devicePresenceDaily.findMany({
        where: {
          date: { gte: query.startDate, lte: query.endDate },
        },
        select: { deviceId: true, date: true, reportCount: true },
      }),
      this.getFirstPresenceDate(),
      // 每台设备取其最早一次绑定时间；distinct 不保证挑到哪一行，必须用 _min
      this.prisma.userDeviceBinding.groupBy({
        by: ["deviceId"],
        where: {
          createdAt: {
            lt: reportDayRange(query.endDate, DEFAULT_REPORT_TIMEZONE).end,
          },
        },
        _min: { createdAt: true },
      }),
    ]);

    // 构建日级数据：date -> { devices: Set, reportCount: number }
    const dailyMap = new Map<
      string,
      { devices: Set<string>; reportCount: number }
    >();
    for (const row of presenceRows) {
      let bucket = dailyMap.get(row.date);
      if (!bucket) {
        bucket = { devices: new Set(), reportCount: 0 };
        dailyMap.set(row.date, bucket);
      }
      bucket.devices.add(row.deviceId);
      bucket.reportCount += row.reportCount;
    }

    // 逐日累积已激活设备数
    const cumulativeActivated = new Map<string, number>();
    let activatedSoFar = 0;
    const sortedBindings = bindings
      .map((b) => ({ deviceId: b.deviceId, createdAt: b._min.createdAt }))
      .filter(
        (b): b is { deviceId: string; createdAt: Date } => b.createdAt !== null,
      )
      .map((b) => ({
        deviceId: b.deviceId,
        createdDate: reportDateInTimezone(b.createdAt, DEFAULT_REPORT_TIMEZONE),
      }))
      .sort((a, b) => a.createdDate.localeCompare(b.createdDate));
    const activatedDeviceIds = new Set<string>();
    for (const b of sortedBindings) {
      if (!activatedDeviceIds.has(b.deviceId)) {
        activatedDeviceIds.add(b.deviceId);
        activatedSoFar++;
      }
      cumulativeActivated.set(b.createdDate, activatedSoFar);
    }

    // 填充期间每一天
    const series: Array<{
      date: string;
      devicesPoweredOn: number | null;
      powerOnRate: number | null;
      reportCount: number | null;
    }> = [];
    for (
      let cursor = query.startDate;
      cursor <= query.endDate;
      cursor = shiftReportDate(cursor, 1)
    ) {
      const hasPresence =
        firstPresenceDate !== null && cursor >= firstPresenceDate;
      const day = dailyMap.get(cursor);

      const devicesPoweredOn: number | null = hasPresence
        ? (day?.devices.size ?? 0)
        : null;
      const reportCount: number | null = hasPresence
        ? (day?.reportCount ?? 0)
        : null;

      // 当日累计已激活设备数作为分母
      let denominator = 0;
      for (const [d, count] of cumulativeActivated.entries()) {
        if (d <= cursor) denominator = count;
        else break;
      }
      const powerOnRate: number | null =
        devicesPoweredOn !== null && denominator > 0
          ? Math.round((devicesPoweredOn / denominator) * 10000) / 10000
          : null;

      series.push({ date: cursor, devicesPoweredOn, powerOnRate, reportCount });
    }

    return {
      startDate: query.startDate,
      endDate: query.endDate,
      presenceSince: firstPresenceDate,
      series,
    };
  }

  // ── 3. Firmware Distribution ──────────────────────────────────────────

  async getFirmwareDistribution() {
    const groups = await this.prisma.device.groupBy({
      by: ["firmwareVersion"],
      _count: { _all: true },
      orderBy: { _count: { firmwareVersion: "desc" } },
    });

    let total = 0;
    const bucketMap = new Map<string, number>();

    for (const g of groups) {
      const fw = g.firmwareVersion;
      const key = fw && fw.length > 0 ? fw : "unknown";
      const count = g._count._all;
      bucketMap.set(key, (bucketMap.get(key) ?? 0) + count);
      total += count;
    }

    const buckets = Array.from(bucketMap.entries()).map(
      ([firmwareVersion, devices]) => ({ firmwareVersion, devices }),
    );

    buckets.sort((a, b) => {
      if (b.devices !== a.devices) return b.devices - a.devices;
      if (a.firmwareVersion === "unknown") return 1;
      if (b.firmwareVersion === "unknown") return -1;
      return a.firmwareVersion.localeCompare(b.firmwareVersion);
    });

    return { total, buckets };
  }

  // ── 4. Churn Risk ─────────────────────────────────────────────────────

  async getChurnRisk(query: FleetChurnRiskQueryDto) {
    const days = query.days ?? 7;

    const now = new Date(Date.now());
    const asOf = reportDateInTimezone(now, DEFAULT_REPORT_TIMEZONE);

    const devices = await this.prisma.device.findMany({
      select: {
        deviceId: true,
        characterKey: true,
        firmwareVersion: true,
        createdAt: true,
        id: true,
      },
    });

    // 批量取所有设备的 presence 最后活跃时间
    const deviceIds = devices.map((d) => d.id);
    const presenceMaxes = await this.prisma.devicePresenceDaily.groupBy({
      by: ["deviceId"],
      where: { deviceId: { in: deviceIds } },
      _max: { lastSeenAt: true },
    });
    const presenceMap = new Map<string, Date | null>();
    for (const p of presenceMaxes) {
      presenceMap.set(p.deviceId, p._max.lastSeenAt);
    }

    // 批量取所有设备的 message 最后发言时间
    const messageMaxes = await this.prisma.message.groupBy({
      by: ["deviceId"],
      where: { deviceId: { in: deviceIds }, role: "user" },
      _max: { spokeAt: true },
    });
    const messageMap = new Map<string, Date | null>();
    for (const m of messageMaxes) {
      messageMap.set(m.deviceId, m._max.spokeAt);
    }

    const riskDevices: Array<{
      deviceId: string;
      characterKey: string;
      firmwareVersion: string | null;
      lastActiveAt: string | null;
      daysInactive: number;
      basis: string;
    }> = [];

    for (const device of devices) {
      // 确定 lastActiveAt 及其 basis
      let lastActiveAt: Date;
      let basis: string;

      const presenceLast = presenceMap.get(device.id) ?? null;
      const messageLast = messageMap.get(device.id) ?? null;

      if (presenceLast) {
        lastActiveAt = presenceLast;
        basis = "presence";
      } else if (messageLast) {
        lastActiveAt = messageLast;
        basis = "message";
      } else {
        lastActiveAt = device.createdAt;
        basis = "createdAt";
      }

      // 计算自然日差（Asia/Shanghai）
      const lastActiveDateStr = reportDateInTimezone(
        lastActiveAt,
        DEFAULT_REPORT_TIMEZONE,
      );
      const lastActiveDate = new Date(`${lastActiveDateStr}T00:00:00Z`);
      const asOfDate = new Date(`${asOf}T00:00:00Z`);
      const daysInactive = Math.max(
        0,
        Math.floor(
          (asOfDate.getTime() - lastActiveDate.getTime()) /
            (1000 * 60 * 60 * 24),
        ),
      );

      if (daysInactive >= days) {
        riskDevices.push({
          deviceId: device.deviceId,
          characterKey: device.characterKey,
          firmwareVersion: device.firmwareVersion,
          lastActiveAt: lastActiveAt.toISOString(),
          daysInactive,
          basis,
        });
      }
    }

    riskDevices.sort((a, b) => b.daysInactive - a.daysInactive);

    return {
      days,
      asOf,
      count: riskDevices.length,
      devices: riskDevices,
    };
  }

  // ── 5. Devices List ───────────────────────────────────────────────────

  async getDevices(query: FleetDevicesQueryDto) {
    const page = query.page ?? 1;
    let pageSize = query.pageSize ?? 20;
    if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

    const where: Record<string, unknown> = {};
    if (query.keyword) {
      // 参数化 contains + mode: "insensitive"，禁止 $queryRaw 字符串拼接
      where.OR = [
        { deviceId: { contains: query.keyword, mode: "insensitive" } },
        { deviceCode: { contains: query.keyword, mode: "insensitive" } },
        { macAddress: { contains: query.keyword, mode: "insensitive" } },
      ];
    }

    const [total, items] = await Promise.all([
      this.prisma.device.count({ where }),
      this.prisma.device.findMany({
        where,
        select: {
          deviceId: true,
          id: true,
          characterKey: true,
          deviceCode: true,
          firmwareVersion: true,
          macAddress: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    // 批量获取实时状态
    let statusMap = new Map<string, DeviceLinkEntry>();
    try {
      const macs = items.map((d) => d.macAddress ?? d.deviceId);
      statusMap = await this.deviceLink.getStatusBatch(macs);
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to query device online status for devices list: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // 批量获取 presence 近7天数据
    const sevenDaysAgo = shiftReportDate(
      reportDateInTimezone(new Date(Date.now()), DEFAULT_REPORT_TIMEZONE),
      -6,
    );
    const deviceUuids = items.map((d) => d.id);
    const [presenceRows, messageCounts] = await Promise.all([
      this.prisma.devicePresenceDaily.findMany({
        where: {
          deviceId: { in: deviceUuids },
          date: { gte: sevenDaysAgo },
        },
        select: { deviceId: true, date: true },
      }),
      this.prisma.message.groupBy({
        by: ["deviceId"],
        where: {
          deviceId: { in: deviceUuids },
          role: "user",
          spokeAt: {
            gte: reportDayRange(sevenDaysAgo, DEFAULT_REPORT_TIMEZONE).start,
          },
        },
        _count: { _all: true },
      }),
    ]);

    // 构建 presence 映射: deviceId -> Set<date>
    const presenceMap = new Map<string, Set<string>>();
    for (const p of presenceRows) {
      let dates = presenceMap.get(p.deviceId);
      if (!dates) {
        dates = new Set();
        presenceMap.set(p.deviceId, dates);
      }
      dates.add(p.date);
    }

    // 获取每个设备最后 presence 日期
    const lastPresenceRows = await this.prisma.devicePresenceDaily.groupBy({
      by: ["deviceId"],
      where: { deviceId: { in: deviceUuids } },
      _max: { date: true },
    });
    const lastPresenceMap = new Map<string, string | null>();
    for (const r of lastPresenceRows) {
      lastPresenceMap.set(r.deviceId, r._max.date ?? null);
    }

    // 构建消息映射: deviceId -> count
    const messageMap = new Map<string, number>();
    for (const m of messageCounts) {
      messageMap.set(m.deviceId, m._count._all);
    }

    // 已绑定用户数
    const bindingCounts = await this.prisma.userDeviceBinding.groupBy({
      by: ["deviceId"],
      where: { deviceId: { in: deviceUuids } },
      _count: { _all: true },
    });
    const bindingMap = new Map<string, number>();
    for (const b of bindingCounts) {
      bindingMap.set(b.deviceId, b._count._all);
    }

    const list = items.map((d) => {
      const realtime = toRealtime(
        statusMap.get(normalizeMac(d.macAddress ?? d.deviceId)),
      );

      const presenceDates = presenceMap.get(d.id);
      const presenceDays7d = presenceDates?.size ?? 0;
      const lastPresenceDate = lastPresenceMap.get(d.id) ?? null;

      return {
        deviceId: d.deviceId,
        deviceUuid: d.id,
        characterKey: d.characterKey,
        deviceCode: d.deviceCode,
        firmwareVersion: d.firmwareVersion,
        macAddress: d.macAddress,
        createdAt: d.createdAt.toISOString(),
        boundUsers: bindingMap.get(d.id) ?? 0,
        realtime,
        presenceDays7d,
        lastPresenceDate,
        turns7d: messageMap.get(d.id) ?? 0,
      };
    });

    return { page, pageSize, total, items: list };
  }

  // ── 6. Device Detail ──────────────────────────────────────────────────

  async getDeviceDetail(deviceId: string, query: FleetDeviceDetailQueryDto) {
    const days = query.days ?? 30;

    // 库里的 deviceId 存量数据大小写混用，精确匹配优先；未命中再做大小写不敏感兜底，
    // 保证列表接口返回的 deviceId 能原样回传查到（查不到仍为 404）
    const device =
      (await this.prisma.device.findUnique({
        where: { deviceId },
        select: DEVICE_DETAIL_SELECT,
      })) ??
      (await this.prisma.device.findFirst({
        where: { deviceId: { equals: deviceId, mode: "insensitive" } },
        select: DEVICE_DETAIL_SELECT,
      }));

    if (!device) {
      return null;
    }

    // 实时状态
    let realtime: RealtimeSnapshot | null = null;
    try {
      const mac = device.macAddress ?? device.deviceId;
      const statusMap = await this.deviceLink.getStatusBatch([mac]);
      realtime = toRealtime(statusMap.get(normalizeMac(mac)));
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to query device online status for ${deviceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // 绑定用户（仅 userId + isOwner + boundAt，无 PII）
    const bindings = await this.prisma.userDeviceBinding.findMany({
      where: { deviceId: device.id },
      select: { userId: true, isOwner: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    const boundUsers = bindings.map((b) => ({
      userId: b.userId,
      isOwner: b.isOwner,
      boundAt: b.createdAt.toISOString(),
    }));

    // Presence 近 days 天
    const startDateStr = shiftReportDate(
      reportDateInTimezone(new Date(Date.now()), DEFAULT_REPORT_TIMEZONE),
      -(days - 1),
    );
    const presenceRows = await this.prisma.devicePresenceDaily.findMany({
      where: { deviceId: device.id, date: { gte: startDateStr } },
      orderBy: { date: "asc" },
      select: {
        date: true,
        reportCount: true,
        firstSeenAt: true,
        lastSeenAt: true,
      },
    });

    const presence = presenceRows.map((p) => ({
      date: p.date,
      reportCount: p.reportCount,
      firstSeenAt: p.firstSeenAt ? p.firstSeenAt.toISOString() : null,
      lastSeenAt: p.lastSeenAt ? p.lastSeenAt.toISOString() : null,
    }));

    // Daily turns 近 days 天（role=user 的消息，按日聚合，缺失日补 0）
    const { start: turnsStart } = reportDayRange(
      startDateStr,
      DEFAULT_REPORT_TIMEZONE,
    );
    const messages = await this.prisma.message.findMany({
      where: {
        deviceId: device.id,
        role: "user",
        spokeAt: { gte: turnsStart },
      },
      select: { spokeAt: true },
    });

    const turnsByDay = new Map<string, number>();
    for (const m of messages) {
      const dateKey = reportDateInTimezone(m.spokeAt, DEFAULT_REPORT_TIMEZONE);
      turnsByDay.set(dateKey, (turnsByDay.get(dateKey) ?? 0) + 1);
    }

    // days >= 1 由 DTO 保证，故 startDateStr 恒不晚于今天，dailyTurns 补零到今天
    const todayStr = reportDateInTimezone(
      new Date(Date.now()),
      DEFAULT_REPORT_TIMEZONE,
    );

    const dailyTurns: Array<{ date: string; turns: number }> = [];
    for (
      let cursor = startDateStr;
      cursor <= todayStr;
      cursor = shiftReportDate(cursor, 1)
    ) {
      dailyTurns.push({ date: cursor, turns: turnsByDay.get(cursor) ?? 0 });
    }

    return {
      deviceId: device.deviceId,
      deviceUuid: device.id,
      characterKey: device.characterKey,
      deviceCode: device.deviceCode,
      firmwareVersion: device.firmwareVersion,
      macAddress: device.macAddress,
      wifiName: device.wifiName,
      ipAddress: device.ipAddress,
      networkType: device.networkType,
      timezone: device.timezone,
      createdAt: device.createdAt.toISOString(),
      realtime,
      boundUsers,
      presence,
      dailyTurns,
      totals: {
        presenceDays: presenceRows.length,
        turns: Array.from(turnsByDay.values()).reduce((a, b) => a + b, 0),
      },
    };
  }
}
