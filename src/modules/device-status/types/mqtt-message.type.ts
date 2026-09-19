/**
 * MQTT 消息类型枚举
 * 对应《AI 玩具 MQTT 数据对接文档》中的 messageType
 */
export enum MessageType {
  DEVICE_STATUS = 'DEVICE_STATUS',
  CONVERSATION_RECORD = 'CONVERSATION_RECORD',
}

/**
 * MQTT 外层消息结构
 *
 * 所有设备统一使用 topic `zhianxin/event/report`，通过 messageType 和 deviceId 区分。
 */
export interface MqttMessage<T = unknown> {
  /** 数据协议版本，当前固定为 1.0 */
  version: string;

  /** 全局唯一消息 ID，用于幂等和去重 */
  messageId: string;

  /** 消息类型 */
  messageType: MessageType | string;

  /** 唯一设备 ID */
  deviceId: string;

  /** 数据或事件实际发生时间，Unix 毫秒时间戳 */
  occurredAt: number;

  /** 消息发送时间，Unix 毫秒时间戳 */
  sentAt: number;

  /** 同一设备内单调递增的消息序号 */
  seq: number;

  /** 具体业务数据 */
  data: T;
}
