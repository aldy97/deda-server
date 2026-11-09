import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";

/**
 * child_memories.key 白名单 5 槽位，字典序固定输出。
 * 新增槽位属于契约变更，需同步 dashboard 前端。
 */
export const MEMORY_SLOT_KEYS = [
  "favorite_animal",
  "favorite_color",
  "favorite_story_type",
  "interest_topic",
  "preferred_interaction",
] as const;

export type MemorySlotKey = (typeof MEMORY_SLOT_KEYS)[number];

export interface MemoriesDevicesQuery {
  keyword?: string;
  page?: number;
  pageSize?: number;
}

/** 占比统一 4 位小数（0.2857 口径）；分母为 0 时返回 0 */
function ratio(part: number, whole: number): number {
  if (whole === 0) return 0;
  return Math.round((part / whole) * 10000) / 10000;
}

/**
 * 记忆档案（child_memories）监控，dashboard 内部用。
 * deviceId 出入参一律业务 ID（Device.deviceId），内部 resolve 成 Device.id，
 * 口径同 messages-analytics。
 */
@Injectable()
export class MemoriesAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** 全局汇总：分母为至少有 1 条消息的设备数（非 devices 表全量） */
  async getOverview() {
    const [messageDevices, activePairs, totalActiveMemories, totalVersions] =
      await Promise.all([
        this.prisma.message.groupBy({ by: ["deviceId"] }),
        this.prisma.childMemory.groupBy({
          by: ["deviceId", "key"],
          where: { status: "active" },
        }),
        this.prisma.childMemory.count({ where: { status: "active" } }),
        this.prisma.childMemory.count(),
      ]);

    const deviceTotal = messageDevices.length;
    const deviceWithMemories = new Set(activePairs.map((p) => p.deviceId)).size;

    const slotCoverage = MEMORY_SLOT_KEYS.map((key) => {
      const deviceCount = new Set(
        activePairs.filter((p) => p.key === key).map((p) => p.deviceId),
      ).size;
      return { key, deviceCount, coverage: ratio(deviceCount, deviceTotal) };
    });

    return {
      deviceTotal,
      deviceWithMemories,
      deviceCoverage: ratio(deviceWithMemories, deviceTotal),
      totalActiveMemories,
      totalVersions,
      slotCoverage,
    };
  }

  /**
   * 设备列表：只返回至少有 1 条记忆版本行的设备，按 lastChangeAt 倒序。
   * 数据量为内部 dashboard 级别，groupBy 后 JS 排序 + 切片分页。
   */
  async listDevices(query: MemoriesDevicesQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    let deviceFilter: Prisma.ChildMemoryWhereInput = {};
    if (query.keyword) {
      const matched = await this.prisma.device.findMany({
        where: {
          OR: [
            { deviceId: { contains: query.keyword, mode: "insensitive" } },
            { deviceCode: { contains: query.keyword, mode: "insensitive" } },
          ],
        },
        select: { id: true },
      });
      if (matched.length === 0) {
        return { total: 0, page, pageSize, items: [] };
      }
      deviceFilter = { deviceId: { in: matched.map((d) => d.id) } };
    }

    const groups = await this.prisma.childMemory.groupBy({
      by: ["deviceId"],
      where: deviceFilter,
      _count: { _all: true },
      _max: { createdAt: true },
    });

    const sorted = groups
      .map((g) => ({
        deviceUuid: g.deviceId,
        totalVersions: g._count._all,
        lastChangeAt: g._max.createdAt,
      }))
      .sort((a, b) => +(b.lastChangeAt ?? 0) - +(a.lastChangeAt ?? 0));

    const total = sorted.length;
    const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize);
    const pageIds = pageRows.map((r) => r.deviceUuid);

    const [activeGroups, devices] = await Promise.all([
      pageIds.length
        ? this.prisma.childMemory.groupBy({
            by: ["deviceId"],
            where: { status: "active", deviceId: { in: pageIds } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
      pageIds.length
        ? this.prisma.device.findMany({
            where: { id: { in: pageIds } },
            select: { id: true, deviceId: true, deviceCode: true },
          })
        : Promise.resolve([]),
    ]);

    const activeMap = new Map(
      activeGroups.map((g) => [g.deviceId, g._count._all]),
    );
    const deviceMap = new Map(devices.map((d) => [d.id, d]));

    return {
      total,
      page,
      pageSize,
      items: pageRows.map((r) => {
        const device = deviceMap.get(r.deviceUuid);
        return {
          deviceId: device?.deviceId ?? r.deviceUuid,
          deviceCode: device?.deviceCode ?? null,
          activeCount: activeMap.get(r.deviceUuid) ?? 0,
          totalVersions: r.totalVersions,
          lastChangeAt: r.lastChangeAt,
        };
      }),
    };
  }

  /** 某设备当前有效记忆（status=active）；空槽位不回，前端按 5 槽位补齐 */
  async getCurrentMemories(bizDeviceId: string) {
    const device = await this.resolveDevice(bizDeviceId);
    const memories = await this.prisma.childMemory.findMany({
      where: { deviceId: device.id, status: "active" },
      orderBy: { key: "asc" },
      select: {
        key: true,
        valueText: true,
        version: true,
        confidence: true,
        injectionCount: true,
        lastInjectedAt: true,
        lastConfirmedAt: true,
        validFrom: true,
      },
    });
    return { deviceId: device.deviceId, memories };
  }

  /** 单槽位版本链：全部版本升序（含 retract 墓碑行，valueText 为 null） */
  async getMemoryHistory(bizDeviceId: string, key: string) {
    const device = await this.resolveDevice(bizDeviceId);
    const versions = await this.prisma.childMemory.findMany({
      where: { deviceId: device.id, key },
      orderBy: { version: "asc" },
      select: {
        id: true,
        version: true,
        changeType: true,
        status: true,
        valueText: true,
        confidence: true,
        sourceTurnId: true,
        validFrom: true,
        validTo: true,
        createdAt: true,
      },
    });
    return { deviceId: device.deviceId, key, versions };
  }

  /** 业务 deviceId → Device；不存在抛 404 */
  private async resolveDevice(bizDeviceId: string) {
    const device = await this.prisma.device.findUnique({
      where: { deviceId: bizDeviceId },
      select: { id: true, deviceId: true },
    });
    if (!device) {
      throw new NotFoundException("device not found");
    }
    return device;
  }
}
