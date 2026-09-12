import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: any) {
    // TODO: 分页查询对话记录，每页 20 条
    return [];
  }

  async remove(id: string) {
    // TODO: 删除单条记录
    return null;
  }

  async clearByDate(deviceId: string, date: string) {
    // TODO: 按日期清空记录
    return null;
  }
}
