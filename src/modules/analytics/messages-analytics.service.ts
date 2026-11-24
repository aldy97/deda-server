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

/** 消息详情里的冒险故事：集身份 + 该轮播放时锁定的版本（无记录时 version 为空） */
export interface MessageAdventureEpisode {
  episodeId: string;
  /** {characterKey}/{season}/{episodeNumber}，与冒险内容工作台同一口径 */
  businessKey: string;
  characterKey: string;
  season: number;
  episodeNumber: number;
  /** 有版本时取版本快照里的标题（当时的标题），否则回落集当前标题 */
  title: string;
  versionId: string | null;
  version: number | null;
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
    return {
      ...row,
      adventureEpisode: await this.resolveAdventureEpisode(row),
    };
  }

  /**
   * 消息对应的冒险故事：按 deviceId + turnId 找该轮事件，再取集身份与播放时锁定的版本。
   * 只有 adventure_story 轮次才查事件表；无事件（冒险上线前 / 写库失败）返回 null，
   * 刻意不按发布时间推断版本——重发时设备可能仍锁在旧版，推断会给出看似合理却错误的一版。
   */
  private async resolveAdventureEpisode(row: {
    deviceId: string;
    turnId: string;
    mode: string | null;
  }): Promise<MessageAdventureEpisode | null> {
    if (row.mode !== "adventure_story") {
      return null;
    }
    const events = await this.prisma.adventureEvent.findMany({
      where: { deviceId: row.deviceId, turnId: row.turnId },
      orderBy: { createdAt: "asc" },
      take: 5,
      select: {
        episodeVersionId: true,
        episode: {
          select: {
            id: true,
            characterKey: true,
            season: true,
            episodeNumber: true,
            title: true,
          },
        },
      },
    });
    const episode = events[0]?.episode;
    if (!episode) {
      return null;
    }
    // 早期事件只有二选一命中带版本；取第一条带版本的即可，同一轮的事件同属一集。
    const versionId =
      events.find((event) => event.episodeVersionId !== null)
        ?.episodeVersionId ?? null;
    // 版本快照可能很大，单独取一次，避免同一轮多条事件各带一份 payload。
    const version = versionId
      ? await this.prisma.adventureEpisodeVersion.findUnique({
          where: { id: versionId },
          select: { version: true, payload: true },
        })
      : null;
    const versionTitle = (version?.payload as { title?: unknown } | null)
      ?.title;
    return {
      episodeId: episode.id,
      businessKey: `${episode.characterKey}/${episode.season}/${episode.episodeNumber}`,
      characterKey: episode.characterKey,
      season: episode.season,
      episodeNumber: episode.episodeNumber,
      // 有版本时用播放当时的标题；标题可能已被新版本改掉。
      title:
        typeof versionTitle === "string" && versionTitle
          ? versionTitle
          : episode.title,
      versionId,
      version: version?.version ?? null,
    };
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
