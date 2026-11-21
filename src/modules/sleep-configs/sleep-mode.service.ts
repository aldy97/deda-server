import { Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import { DeviceLinkService } from "@/modules/device-link/device-link.service";
import {
  VOICE_RECONCILE_PORT,
  VoiceReconcilePort,
} from "@/modules/baidu-agent/baidu-agent.types";

/**
 * 哄睡模式音量上限（最大音量的 50%）。语速已改由 DB 全局配置（voice_speed_config）。
 */
export const SLEEP_MODE_VOLUME_CAP = 50;

/** 哄睡音量快照 TTL（秒）：与 sleep_story 会话 TTL（45 分钟）一致 */
export const SLEEP_SNAPSHOT_TTL_SECONDS = 45 * 60;

/** 哄睡音量快照 Redis key 前缀：`sleep:volume-snapshot:{mac}` */
export const SLEEP_VOLUME_SNAPSHOT_KEY_PREFIX = "sleep:volume-snapshot:";

/** 「测试哄睡模式」语音触发词（仅 staging） */
export const SLEEP_TEST_MODE_TRIGGER = "测试哄睡模式";

/** 测试哄睡模式的环境开关（仅 staging compose 硬写 true，prod 刻意不转发） */
export const SLEEP_TEST_MODE_ENV = {
  enabled: "SLEEP_TEST_MODE_ENABLED",
} as const;

function sleepVolumeSnapshotKey(mac: string): string {
  return `${SLEEP_VOLUME_SNAPSHOT_KEY_PREFIX}${mac}`;
}

/**
 * 哄睡模式的音速/音量编排服务。
 *
 * 职责（进入 / 退出成对）：
 * - 进入：快照当前音量 → 音量压到 `min(当前, 50)`（MQTT volume 通道）→
 *   语速切到哄睡语速（DB voice_speed_config.sleepSpd；有活跃实例实时 switchSceneRole，无实例靠 getvalue）。
 * - 退出：恢复快照音量 → 语速切回非哄睡语速（DB voice_speed_config.normalSpd）→ 删快照。
 *
 * 两条链路（百度 RTC 主链路 / vendor 备选链路）与定时进入共用本服务，
 * 保证「进入哄睡降速降音量、退出恢复」的口径一致。
 *
 * 入参统一为设备内部 UUID：调用方（定时 / 语音 / 意图路由）都已在进入点拿到
 * Device.id，本服务内部再查一次 Device 取 MAC / IP，避免每个调用方各自拼投影。
 * 两个方法都**永不抛错**——音量/语速的编排失败不能中断哄睡下发或意图路由。
 */
@Injectable()
export class SleepModeService {
  private readonly logger = new Logger(SleepModeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deviceLink: DeviceLinkService,
    private readonly redis: RedisService,
    @Inject(VOICE_RECONCILE_PORT)
    private readonly voiceReconcile: VoiceReconcilePort,
  ) {}

  /** 进入哄睡：快照 + 降音量 + 降语速。永不抛错。 */
  async enter(deviceId: string): Promise<void> {
    try {
      const device = await this.findDevice(deviceId);
      if (!device) return;
      const mac = device.macAddress ?? device.deviceId;

      const status = await this.deviceLink.getStatus(mac);
      await this.redis.setValue(
        sleepVolumeSnapshotKey(mac),
        JSON.stringify({ volume: status.volume ?? null }),
        SLEEP_SNAPSHOT_TTL_SECONDS,
      );

      const target = Math.min(
        status.volume ?? SLEEP_MODE_VOLUME_CAP,
        SLEEP_MODE_VOLUME_CAP,
      );
      this.deviceLink.setVolume(mac, target);

      const vcn = await this.voiceReconcile.getTimbreForCharacter(
        device.characterKey,
      );
      if (vcn) {
        const sleepSpd = await this.voiceReconcile.resolveSleepSpd();
        await this.voiceReconcile.applySpd(mac, vcn, sleepSpd);
      }
    } catch (error) {
      this.logger.warn(
        `Sleep mode enter failed for ${deviceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** 退出哄睡：恢复音量快照 + 语速切回档位 + 删快照。永不抛错。 */
  async exit(deviceId: string): Promise<void> {
    try {
      const device = await this.findDevice(deviceId);
      if (!device) return;
      const mac = device.macAddress ?? device.deviceId;

      const snapshotRaw = await this.redis.getValue(
        sleepVolumeSnapshotKey(mac),
      );
      if (snapshotRaw) {
        try {
          const parsed = JSON.parse(snapshotRaw) as { volume?: number | null };
          if (typeof parsed.volume === "number") {
            this.deviceLink.setVolume(mac, parsed.volume);
          }
        } catch {
          // 快照损坏时忽略，不影响语速恢复与快照清理
        }
      }

      const vcn = await this.voiceReconcile.getTimbreForCharacter(
        device.characterKey,
      );
      if (vcn) {
        const spd = await this.voiceReconcile.resolveNormalSpd();
        await this.voiceReconcile.applySpd(mac, vcn, spd);
      }

      await this.redis.deleteValue(sleepVolumeSnapshotKey(mac));
    } catch (error) {
      this.logger.warn(
        `Sleep mode exit failed for ${deviceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async findDevice(deviceId: string) {
    return this.prisma.device.findUnique({
      where: { id: deviceId },
      select: {
        id: true,
        macAddress: true,
        deviceId: true,
        characterKey: true,
      },
    });
  }
}
