import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  reportDateInTimezone,
  shiftReportDate,
} from "@/modules/learning-stats/parent-report-date.util";

export const DEVICE_NETWORK_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

interface Bucket {
  deviceId: string;
  date: string;
  wifi: number;
  fourG: number;
  unknown: number;
  flushedWifi: number;
  flushedFourG: number;
  flushedUnknown: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * 设备网络心跳日聚合：MQTT query 心跳旁路，内存聚合后 5 分钟批量 flush。
 *
 * 前提：staging/prod 当前为单容器部署，内存聚合不会重复计数；扩到多实例后
 * 需改为 Redis INCR 或单实例部署本服务（与 DevicePresenceService 同款约束）。
 */
@Injectable()
export class DeviceNetworkAggregationService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DeviceNetworkAggregationService.name);
  private readonly buckets = new Map<string, Bucket>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, DEVICE_NETWORK_FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await this.flush();
    } catch (error) {
      this.logger.error("Best-effort flush on shutdown failed", error as Error);
    }
  }

  /**
   * 记录一次心跳的网络模式。
   * @param mac 设备 MAC（大小写/分隔符不限，内部归一为小写）
   * @param networkMode wifi / 4g / null（切网中）；undefined 表示老固件未上报，直接跳过
   */
  record(
    mac: string,
    networkMode: "wifi" | "4g" | null | undefined,
    at: Date,
  ): void {
    if (networkMode === undefined) return;
    const deviceId = mac.trim().toLowerCase();
    if (!deviceId) return;

    try {
      const date = reportDateInTimezone(at, DEFAULT_REPORT_TIMEZONE);
      const key = `${deviceId}|${date}`;
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = {
          deviceId,
          date,
          wifi: 0,
          fourG: 0,
          unknown: 0,
          flushedWifi: 0,
          flushedFourG: 0,
          flushedUnknown: 0,
          firstSeenAt: at,
          lastSeenAt: at,
        };
        this.buckets.set(key, bucket);
      }
      if (networkMode === "wifi") bucket.wifi += 1;
      else if (networkMode === "4g") bucket.fourG += 1;
      else bucket.unknown += 1;
      if (at < bucket.firstSeenAt) bucket.firstSeenAt = at;
      if (at > bucket.lastSeenAt) bucket.lastSeenAt = at;
    } catch (error) {
      this.logger.error(`record failed for MAC ${mac}`, error as Error);
    }
  }

  async flush(): Promise<void> {
    const today = reportDateInTimezone(new Date(), DEFAULT_REPORT_TIMEZONE);
    const staleThreshold = shiftReportDate(today, -1);

    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.date < staleThreshold) {
        this.buckets.delete(key);
        continue;
      }

      const deltaWifi = bucket.wifi - bucket.flushedWifi;
      const deltaFourG = bucket.fourG - bucket.flushedFourG;
      const deltaUnknown = bucket.unknown - bucket.flushedUnknown;
      if (deltaWifi <= 0 && deltaFourG <= 0 && deltaUnknown <= 0) continue;

      const update: Prisma.DeviceNetworkDailyUpdateInput = {
        lastSeenAt: bucket.lastSeenAt,
      };
      if (deltaWifi > 0) update.wifiHeartbeats = { increment: deltaWifi };
      if (deltaFourG > 0) update.fourGHeartbeats = { increment: deltaFourG };
      if (deltaUnknown > 0) {
        update.unknownHeartbeats = { increment: deltaUnknown };
      }

      try {
        await this.prisma.deviceNetworkDaily.upsert({
          where: {
            date_deviceId: { date: bucket.date, deviceId: bucket.deviceId },
          },
          create: {
            date: bucket.date,
            deviceId: bucket.deviceId,
            wifiHeartbeats: bucket.wifi,
            fourGHeartbeats: bucket.fourG,
            unknownHeartbeats: bucket.unknown,
            firstSeenAt: bucket.firstSeenAt,
            lastSeenAt: bucket.lastSeenAt,
          },
          update,
        });
        this.markFlushed(bucket);
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") {
          try {
            await this.prisma.deviceNetworkDaily.update({
              where: {
                date_deviceId: { date: bucket.date, deviceId: bucket.deviceId },
              },
              data: update,
            });
            this.markFlushed(bucket);
          } catch (retryError) {
            this.logger.error(
              `flush retry failed for ${key}`,
              retryError as Error,
            );
          }
        } else {
          this.logger.error(`flush failed for ${key}`, error as Error);
        }
      }
    }
  }

  private markFlushed(bucket: Bucket): void {
    bucket.flushedWifi = bucket.wifi;
    bucket.flushedFourG = bucket.fourG;
    bucket.flushedUnknown = bucket.unknown;
  }
}
