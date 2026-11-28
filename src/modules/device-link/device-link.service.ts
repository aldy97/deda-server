import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import { MqttService } from "@/common/mqtt/mqtt.service";
import { RedisService } from "@/common/redis/redis.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { ClientApiService } from "@/modules/client-api/client-api.service";
import { DevicePresenceService } from "./device-presence.service";
import { DeviceNetworkAggregationService } from "./device-network-aggregation.service";
import {
  LOGIN_MAC_TOPIC,
  DEVICE_UP_TOPIC_PATTERN,
  ONLINE_WINDOW_MS,
  STATUS_TTL_SECONDS,
  DeviceLinkCommand,
  DeviceLinkMessage,
  DeviceLinkStatus,
  DeviceQueryData,
  DeviceVolumeData,
  LoginMacPayload,
  NetworkMode,
  deviceDownTopic,
} from "./device-link.types";

/** device/up/{mac} 中的 mac 提取规则（12 位十六进制，允许冒号/连字符分隔） */
const UP_TOPIC_REGEX =
  /^device\/up\/([0-9A-Fa-f]{2}(?:[:-]?[0-9A-Fa-f]{2}){5})$/;

/**
 * 设备链路服务（机芯厂新 MQTT 协议）
 *
 * 负责 docs/vendor-mqtt-protocol.md 定义的三主题交互：
 * - 订阅 loginMac：设备连接后上报 MAC，服务端 upsert Device 建档（入库）
 * - 订阅 device/up/+：query 心跳/状态上报，缓存电量、音量、版本并刷新 lastSeenAt
 * - 发布 device/down/{mac}：query / volume / restart / upgrade / recover 指令
 *
 * 在线判定：读取时按 lastSeenAt 是否落在 15 秒窗口内惰性计算，
 * 与协议第 8.2 节「15 秒未上报即离线」规则等价。
 */
@Injectable()
export class DeviceLinkService implements OnModuleInit {
  private readonly logger = new Logger(DeviceLinkService.name);

  constructor(
    private readonly mqttService: MqttService,
    private readonly redisService: RedisService,
    private readonly prisma: PrismaService,
    private readonly presence: DevicePresenceService,
    private readonly networkAggregation: DeviceNetworkAggregationService,
    private readonly clientApi: ClientApiService,
  ) {}

  onModuleInit(): void {
    this.mqttService.subscribe(LOGIN_MAC_TOPIC);
    this.mqttService.subscribe(DEVICE_UP_TOPIC_PATTERN);
    this.mqttService.onMessage((topic: string, payload: Buffer) => {
      this.handleMessage(topic, payload);
    });
  }

  /**
   * MQTT 消息入口：按 topic 分发到绑定上报 / 设备上行处理
   */
  handleMessage(topic: string, payload: Buffer): void {
    if (topic === LOGIN_MAC_TOPIC) {
      this.handleLoginMac(payload);
      return;
    }

    const mac = this.extractMacFromUpTopic(topic);
    if (mac) {
      this.handleDeviceUp(mac, payload);
    }
  }

  /**
   * 读取设备链路状态并计算在线状态
   * @param mac 设备 MAC（任意大小写/分隔符，内部归一化）
   */
  async getStatus(
    mac: string,
  ): Promise<DeviceLinkStatus & { online: boolean }> {
    const normalized = this.normalizeMac(mac);
    const empty: DeviceLinkStatus = {
      mac: normalized,
      battery: null,
      volume: null,
      version: null,
      charging: null,
      networkMode: null,
      wifiRssi: null,
      lastSeenAt: null,
    };

    const cached = await this.redisService.getValue(this.statusKey(normalized));
    const status: DeviceLinkStatus = cached
      ? { ...empty, ...(JSON.parse(cached) as Partial<DeviceLinkStatus>) }
      : empty;

    return {
      ...status,
      online: this.isOnline(status.lastSeenAt),
    };
  }

