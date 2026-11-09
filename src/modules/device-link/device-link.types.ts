/**
 * 机芯厂 MQTT 设备管理协议类型定义
 *
 * 对应 docs/vendor-mqtt-protocol.md（智安芯《设备端 MQTT 对接文档》）。
 * 与旧协议（device-status 模块，topic zhianxin/event/report）无关，两者并行运行，
 * 待机芯厂确认旧协议下线后再做清理。
 */

/** 上行：设备连接后首先上报标识的主题 */
export const LOGIN_MAC_TOPIC = "loginMac";

/** 上行：设备状态/心跳主题通配符 */
export const DEVICE_UP_TOPIC_PATTERN = "device/up/+";

/** 下行：服务端指令主题 */
export const deviceDownTopic = (mac: string): string => `device/down/${mac}`;

/** 在线判定窗口：超过 15 秒（3 倍心跳间隔）未收到上报视为离线 */
export const ONLINE_WINDOW_MS = 15_000;

/** 状态缓存 TTL：保留最近一次已知状态，远超离线窗口，供 App 展示最后状态 */
export const STATUS_TTL_SECONDS = 3600;

/** 业务命令字 */
export enum DeviceLinkCommand {
  Query = "query",
  Volume = "volume",
  Restart = "restart",
  Upgrade = "upgrade",
  Recover = "recover",
}

/** loginMac 上报载荷 */
export interface LoginMacPayload {
  device?: string;
}

/** device/up|down 通用消息信封 */
export interface DeviceLinkMessage<T = unknown> {
  cmd?: string;
  flag?: "success" | "fail" | string;
  data?: T | null;
}

/** query 上报数据：电量 / 音量 / 固件版本 */
export interface DeviceQueryData {
  battery?: number;
  volume?: number;
  version?: string;
}

/** volume 指令/回执数据 */
export interface DeviceVolumeData {
  volume?: number;
}

/** 服务端缓存的设备链路状态 */
export interface DeviceLinkStatus {
  mac: string;
  battery: number | null;
  volume: number | null;
  version: string | null;
  /** 最后一次收到该设备任意上报的时间（Unix 毫秒） */
  lastSeenAt: number | null;
}
