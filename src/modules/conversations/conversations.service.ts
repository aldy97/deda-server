import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";

export interface ChatRecord {
  id: string;
  role: "user" | "device";
  content: string;
  createdAt: string;
}

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    userId: string,
    query: {
      page?: number | string;
      pageSize?: number | string;
      deviceId?: string;
      textbookId?: string;
      unitId?: string;
      conversationModeKey?: string;
    },
  ) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.max(1, Number(query.pageSize) || 20);
    const skip = (page - 1) * pageSize;

    // 查询当前用户绑定的所有设备
    const bindings = await this.prisma.userDeviceBinding.findMany({
      where: { userId },
      include: { device: true },
    });

    // 本地开发兜底：若用户没有任何绑定，则允许查看所有消息（便于联调）
    const isDevFallback =
      bindings.length === 0 && process.env.NODE_ENV === "development";

    if (isDevFallback) {
      const where = this.buildWhereClause(query, []);
      const [items, total] = await Promise.all([
        this.prisma.message.findMany({
          where,
          orderBy: { spokeAt: "desc" },
          skip,
          take: pageSize,
        }),
        this.prisma.message.count({ where }),
      ]);
      return {
        items: this.mapToChatRecords([...items].reverse()),
        total,
        page,
        pageSize,
      };
    }

    const deviceMap = new Map(
      bindings.map((b) => [b.device.deviceId, b.device.id]),
    );
    const internalDeviceIds = Array.from(
      new Set(bindings.map((b) => b.device.id)),
    );

    // 如果指定了 deviceId，则只查该设备（需属于当前用户）
    let targetInternalIds = internalDeviceIds;
    if (query.deviceId) {
      const targetId = deviceMap.get(query.deviceId);
      if (!targetId) {
        return { items: [], total: 0, page, pageSize };
      }
      targetInternalIds = [targetId];
    }

    if (targetInternalIds.length === 0) {
      return { items: [], total: 0, page, pageSize };
    }

    const where = this.buildWhereClause(query, targetInternalIds);

    const [items, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        orderBy: { spokeAt: "desc" },
        skip,
        take: pageSize,
      }),
      this.prisma.message.count({ where }),
    ]);

    // DB desc 锚定分页在最新一页；reverse 使页内按时间正序（顶老底新）
    return {
      items: this.mapToChatRecords([...items].reverse()),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 根据查询参数构建 where 条件
   * - 只使用前端显式传入的参数，不读取 deviceConfig
   */
  private buildWhereClause(
    query: {
      deviceId?: string;
      textbookId?: string;
      unitId?: string;
      conversationModeKey?: string;
    },
    targetInternalIds: string[],
  ): any {
    const where: any = {};

    if (targetInternalIds.length > 0) {
      where.deviceId = { in: targetInternalIds };
    }

    if (query.textbookId) where.textbookId = query.textbookId;
    if (query.unitId) where.unitId = query.unitId;
    if (query.conversationModeKey)
      where.conversationModeKey = query.conversationModeKey;

    return where;
  }

  /**
   * 消息行直映射为 ChatRecord（assistant 对前端呈现为 device）
   */
  private mapToChatRecords(items: any[]): ChatRecord[] {
    return items.map((item) => ({
      id: item.id,
      role: item.role === "user" ? ("user" as const) : ("device" as const),
      content: item.content,
      createdAt: item.spokeAt.toISOString(),
    }));
  }
}