  /**
   * 批量读取设备链路状态。
   * @param macs 设备 MAC 列表（任意大小写/分隔符，内部归一化去重）
   * @returns 以归一化大写 MAC 为 key 的 Map，空数组直接返回空 Map 不碰 Redis
   */
  async getStatusBatch(
    macs: string[],
  ): Promise<Map<string, DeviceLinkStatus & { online: boolean }>> {
    if (macs.length === 0) return new Map();

    const normalizedSet = new Set<string>();
    const ordered: string[] = [];
    for (const mac of macs) {
      const n = this.normalizeMac(mac);
      if (!normalizedSet.has(n)) {
        normalizedSet.add(n);
        ordered.push(n);
      }
    }

    const keys = ordered.map((n) => this.statusKey(n));
    const values = await this.redisService.mGetValue(keys);

    const result = new Map<string, DeviceLinkStatus & { online: boolean }>();
    for (let i = 0; i < ordered.length; i++) {
      const mac = ordered[i];
      const empty: DeviceLinkStatus = {
        mac,
        battery: null,
        volume: null,
        version: null,
        charging: null,
        networkMode: null,
        wifiRssi: null,
        lastSeenAt: null,
      };
      const raw = values[i];
      const status: DeviceLinkStatus = raw
        ? { ...empty, ...(JSON.parse(raw) as Partial<DeviceLinkStatus>) }
        : empty;
      result.set(mac, {
        ...status,
        online: this.isOnline(status.lastSeenAt),
      });
    }

    return result;
  }

  /** 下发查询指令：要求设备立即上报一次电量/音量/版本 */
  requestStatus(mac: string): void {
    this.publishCommand(mac, DeviceLinkCommand.Query, null);
  }

