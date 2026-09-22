import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';

export interface ChatRecord {
  id: string;
  role: 'user' | 'device';
  content: string;
  createdAt: string;
}

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    userId: string,
    query: { page?: number | string; pageSize?: number | string; deviceId?: string },
  ) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.max(1, Number(query.pageSize) || 20);
    const skip = (page - 1) * pageSize;

    // 查询当前用户绑定的所有设备
    const bindings = await this.prisma.userDeviceBinding.findMany({
      where: { userId },
      include: { device: true },
    });

    const deviceIds = bindings.map((b) => b.device.id);

    // 本地开发兜底：若用户没有任何绑定，则允许查看所有对话（便于联调）
    let effectiveDeviceIds:
      | string[]
      | undefined =
      deviceIds.length === 0 && process.env.NODE_ENV === 'development'
        ? undefined
        : deviceIds;

    // WORKAROUND START: 本地开发联调专用
    // 原因：小程序设备列表刷新问题尚未完全解决，为验证“绑定 → 查看对话”链路，
    //      允许绑定 DEV001 的用户查看所有对话记录。
    // 注意：此逻辑仅在 NODE_ENV=development 时生效，生产环境必须移除或关闭。
    const hasDevDevice = bindings.some(
      (b) =>
        b.device.deviceCode === 'DEV001' ||
        b.device.deviceId === 'dev-local-001',
    );
    if (process.env.NODE_ENV === 'development' && hasDevDevice) {
      effectiveDeviceIds = undefined;
    }
    // WORKAROUND END

    // 如果指定了 deviceId，则只查该设备（需属于当前用户）
    const targetDeviceIds = query.deviceId
      ? deviceIds.filter((id) =>
          bindings.some(
            (b) => b.device.deviceId === query.deviceId && b.device.id === id,
          ),
        )
      : effectiveDeviceIds;

    const where = {
      deletedAt: null,
      ...(targetDeviceIds ? { deviceId: { in: targetDeviceIds } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        orderBy: { spokeAt: 'asc' },
        skip,
        take: pageSize,
      }),
      this.prisma.conversation.count({ where }),
    ]);

    // 把每条对话拆成 user + device 两条消息，符合小程序 ChatRecord 结构
    const records: ChatRecord[] = [];
    for (const item of items) {
      if (item.asrText) {
        records.push({
          id: `${item.id}-u`,
          role: 'user',
          content: item.asrText,
          createdAt: item.spokeAt.toISOString(),
        });
      }
      if (item.aiReply) {
        records.push({
          id: `${item.id}-d`,
          role: 'device',
          content: item.aiReply,
          createdAt: new Date(
            item.spokeAt.getTime() + 1000,
          ).toISOString(),
        });
      }
    }

    return {
      items: records,
      total,
      page,
      pageSize,
    };
  }

  async remove(userId: string, id: string) {
    // TODO: 校验该对话是否属于当前用户绑定的设备，然后软删除
    return null;
  }

  async clearByDate(userId: string, deviceId: string, date: string) {
    // TODO: 校验设备归属后按日期清空记录
    return null;
  }
}
