import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import {
  VOICE_RECONCILE_PORT,
  VoiceReconcilePort,
} from "@/modules/baidu-agent/baidu-agent.types";
import { isActiveSleepSession } from "@/modules/baidu-agent/sleep-session.util";
import { botCurrentKey } from "@/modules/client-api/client-api.constants";

const MAC_PATTERN = /^[0-9a-f]{12}$/;
const MGET_CHUNK_SIZE = 500;
const APPLY_CONCURRENCY = 5;

export interface VoiceSpeedBroadcastConfig {
  normalSpd: number;
  sleepSpd: number;
}

export interface VoiceSpeedBroadcastResultItem {
  deviceId: string;
  mac: string;
  applied: string;
  reason?: string;
}

export interface VoiceSpeedBroadcastResult {
  targeted: number;
  live: number;
  deferred: number;
  skipped: number;
  results: VoiceSpeedBroadcastResultItem[];
}

/**
 * 手动把当前全局语速扇出到「有活跃百度实例」的设备。
 *
 * 只影响当前实例；离线设备的下一轮由 getvalue / start 追平承接。
 * 手动下发强制跳过 voice:applied 缓存（人点了就是要覆盖当前实例）。
 */
@Injectable()
export class VoiceSpeedBroadcastService {
  private readonly logger = new Logger(VoiceSpeedBroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(VOICE_RECONCILE_PORT)
    private readonly reconcile: VoiceReconcilePort,
  ) {}

  async apply(
    config: VoiceSpeedBroadcastConfig,
    options: { macs?: string[] } = {},
  ): Promise<VoiceSpeedBroadcastResult> {
    const requestedMacs =
      options.macs && options.macs.length > 0
        ? this.normalizeMacs(options.macs)
        : null;

    const devices = await this.prisma.device.findMany({
      where: requestedMacs ? { deviceId: { in: requestedMacs } } : {},
      select: {
        id: true,
        deviceId: true,
        macAddress: true,
        characterKey: true,
      },
    });

    const candidates = devices
      .map((device) => ({
        ...device,
        mac:
          this.normalizeMac(device.macAddress) ??
          this.normalizeMac(device.deviceId),
      }))
      .filter(
        (device): device is typeof device & { mac: string } =>
          device.mac !== null,
      );

    const currentKeys = candidates.map((device) => botCurrentKey(device.mac));
    const currentValues = await this.mGetInChunks(currentKeys);
    const active = candidates.filter((_, index) => currentValues[index]);

    const sessions = await this.prisma.conversationSession.findMany({
      where: { deviceId: { in: active.map((device) => device.id) } },
      select: { deviceId: true, currentMode: true, expiresAt: true },
    });
    const sessionByDevice = new Map(
      sessions.map((session) => [session.deviceId, session]),
    );

    const results: VoiceSpeedBroadcastResultItem[] = [];
    let skipped = candidates.length - active.length;

    const targets: Array<{
      deviceId: string;
      mac: string;
      vcn: string;
      spd: number;
    }> = [];

    for (const device of active) {
      const vcn = await this.reconcile.getTimbreForCharacter(
        device.characterKey,
      );
      if (!vcn) {
        skipped += 1;
        continue;
      }
      const inSleep = isActiveSleepSession(
        sessionByDevice.get(device.id) ?? null,
      );
      targets.push({
        deviceId: device.deviceId,
        mac: device.mac,
        vcn,
        spd: inSleep ? config.sleepSpd : config.normalSpd,
      });
    }

    await this.runWithConcurrency(
      targets,
      APPLY_CONCURRENCY,
      async (target) => {
        try {
          const outcome = await this.reconcile.applySpd(
            target.mac,
            target.vcn,
            target.spd,
            { force: true },
          );
          results.push({
            deviceId: target.deviceId,
            mac: target.mac,
            applied: outcome.applied,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          });
        } catch (error) {
          results.push({
            deviceId: target.deviceId,
            mac: target.mac,
            applied: "deferred",
            reason: "internal_error",
          });
          this.logger.warn(
            `Voice speed broadcast failed, mac=${target.mac}, error=${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      },
    );

    const live = results.filter((item) => item.applied === "live").length;
    const deferred = results.length - live;
    const summary: VoiceSpeedBroadcastResult = {
      targeted: results.length,
      live,
      deferred,
      skipped,
      results,
    };

    this.logger.log(
      `Voice speed broadcast: targeted=${summary.targeted}, live=${summary.live}, deferred=${summary.deferred}, skipped=${summary.skipped}`,
    );
    return summary;
  }

  private normalizeMacs(macs: string[]): string[] {
    const normalized = macs.map((mac) => this.normalizeMac(mac));
    if (normalized.some((mac) => mac === null)) {
      throw new BadRequestException("invalid mac");
    }
    return [...new Set(normalized as string[])];
  }

  private normalizeMac(raw: string | null): string | null {
    if (!raw) return null;
    const normalized = raw.replace(/[:-]/g, "").toLowerCase();
    return MAC_PATTERN.test(normalized) ? normalized : null;
  }

  private async mGetInChunks(keys: string[]): Promise<(string | null)[]> {
    const values: (string | null)[] = [];
    for (let i = 0; i < keys.length; i += MGET_CHUNK_SIZE) {
      const chunk = keys.slice(i, i + MGET_CHUNK_SIZE);
      values.push(...(await this.redis.mGetValue(chunk)));
    }
    return values;
  }

  private async runWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    let index = 0;
    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (index < items.length) {
          const current = index;
          index += 1;
          await fn(items[current]);
        }
      },
    );
    await Promise.all(workers);
  }
}
