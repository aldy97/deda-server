import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  reportDateInTimezone,
  shiftReportDate,
  DEFAULT_REPORT_TIMEZONE,
} from "@/modules/learning-stats/parent-report-date.util";

export const PRESENCE_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
export const NEGATIVE_CACHE_TTL_MS = 60 * 1000;

interface Bucket {
  deviceUuid: string;
  date: string;
  count: number;
  flushedCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * 设备在线上报落库服务：MQTT 心跳旁路，内存聚合后 5 分钟批量 flush。
 *
 * 前提：当前 staging/prod 各为单容器部署，内存聚合不会重复计数。
 * 扩到多实例后需改为 Redis INCR 或单实例部署本服务。
 */
@Injectable()
export class DevicePresenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DevicePresenceService.name);
  private readonly buckets = new Map<string, Bucket>();
  private readonly uuidCache = new Map<
    string,
    { uuid: string | null; cachedAt: number }
  >();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.flush();
    }, PRESENCE_FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.flush();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Best-effort flush on shutdown failed: ${message}`);
    }
  }

  /**
   * 记录一次设备上线心跳。
   * @param mac 设备 MAC（任意大小写/分隔符，内部会被归一为小写查库）
   * @param seenAt 本次心跳时间
   */
  async record(mac: string, seenAt: Date): Promise<void> {
    try {
      const uuid = await this.resolveUuid(mac);
      if (!uuid) return;

      const date = reportDateInTimezone(seenAt, DEFAULT_REPORT_TIMEZONE);
      const key = `${uuid}|${date}`;

      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = {
          deviceUuid: uuid,
          date,
          count: 0,
          flushedCount: 0,
          firstSeenAt: seenAt,
          lastSeenAt: seenAt,
        };
        this.buckets.set(key, bucket);
      }

      bucket.count += 1;
      if (seenAt < bucket.firstSeenAt) bucket.firstSeenAt = seenAt;
      if (seenAt > bucket.lastSeenAt) bucket.lastSeenAt = seenAt;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`record failed for MAC ${mac}: ${message}`);
    }
  }

  /**
   * 将所有内存聚合的 bucket 批量 flush 到 device_presence_daily 表。
   * 只 flush delta（count - flushedCount），失败时不推进 flushedCount 以留待重试。
   */
  async flush(): Promise<void> {
    const today = reportDateInTimezone(new Date(), DEFAULT_REPORT_TIMEZONE);
    const staleThreshold = shiftReportDate(today, -1);

    for (const [key, bucket] of this.buckets.entries()) {
      // 回收过期 bucket
      if (bucket.date < staleThreshold) {
        this.buckets.delete(key);
        continue;
      }

      const delta = bucket.count - bucket.flushedCount;
      if (delta <= 0) continue;

      try {
        await this.prisma.devicePresenceDaily.upsert({
          where: {
            deviceId_date: {
              deviceId: bucket.deviceUuid,
              date: bucket.date,
            },
          },
          create: {
            deviceId: bucket.deviceUuid,
            date: bucket.date,
            reportCount: delta,
            firstSeenAt: bucket.firstSeenAt,
            lastSeenAt: bucket.lastSeenAt,
          },
          update: {
            reportCount: { increment: delta },
            lastSeenAt: bucket.lastSeenAt,
          },
        });
        bucket.flushedCount = bucket.count;
      } catch (err: unknown) {
        const prismaErr = err as { code?: string };
        if (prismaErr.code === "P2002") {
          try {
            await this.prisma.devicePresenceDaily.update({
              where: {
                deviceId_date: {
                  deviceId: bucket.deviceUuid,
                  date: bucket.date,
                },
              },
              data: {
                reportCount: { increment: delta },
                lastSeenAt: bucket.lastSeenAt,
              },
            });
            bucket.flushedCount = bucket.count;
          } catch (retryErr: unknown) {
            const retryMessage =
              retryErr instanceof Error ? retryErr.message : String(retryErr);
            this.logger.error(`flush retry failed for ${key}: ${retryMessage}`);
          }
        } else {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`flush failed for ${key}: ${message}`);
        }
      }
    }
  }

  /**
   * 将 MAC 解析为 Device 内部 UUID（小写查库）。
   * 正查结果永久缓存；未建档结果只缓存 NEGATIVE_CACHE_TTL_MS。
   */
  private async resolveUuid(mac: string): Promise<string | null> {
    const lower = mac.toLowerCase();
    const cached = this.uuidCache.get(lower);
    if (cached) {
      if (
        cached.uuid !== null ||
        Date.now() - cached.cachedAt < NEGATIVE_CACHE_TTL_MS
      ) {
        return cached.uuid;
      }
    }

    const row = await this.prisma.device.findFirst({
      where: { OR: [{ deviceId: lower }, { macAddress: lower }] },
      select: { id: true },
    });

    this.uuidCache.set(lower, {
      uuid: row?.id ?? null,
      cachedAt: Date.now(),
    });

    return row?.id ?? null;
  }
}
