import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: any) {
    // TODO: 查询绑定关系并拉取厂商状态
    return [];
  }

  async detail(id: string) {
    // TODO: 查询设备详情
    return null;
  }

  async status(id: string) {
    // TODO: 调用厂商接口查询设备状态并缓存
    return null;
  }

  async control(id: string, dto: any) {
    // TODO: 转发控制指令到厂商服务器
    return null;
  }

  async unbind(id: string) {
    // TODO: 删除绑定关系
    return null;
  }
}
