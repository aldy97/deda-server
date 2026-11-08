import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";

export interface MessagesQuery {
  startDate?: string;
  endDate?: string;
  deviceId?: string; // 业务设备 ID（Device.deviceId），内部 resolve 成 Device.id
  role?: "user" | "assistant";
  status?: "completed" | "failed";
  mode?: string;
  conversationModeKey?: string;
  turnId?: string;
  conversationId?: string;
  keyword?: string;
  sort?: "spokeAt_desc" | "spokeAt_asc";
  page?: number;
  pageSize?: number;
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

/** 列表字段：刻意不含 rawPayload（体积大）；详情接口返回整行 */
const LIST_SELECT = {
  id: true,
  turnId: true,
  conversationId: true,
  role: true,
  content: true,
  status: true,
  mode: true,
  conversationModeKey: true,
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
    if (query.conversationModeKey) {
      where.conversationModeKey = query.conversationModeKey;
    }
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
        conversationModeKey: row.conversationModeKey,
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
}
