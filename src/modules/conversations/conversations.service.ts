import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, query: { page?: number; pageSize?: number; deviceId?: string }) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const skip = (page - 1) * pageSize;

    // 查询当前用户绑定的所有设备
    const bindings = await this.prisma.userDeviceBinding.findMany({
      where: { userId },
      include: { device: true },
    });

    const deviceIds = bindings.map((b) => b.device.id);

    // 如果指定了 deviceId，则只查该设备（需属于当前用户）
    const targetDeviceIds = query.deviceId
      ? deviceIds.filter((id) => bindings.some((b) => b.device.deviceId === query.deviceId && b.device.id === id))
      : deviceIds;

    const [items, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where: { deviceId: { in: targetDeviceIds }, deletedAt: null },
        orderBy: { spokeAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.conversation.count({
        where: { deviceId: { in: targetDeviceIds }, deletedAt: null },
      }),
    ]);

    return {
      items,
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
