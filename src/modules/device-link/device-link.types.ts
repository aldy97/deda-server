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

/**
 * 当前已就绪的网络模式（协议 v1.8 `query.data.networkMode`）。
 * `null` 表示切网期间两路均未就绪；字段缺省表示老固件未上报。
 */
export type NetworkMode = "wifi" | "4g" | null;

/** query 上报数据：电量 / 音量 / 固件版本 / 充电状态 / 网络信息 */
export interface DeviceQueryData {
  battery?: number;
  volume?: number;
  version?: string;
  /**
   * 充电状态（2026-11-11 与机芯厂约定增补）。
   * 机芯厂 v1.1 契约类型为 boolean | null：显式 null 表示当前未知，
   * 与 battery / volume / version 同口径保留上一次已知值。
   */
  charging?: boolean | null;
  /**
   * 当前网络模式（协议 v1.8）。设备每次心跳都携带；
   * 字段缺省只可能是老固件，按「无更新」处理。
   */
  networkMode?: NetworkMode;
  /**
   * WiFi 信号强度 dBm（协议 v1.8）。仅 wifi 模式有意义；
   * 4G 或网络未就绪时为显式 null（需清空旧值）；缺省表示老固件未上报。
   */
  wifiRssi?: number | null;
  /**
   * 续签用的 switchSceneRole BCE 签名（协议 v1.5 §4.2，每 600 秒上报）。
   * 仅用于替换当前实例签名，**不写入 device:link 状态缓存、不落日志**。
   */
  authorization_Role?: string;
  /**
   * 续签用的 interrupt BCE 签名（协议 v1.5 §4.2，每 600 秒上报）。
   * 仅用于替换当前实例签名，**不写入 device:link 状态缓存、不落日志**。
   */
  authorization_TTS?: string;
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
  charging: boolean | null;
  /** 最近一次上报的网络模式；从未上报为 null */
  networkMode: NetworkMode;
  /** 最近一次上报的 WiFi RSSI（dBm）；4G / 未上报 / 已清空为 null */
  wifiRssi: number | null;
  /** 最后一次收到该设备任意上报的时间（Unix 毫秒） */
  lastSeenAt: number | null;
}
