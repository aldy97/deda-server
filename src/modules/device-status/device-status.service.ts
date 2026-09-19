import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MqttService } from '@/common/mqtt/mqtt.service';
import { RedisService } from '@/common/redis/redis.service';
import { DeviceStatusDto } from './dto/device-status.dto';
import { MqttMessage, MessageType } from './types/mqtt-message.type';
import {
  DeviceStatusData,
  ConversationRecordData,
} from './types/device-status.type';

/**
 * 设备状态服务
 *
 * 负责订阅机芯厂 MQTT 状态 topic，按《AI 玩具 MQTT 数据对接文档》解析
 * DEVICE_STATUS 与 CONVERSATION_RECORD 消息，并将设备状态合并缓存到 Redis。
 */
@Injectable()
export class DeviceStatusService implements OnModuleInit {
  private readonly logger = new Logger(DeviceStatusService.name);
  private readonly statusTopic: string;
  private readonly statusTtlSeconds: number;
  private readonly processedMessageIds = new Set<string>();
  private readonly maxMessageIdCacheSize = 10000;

  constructor(
    private readonly mqttService: MqttService,
    private readonly redisService: RedisService,
    private readonly config: ConfigService,
  ) {
    this.statusTopic =
      this.config.get<string>('MQTT_STATUS_TOPIC') || 'zhianxin/event/report';
    this.statusTtlSeconds = this.config.get<number>('MQTT_STATUS_TTL_SECONDS') || 300;
  }

  onModuleInit(): void {
    this.subscribeDeviceStatus();
  }

  /**
   * 订阅设备状态 topic
   */
  subscribeDeviceStatus(): void {
    this.mqttService.subscribe(this.statusTopic);
    this.mqttService.onMessage((topic: string, payload: Buffer) => {
      this.handleMessage(topic, payload);
    });
  }

  /**
   * 处理 MQTT 消息
   * @param topic 消息主题
   * @param payload 消息负载
   */
  handleMessage(topic: string, payload: Buffer): void {
    if (topic !== this.statusTopic) {
      return;
    }

    let message: MqttMessage<DeviceStatusData | ConversationRecordData>;
    try {
      message = JSON.parse(payload.toString());
    } catch (err) {
      this.logger.warn('Failed to parse MQTT payload as JSON', err);
      return;
    }

    if (!message.messageId) {
      this.logger.warn('MQTT message missing messageId');
      return;
    }

    if (this.isDuplicate(message.messageId)) {
      return;
    }
    this.trackMessageId(message.messageId);

    switch (message.messageType) {
      case MessageType.DEVICE_STATUS:
        this.handleDeviceStatus(message as MqttMessage<DeviceStatusData>);
        break;
      case MessageType.CONVERSATION_RECORD:
        this.handleConversationRecord(message as MqttMessage<ConversationRecordData>);
        break;
      default:
        this.logger.debug(`Ignoring unknown messageType: ${message.messageType}`);
    }
  }

  /**
   * 从 Redis 读取设备最新状态
   * @param deviceId 厂商侧设备唯一编号
   */
  async getStatus(deviceId: string): Promise<DeviceStatusDto> {
    const key = this.statusKey(deviceId);
    const cached = await this.redisService.getValue(key);
    if (cached) {
      return JSON.parse(cached);
    }
    return {
      deviceId,
      online: null,
      battery: null,
      version: null,
      runtime: null,
      network: null,
      updatedAt: null,
    };
  }

  /**
   * 将状态写入 Redis 缓存
   */
  async cacheStatus(deviceId: string, status: DeviceStatusDto): Promise<void> {
    const key = this.statusKey(deviceId);
    await this.redisService.setValue(key, JSON.stringify(status), this.statusTtlSeconds);
  }

  private handleDeviceStatus(message: MqttMessage<DeviceStatusData>): void {
    const deviceId = message.deviceId;
    if (!deviceId) {
      this.logger.warn('DEVICE_STATUS message missing deviceId');
      return;
    }

    this.mergeStatus(deviceId, message.data, message.occurredAt).catch((err) => {
      this.logger.error(`Failed to merge status for ${deviceId}`, err);
    });
  }

  private handleConversationRecord(message: MqttMessage<ConversationRecordData>): void {
    // TODO: 如需持久化会话记录，可在此写入 Conversation 表
    this.logger.debug(
      `Received conversation record for ${message.deviceId}: sessionId=${message.data.sessionId}`,
    );
  }

  private async mergeStatus(
    deviceId: string,
    data: DeviceStatusData,
    occurredAt: number,
  ): Promise<void> {
    const current = await this.getStatus(deviceId);

    const updated: DeviceStatusDto = {
      ...current,
      deviceId,
      updatedAt: occurredAt || Date.now(),
    };

    if (data.online) {
      updated.online = data.online;
    }
    if (data.battery) {
      updated.battery = this.isNewer(data.battery.reportedAt, current.battery?.reportedAt)
        ? data.battery
        : current.battery;
    }
    if (data.version) {
      updated.version = data.version;
    }
    if (data.runtime) {
      updated.runtime = data.runtime;
    }
    if (data.network) {
      updated.network = data.network;
    }

    await this.cacheStatus(deviceId, updated);
  }

  private isNewer(newTime?: number, currentTime?: number): boolean {
    if (!newTime) return false;
    if (!currentTime) return true;
    return newTime >= currentTime;
  }

  private isDuplicate(messageId: string): boolean {
    return this.processedMessageIds.has(messageId);
  }

  private trackMessageId(messageId: string): void {
    this.processedMessageIds.add(messageId);
    if (this.processedMessageIds.size > this.maxMessageIdCacheSize) {
      const first = this.processedMessageIds.values().next().value;
      this.processedMessageIds.delete(first);
    }
  }

  private statusKey(deviceId: string): string {
    return `device:status:${deviceId}`;
  }
}