  /** 下发音量设置（0-100） */
  setVolume(mac: string, volume: number): void {
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
      throw new BadRequestException(
        `volume must be an integer between 0 and 100, got ${volume}`,
      );
    }
    this.publishCommand(mac, DeviceLinkCommand.Volume, { volume });
  }

  /** 下发重启指令 */
  restartDevice(mac: string): void {
    this.publishCommand(mac, DeviceLinkCommand.Restart, null);
  }

  /** 下发固件升级指令 */
  triggerUpgrade(mac: string): void {
    this.publishCommand(mac, DeviceLinkCommand.Upgrade, null);
  }

  /**
   * 下发恢复出厂设置指令。
   * 与机芯厂约定（2026-11-09 罗浩确认）：App 解绑即下发本指令，
   * 设备清除本地数据并重启，重新配网后重新上报 loginMac 入库。
   */
  factoryReset(mac: string): void {
    this.publishCommand(mac, DeviceLinkCommand.Recover, null);
  }

  /**
   * loginMac 入库：按 MAC upsert Device 记录
   */
  private handleLoginMac(payload: Buffer): void {
    const message = this.parseJson<LoginMacPayload>(payload);
    if (!message?.device) {
      this.logger.warn("loginMac message missing device field");
      return;
    }

    const mac = this.normalizeMac(message.device);
    // Prisma 侧 deviceId / macAddress 一律小写（docs/integration.md）；mac 的大写口径只用于 Redis key
    const deviceId = mac.toLowerCase();
    this.prisma.device
      .upsert({
        where: { deviceId },
        create: { deviceId, macAddress: deviceId },
        update: { macAddress: deviceId },
      })
      .then(() => this.touch(mac))
      .catch((err: Error) => {
        this.logger.error(`Failed to upsert device for mac ${mac}`, err);
      });
  }

  /**
   * device/up/{mac} 上行处理：任何上报都刷新 lastSeenAt（协议 8.2 节）
   */
  private handleDeviceUp(mac: string, payload: Buffer): void {
    const message = this.parseJson<DeviceLinkMessage>(payload);
    if (!message?.cmd) {
      this.logger.warn(`device/up message from ${mac} missing cmd`);
      return;
    }

    void this.presence.record(mac, new Date()).catch((err: Error) => {
      this.logger.error(`Failed to record presence for ${mac}`, err);
    });

    switch (message.cmd) {
      case DeviceLinkCommand.Query: {
        const data = (message.data ?? {}) as DeviceQueryData;
        this.mergeQueryStatus(mac, data);
        this.renewSignaturesIfPresent(mac, data);
        break;
      }
      case DeviceLinkCommand.Volume:
        // 音量设置回执（协议 4.2 节 volume 为双向）
        this.mergeQueryStatus(mac, {
          volume: (message.data as DeviceVolumeData | null)?.volume,
        });
        break;
      case DeviceLinkCommand.Upgrade:
        // 升级结果回执（协议 4.2 节 upgrade 为双向）：当前仅记录日志
        this.logger.log(
          `Device ${mac} upgrade reply: flag=${message.flag ?? "unknown"}`,
        );
        this.touch(mac);
        break;
      default:
        this.logger.debug(`Ignoring unknown cmd from ${mac}: ${message.cmd}`);
        this.touch(mac);
    }
  }

  /**
   * MQTT v1.5 §4.2：query.data 带签名字段时才触发续签。
   * 普通 5 秒心跳不带字段，不额外读 Redis；续签失败绝不能影响状态合并或心跳。
   */
  private renewSignaturesIfPresent(mac: string, data: DeviceQueryData): void {
    const raw = data as {
      authorization_Role?: unknown;
      authorization_TTS?: unknown;
    };
    if (
      raw.authorization_Role === undefined &&
      raw.authorization_TTS === undefined
    ) {
      return;
    }
    void this.clientApi
      .renewInstanceSignatures(
        mac,
        raw.authorization_Role,
        raw.authorization_TTS,
      )
      .catch((err: Error) => {
        this.logger.error(`Failed to renew signatures for ${mac}`, err);
      });
  }

  /**
   * 合并 query/volume 上报到 Redis 状态缓存；version 同步落库 firmwareVersion
   */
  private mergeQueryStatus(mac: string, data: DeviceQueryData): void {
    this.mergeStatus(mac, data).catch((err: Error) => {
      this.logger.error(`Failed to merge status for ${mac}`, err);
    });

    if (typeof data.version === "string" && data.version.length > 0) {
      // mac 是 Redis 口径的大写归一化结果；Prisma 侧 deviceId / macAddress
      // 一律小写（docs/integration.md「设备业务 ID 与 MAC 同值（十二位小写）」），
      // 直接拿大写查库会匹配 0 行且 updateMany 不报错，故必须转换后再查。
      const deviceId = mac.toLowerCase();
      this.prisma.device
        .updateMany({
          where: { OR: [{ deviceId }, { macAddress: deviceId }] },
          data: { firmwareVersion: data.version },
        })
        .then(({ count }: { count: number }) => {
          if (count === 0) {
            this.logger.warn(
              `firmwareVersion not persisted: no Device row matches ${deviceId}`,
            );
          }
        })
        .catch((err: Error) => {
          this.logger.error(`Failed to update firmwareVersion for ${mac}`, err);
        });
    }
  }

  /** 仅刷新在线时间（无业务数据的上报，如未知 cmd） */
  private touch(mac: string): void {
    this.mergeStatus(mac, {}).catch((err: Error) => {
      this.logger.error(`Failed to touch status for ${mac}`, err);
    });
  }

  private async mergeStatus(mac: string, data: DeviceQueryData): Promise<void> {
    const current = await this.getStatus(mac);

    // 网络字段语义（MQTT v1.8 §4.1）：
    // - 字段缺省 = 老固件，按「无更新」处理，保留上一次已知值；
    // - 显式 null = 状态明确为「无」，必须覆盖（4G / 切网中 / WiFi 断开）。
    const networkMode = this.resolveNetworkMode(
      (data as { networkMode?: unknown }).networkMode,
    );
    if (networkMode !== undefined) {
      this.networkAggregation.record(mac, networkMode, new Date());
    }
    const wifiRssi = this.resolveWifiRssi(
      (data as { wifiRssi?: unknown }).wifiRssi,
      networkMode === undefined ? current.networkMode : networkMode,
      current.wifiRssi,
    );

    const updated: DeviceLinkStatus = {
      mac,
      battery: this.pickNumber(data.battery, current.battery),
      volume: this.pickNumber(data.volume, current.volume),
      version:
        typeof data.version === "string" && data.version.length > 0
          ? data.version
          : current.version,
      charging:
        typeof data.charging === "boolean" ? data.charging : current.charging,
      networkMode:
        networkMode === undefined ? current.networkMode : networkMode,
      wifiRssi: wifiRssi === undefined ? current.wifiRssi : wifiRssi,
      lastSeenAt: Date.now(),
    };

    if (
      networkMode !== undefined &&
      networkMode !== null &&
      networkMode !== current.networkMode
    ) {
      this.persistNetworkType(mac, networkMode);
    }

    await this.redisService.setValue(
      this.statusKey(mac),
      JSON.stringify(updated),
      STATUS_TTL_SECONDS,
    );
  }

  /** 合法模式才采纳；缺省/非法值返回 undefined 表示「无更新」 */
  private resolveNetworkMode(raw: unknown): NetworkMode | undefined {
    if (raw === null) return null;
    if (raw === "wifi" || raw === "4g") return raw;
    if (raw !== undefined) {
      this.logger.warn(`Ignoring invalid networkMode: ${String(raw)}`);
    }
    return undefined;
  }

  /**
   * 计算本次 RSSI 合并结果。
   * - undefined = 无更新（老固件缺省，或脏值被丢弃）
   * - null = 明确无信号（4G / 切网中 / WiFi 断开）
   */
  private resolveWifiRssi(
    raw: unknown,
    mode: NetworkMode,
    current: number | null,
  ): number | null | undefined {
    if (raw === undefined) return undefined;
    if (mode === "4g") {
      // 4G 下 wifiRssi 必为 null；若固件误带数字，以模式为准丢弃
      if (raw !== null) {
        this.logger.warn(`Ignoring wifiRssi=${String(raw)} in 4g mode`);
      }
      return null;
    }
    if (raw === null) return null;
    if (
      typeof raw === "number" &&
      Number.isInteger(raw) &&
      raw < 0 &&
      raw >= -120
    ) {
      return raw;
    }
    this.logger.warn(
      `Ignoring invalid wifiRssi: ${String(raw)} (keep ${String(current)})`,
    );
    return undefined;
  }

  /** 网络模式变化时低频同步 Device.networkType（about-device 页展示用） */
  private persistNetworkType(mac: string, mode: "wifi" | "4g"): void {
    const deviceId = mac.toLowerCase();
    this.prisma.device
      .updateMany({
        where: { OR: [{ deviceId }, { macAddress: deviceId }] },
        data: { networkType: mode === "wifi" ? "WiFi" : "4G" },
      })
      .catch((err: Error) => {
        this.logger.error(`Failed to update networkType for ${mac}`, err);
      });
  }

  private publishCommand(
    mac: string,
    cmd: DeviceLinkCommand,
    data: object | null,
  ): void {
    // 下行 topic 必须用小写（协议「无分隔十二位小写十六进制」）；normalizeMac 的大写口径只用于 Redis key
    const topicMac = this.normalizeMac(mac).toLowerCase();
    const message: DeviceLinkMessage = { cmd, flag: "success", data };
    this.mqttService.publish(
      deviceDownTopic(topicMac),
      JSON.stringify(message),
    );
    this.logger.log(`Published ${cmd} to ${deviceDownTopic(topicMac)}`);
  }

  private isOnline(lastSeenAt: number | null): boolean {
    if (!lastSeenAt) return false;
    return Date.now() - lastSeenAt <= ONLINE_WINDOW_MS;
  }

  private pickNumber(
    incoming: number | undefined,
    current: number | null,
  ): number | null {
    return typeof incoming === "number" && Number.isFinite(incoming)
      ? incoming
      : current;
  }

  private extractMacFromUpTopic(topic: string): string | null {
    const match = UP_TOPIC_REGEX.exec(topic);
    return match ? this.normalizeMac(match[1]) : null;
  }

  /** MAC 归一化：去分隔符、大写，与 RTC 链路 MAC 口径一致 */
  private normalizeMac(raw: string): string {
    return raw.replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
  }

  private parseJson<T>(payload: Buffer): T | null {
    try {
      return JSON.parse(payload.toString()) as T;
    } catch (err) {
      this.logger.warn("Failed to parse MQTT payload as JSON", err);
      return null;
    }
  }

  private statusKey(mac: string): string {
    return `device:link:${mac}`;
  }
}
