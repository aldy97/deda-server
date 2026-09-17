import { registerAs } from '@nestjs/config';

/**
 * Redis 配置
 *
 * MVP 阶段：REDIS_URL 可不配置，服务使用内存缓存降级运行。
 * 生产/高并发阶段：配置 REDIS_URL 启用真实 Redis。
 */
export default registerAs('redis', () => ({
  url: process.env.REDIS_URL || '',
}));
