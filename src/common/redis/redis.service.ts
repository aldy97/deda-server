import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

/**
 * Redis 服务（可选依赖）
 *
 * MVP 阶段：可以不配置 REDIS_URL，此时所有缓存方法降级为内存 Map，服务仍可正常启动。
 * 生产/高并发阶段：配置 REDIS_URL 后自动切换为真实 Redis，支持多实例共享缓存、
 * 设备状态缓存、Webhook 幂等/限流、消息队列等。
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client?: Redis;
  private readonly memoryCache = new Map<
    string,
    { value: string; expiresAt: number }
  >();
  /** MVP 内存模式下的 sorted set 存储（key → member → score） */
  private readonly memorySortedSets = new Map<string, Map<string, number>>();

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.get<string>("redis.url");
    if (redisUrl) {
      this.client = new Redis(redisUrl);
      this.logger.log("Redis client connected");
    } else {
      this.logger.warn(
        "REDIS_URL is not configured. Running in MVP mode with in-memory cache. " +
          "For production, configure REDIS_URL to enable shared caching and rate limiting.",
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch (error) {
      this.logger.warn(
        `Redis graceful shutdown failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.client.disconnect();
    }
  }

  getClient(): Redis | undefined {
    return this.client;
  }

  async getValue(key: string): Promise<string | null> {
    if (this.client) {
      return this.client.get(key);
    }
    // MVP fallback: in-memory cache
    const item = this.memoryCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.memoryCache.delete(key);
      return null;
    }
    return item.value;
  }

  async setValue(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<void> {
    if (this.client) {
      if (ttlSeconds) {
        await this.client.setex(key, ttlSeconds, value);
      } else {
        await this.client.set(key, value);
      }
      return;
    }
    // MVP fallback: in-memory cache with TTL
    const expiresAt = ttlSeconds
      ? Date.now() + ttlSeconds * 1000
      : Number.MAX_SAFE_INTEGER;
    this.memoryCache.set(key, { value, expiresAt });
  }

  async deleteValue(key: string): Promise<void> {
    if (this.client) {
      await this.client.del(key);
      return;
    }
    this.memoryCache.delete(key);
  }

  /**
   * Sorted set 写入（ZADD）。MVP 内存模式与真实 Redis 行为一致：
   * 同 member 重复写入覆盖 score。
   */
  async zAdd(key: string, score: number, member: string): Promise<void> {
    if (this.client) {
      await this.client.zadd(key, score, member);
      return;
    }
    const set = this.memorySortedSets.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.memorySortedSets.set(key, set);
  }

  /**
   * 按 score 闭区间读取（ZRANGEBYSCORE ... WITHSCORES），按 score 升序返回。
   */
  async zRangeByScoreWithScores(
    key: string,
    minScore: number,
    maxScore: number,
  ): Promise<Array<{ member: string; score: number }>> {
    if (this.client) {
      const flat = await this.client.zrangebyscore(
        key,
        minScore,
        maxScore,
        "WITHSCORES",
      );
      const result: Array<{ member: string; score: number }> = [];
      for (let i = 0; i < flat.length; i += 2) {
        result.push({ member: flat[i], score: Number(flat[i + 1]) });
      }
      return result;
    }
    const set = this.memorySortedSets.get(key);
    if (!set) return [];
    return [...set.entries()]
      .filter(([, score]) => score >= minScore && score <= maxScore)
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score);
  }

  /** 按 score 闭区间删除（ZREMRANGEBYSCORE），用于窗口清理。 */
  async zRemRangeByScore(
    key: string,
    minScore: number,
    maxScore: number,
  ): Promise<void> {
    if (this.client) {
      await this.client.zremrangebyscore(key, minScore, maxScore);
      return;
    }
    const set = this.memorySortedSets.get(key);
    if (!set) return;
    for (const [member, score] of set.entries()) {
      if (score >= minScore && score <= maxScore) {
        set.delete(member);
      }
    }
  }
}
