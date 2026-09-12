import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RedisService } from '@/common/redis/redis.service';

@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async handleConversation(payload: any, idempotencyKey?: string) {
    // TODO: 幂等校验、写入对话记录、异步计算学习统计
    return { received: true };
  }
}
