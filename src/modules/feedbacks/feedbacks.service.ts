import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import { CreateFeedbackDto } from "./dto/create-feedback.dto";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const MAX_CONTENT_LENGTH = 200;

interface MemoryRateLimitEntry {
  windowStartedAt: number;
  count: number;
}

@Injectable()
export class FeedbacksService {
  private readonly logger = new Logger(FeedbacksService.name);
  private readonly memoryRateLimits = new Map<string, MemoryRateLimitEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  async create(userId: string, ip: string, dto: CreateFeedbackDto) {
    const content = dto.content.trim();
    const contentLength = Array.from(content).length;
    if (contentLength === 0) {
      throw new BadRequestException("问题或建议不能为空");
    }
    if (contentLength > MAX_CONTENT_LENGTH) {
      throw new BadRequestException("问题或建议最多 200 字");
    }

    const contact = dto.contact?.trim() || null;
    if (contact && !/^1[3-9]\d{9}$/.test(contact)) {
      throw new BadRequestException("联系手机号格式不正确");
    }

    await this.enforceRateLimit(userId, ip);

    const feedback = await this.prisma.feedback.create({
      data: {
        id: `fb_${randomUUID()}`,
        userId,
        content,
        contact,
      },
    });

    if (contact) {
      await this.syncPhone(userId, contact);
    }

    return {
      feedbackId: feedback.id,
      createdAt: feedback.createdAt,
    };
  }

  /**
   * 把反馈里最新填写的手机号回写到账号档案。
   * 反馈是求助通道：写手机号失败只记日志，不让反馈提交失败。
   * users.phone 允许重复，dashboard 在家长档案里用「重复」tag 标出。
   */
  private async syncPhone(userId: string, phone: string): Promise<void> {
    try {
      await this.prisma.user.updateMany({
        where: { id: userId },
        data: { phone },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`反馈手机号回写失败 userId=${userId}: ${message}`);
    }
  }

  private async enforceRateLimit(userId: string, ip: string): Promise<void> {
    const redis = this.redisService.getClient();
    if (redis) {
      const window = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS);
      const key = `feedback:rate:${userId}:${ip}:${window}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, 70);
      this.throwIfRateLimited(count);
      return;
    }

    const now = Date.now();
    const key = `${userId}:${ip}`;
    const current = this.memoryRateLimits.get(key);
    const entry =
      current && now - current.windowStartedAt < RATE_LIMIT_WINDOW_MS
        ? current
        : { windowStartedAt: now, count: 0 };
    entry.count += 1;
    this.memoryRateLimits.set(key, entry);
    this.throwIfRateLimited(entry.count);
  }

  private throwIfRateLimited(count: number): void {
    if (count > RATE_LIMIT_MAX_ATTEMPTS) {
      throw new HttpException(
        "提交过于频繁，请稍后再试",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
