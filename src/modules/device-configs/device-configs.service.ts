import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';

@Injectable()
export class DeviceConfigsService {
  constructor(private readonly prisma: PrismaService) {}

  async current(deviceId: string) {
    // TODO: 查询设备当前配置快照
    return null;
  }

  async apply(deviceId: string, dto: any) {
    // TODO: 校验教材单元合法性，调用厂商切换对话模式接口，保存配置快照
    return null;
  }
}
