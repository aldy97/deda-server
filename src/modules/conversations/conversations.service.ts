import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";

export interface ChatRecord {
  id: string;
  role: "user" | "device";
  content: string;
  createdAt: string;
}

interface ActiveConfig {
  deviceId: string;
  mode: string;
  textbookId: string | null;
  unitId: string | null;
  conversationModeKey: string | null;
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

    // 本地开发兜底：若用户没有任何绑定，则允许查看所有对话（便于联调）
    const isDevFallback =
      bindings.length === 0 && process.env.NODE_ENV === "development";

    if (isDevFallback) {
      const where = { deletedAt: null };
      const [items, total] = await Promise.all([
        this.prisma.conversation.findMany({
          where,
          orderBy: { spokeAt: "asc" },
          skip,
          take: pageSize,
        }),
        this.prisma.conversation.count({ where }),
      ]);
      return {
        items: this.mapToChatRecords(items),
        total,
        page,
        pageSize,
      };
    }

    const deviceMap = new Map(
      bindings.map((b) => [b.device.deviceId, b.device.id]),
    );
    const internalDeviceIds = Array.from(new Set(bindings.map((b) => b.device.id)));

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

    // 查询这些设备的当前生效配置
    const activeConfigs = await this.getActiveConfigs(targetInternalIds);

    // 构建按设备 + 当前模式/单元过滤的条件
    const orFilters = this.buildConversationFilters(activeConfigs);

    const where: any = {
      deletedAt: null,
      deviceId: { in: targetInternalIds },
    };

    if (orFilters.length > 0) {
      where.OR = orFilters;
    }

    const [items, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        orderBy: { spokeAt: "asc" },
        skip,
        take: pageSize,
      }),
      this.prisma.conversation.count({ where }),
    ]);

    return {
      items: this.mapToChatRecords(items),
      total,
      page,
      pageSize,
    };
  }

  async remove(userId: string, id: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
    });

    if (!conversation || conversation.deletedAt) {
      return null;
    }

    const ownership = await this.validateConversationOwnership(
      userId,
      conversation.deviceId,
    );
    if (!ownership.allowed) {
      return null;
    }

    const activeConfig = await this.getActiveConfig(conversation.deviceId);
    if (!this.matchesActiveConfig(conversation, activeConfig)) {
      return null;
    }

    await this.prisma.conversation.updateMany({
      where: {
        id,
        deviceId: conversation.deviceId,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });

    return { success: true };
  }

  async clearByDate(userId: string, deviceId: string, date: string) {
    const binding = await this.prisma.userDeviceBinding.findFirst({
      where: { userId, device: { deviceId } },
      include: { device: true },
    });

    if (!binding) {
      return null;
    }

    const activeConfig = await this.getActiveConfig(binding.device.id);
    const where: any = {
      deviceId: binding.device.id,
      deletedAt: null,
      spokeAt: {
        gte: new Date(`${date}T00:00:00.000Z`),
        lt: new Date(`${date}T23:59:59.999Z`),
      },
    };

    if (activeConfig) {
      where.mode = activeConfig.mode;
      if (activeConfig.textbookId) {
        where.textbookId = activeConfig.textbookId;
      }
      if (activeConfig.unitId) {
        where.unitId = activeConfig.unitId;
      }
    }

    const result = await this.prisma.conversation.updateMany({
      where,
      data: { deletedAt: new Date() },
    });

    return { success: true, cleared: result.count };
  }

  /**
   * 查询多个设备的当前生效配置
   */
  private async getActiveConfigs(
    deviceInternalIds: string[],
  ): Promise<ActiveConfig[]> {
    if (deviceInternalIds.length === 0) {
      return [];
    }

    return this.prisma.deviceConfig.findMany({
      where: {
        deviceId: { in: deviceInternalIds },
        isActive: true,
      },
    }) as Promise<ActiveConfig[]>;
  }

  /**
   * 查询单个设备的当前生效配置
   */
  private async getActiveConfig(
    deviceInternalId: string,
  ): Promise<ActiveConfig | null> {
    const configs = await this.getActiveConfigs([deviceInternalId]);
    return configs[0] ?? null;
  }

  /**
   * 根据 active configs 构建 conversation 过滤条件
   * 每个设备只返回与其当前 mode/textbook/unit 匹配的对话
   */
  private buildConversationFilters(
    activeConfigs: ActiveConfig[],
  ): Array<Record<string, any>> {
    return activeConfigs.map((config) => {
      const filter: Record<string, any> = {
        deviceId: config.deviceId,
        mode: config.mode,
      };

      if (config.mode !== "free_chat") {
        if (config.textbookId) {
          filter.textbookId = config.textbookId;
        }
        if (config.unitId) {
          filter.unitId = config.unitId;
        }
      }

      return filter;
    });
  }

  /**
   * 校验用户是否拥有指定设备
   */
  private async validateConversationOwnership(
    userId: string,
    deviceInternalId: string,
  ): Promise<{ allowed: boolean }> {
    const binding = await this.prisma.userDeviceBinding.findFirst({
      where: { userId, deviceId: deviceInternalId },
    });
    return { allowed: !!binding };
  }

  /**
   * 判断对话是否匹配设备当前生效配置
   */
  private matchesActiveConfig(
    conversation: any,
    activeConfig: ActiveConfig | null,
  ): boolean {
    if (!activeConfig) {
      return false;
    }

    if (conversation.deviceId !== activeConfig.deviceId) {
      return false;
    }

    if (conversation.mode !== activeConfig.mode) {
      return false;
    }

    if (activeConfig.mode === "free_chat") {
      return true;
    }

    if (
      activeConfig.textbookId &&
      conversation.textbookId !== activeConfig.textbookId
    ) {
      return false;
    }

    if (activeConfig.unitId && conversation.unitId !== activeConfig.unitId) {
      return false;
    }

    return true;
  }

  /**
   * 把 conversation 列表拆成 user + device 两条 ChatRecord
   */
  private mapToChatRecords(items: any[]): ChatRecord[] {
    const records: ChatRecord[] = [];
    for (const item of items) {
      if (item.asrText) {
        records.push({
          id: `${item.id}-u`,
          role: "user",
          content: item.asrText,
          createdAt: item.spokeAt.toISOString(),
        });
      }
      if (item.aiReply) {
        records.push({
          id: `${item.id}-d`,
          role: "device",
          content: item.aiReply,
          createdAt: new Date(item.spokeAt.getTime() + 1000).toISOString(),
        });
      }
    }
    return records;
  }
}
