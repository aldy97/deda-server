import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { MODE_LABELS } from "@/common/mode-labels";

export interface MessagesQuery {
  startDate?: string;
  endDate?: string;
  deviceId?: string; // 业务设备 ID（Device.deviceId），内部 resolve 成 Device.id
  role?: "user" | "assistant";
  status?: "completed" | "failed" | "interrupted";
  mode?: string;
  turnId?: string;
  conversationId?: string;
  keyword?: string;
  sort?: "spokeAt_desc" | "spokeAt_asc";
  page?: number;
  pageSize?: number;
}

export interface MessagesModesQuery {
  startDate?: string;
  endDate?: string;
}

/** 日期边界固定 Asia/Shanghai，与服务器时区解耦 */
function shanghaiDayStart(date: string): Date {
  return new Date(`${date}T00:00:00+08:00`);
}

function shanghaiNextDayStart(date: string): Date {
  const start = shanghaiDayStart(date);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

const DEVICE_SELECT = {
  deviceId: true,
  deviceCode: true,
  characterKey: true,
} as const;

/** 所有可写入的对话模式 key，无论区间内是否有消息都恒返回 */
const ALL_WRITABLE_MODES = [
  "free_chat",
  "english_chat",
  "english_story",
  "idiom_story",
  "sleep_story",
  "adventure_story",
  "free_story",
] as const;

/** 校验可选日期区间（两者都给出时要求 start <= end） */
function validateOptionalRange(startDate?: string, endDate?: string) {
  if (startDate && endDate && startDate > endDate) {
    throw new BadRequestException("startDate 不能晚于 endDate");
  }
}

/** 可选日期区间 → spokeAt 过滤（无区间时不过滤） */
function spokeAtFilter(startDate?: string, endDate?: string) {
  if (!startDate && !endDate) return {};
  return {
    spokeAt: {
      ...(startDate ? { gte: shanghaiDayStart(startDate) } : {}),
      ...(endDate ? { lt: shanghaiNextDayStart(endDate) } : {}),
    },
  };
}

/** 列表字段：刻意不含 rawPayload（体积大）；详情接口返回整行 */
const LIST_SELECT = {
  id: true,
  turnId: true,
  conversationId: true,
  role: true,
  content: true,
  status: true,
  mode: true,
  cefrLevel: true,
  spokeAt: true,
  createdAt: true,
  device: { select: DEVICE_SELECT },
} satisfies Prisma.MessageSelect;

/**
 * 消息明细浏览（dashboard 内部用）。
 * 索引口径：带 deviceId 的 spokeAt 范围过滤走 @@index([deviceId, spokeAt])；
 * 全表扫描 + keyword 模糊匹配一期数据量可接受，不为本期加索引。
 */
@Injectable()
export class MessagesAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async listMessages(query: MessagesQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    if (query.startDate && query.endDate && query.startDate > query.endDate) {
      throw new BadRequestException("startDate 不能晚于 endDate");
    }

    const where: Prisma.MessageWhereInput = {};

    // deviceId 为业务设备 ID：resolve 成内部 UUID；查不到设备时直接空页
    if (query.deviceId) {
      const device = await this.prisma.device.findUnique({
        where: { deviceId: query.deviceId },
        select: { id: true },
      });
      if (!device) {
        return { total: 0, page, pageSize, items: [] };
      }
      where.deviceId = device.id;
    }

    if (query.startDate || query.endDate) {
      where.spokeAt = {
        ...(query.startDate ? { gte: shanghaiDayStart(query.startDate) } : {}),
        ...(query.endDate ? { lt: shanghaiNextDayStart(query.endDate) } : {}),
      };
    }
    if (query.role) where.role = query.role;
    if (query.status) where.status = query.status;
    if (query.mode) where.mode = query.mode;
    if (query.turnId) where.turnId = query.turnId;
    if (query.conversationId) where.conversationId = query.conversationId;
    if (query.keyword) {
      where.content = { contains: query.keyword, mode: "insensitive" };
    }

    const orderBy: Prisma.MessageOrderByWithRelationInput = {
      spokeAt: query.sort === "spokeAt_asc" ? "asc" : "desc",
    };

    const [total, rows] = await Promise.all([
      this.prisma.message.count({ where }),
      this.prisma.message.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: LIST_SELECT,
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      items: rows.map((row) => ({
        id: row.id,
        turnId: row.turnId,
        conversationId: row.conversationId,
        role: row.role,
        content: row.content,
        status: row.status,
        mode: row.mode,
        cefrLevel: row.cefrLevel,
        spokeAt: row.spokeAt,
        createdAt: row.createdAt,
        device: row.device,
      })),
    };
  }

  async getMessage(id: string) {
    const row = await this.prisma.message.findUnique({
      where: { id },
      include: { device: { select: DEVICE_SELECT } },
    });
    if (!row) {
      throw new NotFoundException("message not found");
    }
    return row;
  }

  /**
   * 对话模式选项源：7 个可写入模式恒返回（含展示名）+ 区间内各模式的消息数。
   * 供 dashboard 过滤下拉使用；消息数仅作参考，0 也返回。
   */
  async getModes(query: MessagesModesQuery) {
    validateOptionalRange(query.startDate, query.endDate);

    const groups = await this.prisma.message.groupBy({
      by: ["mode"],
      where: spokeAtFilter(query.startDate, query.endDate),
      _count: { _all: true },
    });

    const countMap = new Map<string, number>();
    for (const group of groups) {
      if (group.mode) {
        countMap.set(group.mode, group._count._all);
      }
    }

    // 可写入 mode 恒返回（0 条也在，保证筛选器恒可选）；
    // 区间内实际出现过的 legacy mode（历史数据，永不新写入）追加进来一起排序。
    const keys = new Set<string>(ALL_WRITABLE_MODES);
    for (const key of countMap.keys()) {
      keys.add(key);
    }

    return {
      modes: Array.from(keys)
        .map((key) => ({
          key,
          name: MODE_LABELS[key] ?? key,
          messageCount: countMap.get(key) ?? 0,
        }))
        .sort(
          (a, b) =>
            b.messageCount - a.messageCount || a.key.localeCompare(b.key),
        ),
    };
  }

  /**
   * 打断率：分母 = 区间内 assistant 消息总数，分子 = status=interrupted。
   * interrupted 由服务端推断写入（见 common/interruption，推断口径非设备真实事件）。
   */
  async getInterruptionRate(query: MessagesModesQuery) {
    validateOptionalRange(query.startDate, query.endDate);

    const base = {
      role: "assistant",
      ...spokeAtFilter(query.startDate, query.endDate),
    };
    const [assistantTotal, interrupted, groups] = await Promise.all([
      this.prisma.message.count({ where: base }),
      this.prisma.message.count({
        where: { ...base, status: "interrupted" },
      }),
      this.prisma.message.groupBy({
        by: ["mode", "status"],
        where: base,
        _count: { _all: true },
      }),
    ]);

    const byModeMap = new Map<
      string,
      { assistantTotal: number; interrupted: number }
    >();
    for (const group of groups) {
      const key = group.mode ?? "(unknown)";
      const entry = byModeMap.get(key) ?? { assistantTotal: 0, interrupted: 0 };
      entry.assistantTotal += group._count._all;
      if (group.status === "interrupted") {
        entry.interrupted += group._count._all;
      }
      byModeMap.set(key, entry);
    }

    return {
      assistantTotal,
      interrupted,
      interruptionRate:
        assistantTotal > 0
          ? Math.round((interrupted / assistantTotal) * 10000) / 10000
          : null,
      byMode: Array.from(byModeMap.entries()).map(([mode, entry]) => ({
        mode,
        assistantTotal: entry.assistantTotal,
        interrupted: entry.interrupted,
        interruptionRate:
          entry.assistantTotal > 0
            ? Math.round((entry.interrupted / entry.assistantTotal) * 10000) /
              10000
            : null,
      })),
    };
  }
}
