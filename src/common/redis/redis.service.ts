import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis 服务（可选依赖）
 *
 * MVP 阶段：可以不配置 REDIS_URL，此时所有缓存方法降级为内存 Map，服务仍可正常启动。
 * 生产/高并发阶段：配置 REDIS_URL 后自动切换为真实 Redis，支持多实例共享缓存、
 * 设备状态缓存、Webhook 幂等/限流、消息队列等。
 */
@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);
  private readonly client?: Redis;
  private readonly memoryCache = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly configService: ConfigService) {
    const redisUrl = this.configService.get<string>('redis.url');
    if (redisUrl) {
      this.client = new Redis(redisUrl);
      this.logger.log('Redis client connected');
    } else {
      this.logger.warn(
        'REDIS_URL is not configured. Running in MVP mode with in-memory cache. ' +
          'For production, configure REDIS_URL to enable shared caching and rate limiting.',
      );
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

  async setValue(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.client) {
      if (ttlSeconds) {
        await this.client.setex(key, ttlSeconds, value);
      } else {
        await this.client.set(key, value);
      }
      return;
    }
    // MVP fallback: in-memory cache with TTL
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : Number.MAX_SAFE_INTEGER;
    this.memoryCache.set(key, { value, expiresAt });
  }

  async deleteValue(key: string): Promise<void> {
    if (this.client) {
      await this.client.del(key);
      return;
    }
    this.memoryCache.delete(key);
  }
}
