import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mqtt from 'mqtt';

/**
 * MQTT 客户端服务（signature 阶段）
 *
 * 封装与机芯厂 MQTT broker 的连接、订阅、发布、消息回调。
 * 当前阶段仅提供方法签名与基础连接管理，具体 topic 命名、payload 解析、
 * QoS、重连策略等细节留待与机芯厂联调时填充。
 */
@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client?: mqtt.MqttClient;
  private messageHandlers: Array<(topic: string, payload: Buffer) => void> = [];

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.get<string>('MQTT_URL');
    if (url) {
      this.connect(url);
    } else {
      this.logger.warn('MQTT_URL is not configured. MQTT client will remain disconnected.');
    }
  }

  onModuleDestroy(): void {
    this.disconnect();
  }

  /**
   * 连接到 MQTT broker
   * @param url broker 地址，例如 mqtt://localhost:1883
   */
  connect(url: string): void {
    this.client = mqtt.connect(url, {
      reconnectPeriod: 5000,
      connectTimeout: 30 * 1000,
      clean: true,
    });

    this.client.on('connect', () => {
      this.logger.log(`MQTT connected to ${url}`);
    });

    this.client.on('message', (topic: string, payload: Buffer) => {
      this.messageHandlers.forEach((handler) => handler(topic, payload));
    });

    this.client.on('error', (err: Error) => {
      this.logger.error('MQTT client error', err);
    });

    this.client.on('close', () => {
      this.logger.warn('MQTT connection closed');
    });

    this.client.on('reconnect', () => {
      this.logger.log('MQTT reconnecting');
    });
  }

  /**
   * 断开 MQTT 连接
   */
  disconnect(): void {
    if (this.client) {
      this.client.end();
      this.client = undefined;
    }
  }

  /**
   * 订阅指定 topic（默认 QoS 1）
   * @param topic 主题名称或通配符
   * @param qos QoS 等级，默认 1
   */
  subscribe(topic: string, qos: 0 | 1 | 2 = 1): void {
    if (!this.client) {
      this.logger.warn(`Cannot subscribe to ${topic}: MQTT client not connected`);
      return;
    }
    this.client.subscribe(topic, { qos }, (err?: Error) => {
      if (err) {
        this.logger.error(`Failed to subscribe ${topic}`, err);
      } else {
        this.logger.log(`MQTT subscribed to ${topic} with QoS ${qos}`);
      }
    });
  }

  /**
   * 向指定 topic 发布消息（默认 QoS 1，Retain false）
   * @param topic 主题名称
   * @param payload 消息内容
   * @param qos QoS 等级，默认 1
   * @param retain 是否保留消息，默认 false
   */
  publish(
    topic: string,
    payload: string | Buffer,
    qos: 0 | 1 | 2 = 1,
    retain = false,
  ): void {
    if (!this.client) {
      this.logger.warn(`Cannot publish to ${topic}: MQTT client not connected`);
      return;
    }
    this.client.publish(topic, payload, { qos, retain }, (err?: Error) => {
      if (err) {
        this.logger.error(`Failed to publish to ${topic}`, err);
      }
    });
  }

  /**
   * 注册消息回调
   * @param callback 收到消息时的处理函数
   */
  onMessage(callback: (topic: string, payload: Buffer) => void): void {
    this.messageHandlers.push(callback);
  }

  /**
   * 获取底层 MQTT 客户端（测试或高级场景使用）
   */
  getClient(): mqtt.MqttClient | undefined {
    return this.client;
  }
}
