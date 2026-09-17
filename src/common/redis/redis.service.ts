import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService extends Redis {
  constructor(private readonly configService: ConfigService) {
    super(configService.get<string>('redis.url'));
  }

  getClient(): Redis {
    return this;
  }

  async getValue(key: string): Promise<string | null> {
    return this.get(key);
  }

  async setValue(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.setex(key, ttlSeconds, value);
    } else {
      await this.set(key, value);
    }
  }

  async deleteValue(key: string): Promise<void> {
    await this.del(key);
  }
}
