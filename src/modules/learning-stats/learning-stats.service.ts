import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';

@Injectable()
export class LearningStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboard(deviceId: string) {
    // TODO: 汇总今日与累计学习指标
    return null;
  }

  async daily(query: any) {
    // TODO: 返回每日学习小结
    return null;
  }

  async unitProgress(deviceId: string) {
    // TODO: 锁定单元模式下返回单元进度
    return null;
  }
}
