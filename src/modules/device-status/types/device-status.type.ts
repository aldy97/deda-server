/**
 * 在线状态
 */
export interface OnlineStatus {
  /** 当前在线状态 */
  status: 'ONLINE' | 'OFFLINE' | 'UNKNOWN';

  /** 本次连接建立时间，Unix 毫秒时间戳 */
  connectedAt?: number;

  /** 最后一次确认设备在线的时间，Unix 毫秒时间戳 */
  lastSeenAt: number;

  /** 最近一次离线原因 */
  disconnectReason?: string | null;
}

/**
 * 电量状态
 */
export interface BatteryStatus {
  /** 当前电量百分比，0 ~ 100 */
  percent: number;

  /** 当前充电状态 */
  chargingStatus: 'NOT_CHARGING' | 'CHARGING' | 'FULL' | 'UNKNOWN';

  /** 是否低电量：0 否，1 是 */
  lowBattery: number;

  /** 电量实际测量时间，Unix 毫秒时间戳 */
  reportedAt: number;
}

/**
 * 设备版本
 */
export interface VersionStatus {
  /** 当前设备固件版本 */
  firmwareVersion: string;

  /** 当前设备硬件版本 */
  hardwareVersion: string;

  /** 当前数据通信协议版本 */
  protocolVersion: string;
}

/**
 * 运行状态
 */
export interface RuntimeStatus {
  /** 电源状态 */
  powerState?: string;

  /** 工作状态 */
  workState: string;

  /** 睡眠状态 */
  sleepState?: string;

  /** 最近一次启动时间，Unix 毫秒时间戳 */
  bootAt?: number;

  /** 本次启动后的运行时长，单位秒 */
  uptimeSeconds?: number;

  /** 最近一次用户交互时间，Unix 毫秒时间戳 */
  lastInteractionAt?: number;
}

/**
 * 网络状态
 */
export interface NetworkStatus {
  /** 当前是否已连接 Wi-Fi：0 否，1 是 */
  wifiConnected: number;

  /** 当前连接或最近一次成功连接的 Wi-Fi 名称 */
  ssid?: string;

  /** 当前 Wi-Fi 信号强度，单位 dBm */
  rssi?: number;

  /** 最近一次成功连接 Wi-Fi 的时间，Unix 毫秒时间戳 */
  lastConnectedAt?: number;

  /** 最近一次网络断开原因 */
  lastDisconnectReason?: string | null;
}

/**
 * 设备状态 data 对象（PDF 中 DEVICE_STATUS 的 data 字段）
 */
export interface DeviceStatusData {
  online?: OnlineStatus;
  battery?: BatteryStatus;
  version?: VersionStatus;
  runtime?: RuntimeStatus;
  network?: NetworkStatus;
}

/**
 * 会话记录 data 对象（PDF 中 CONVERSATION_RECORD 的 data 字段）
 */
export interface ConversationRecordData {
  /** 本次会话的唯一 ID */
  sessionId: string;

  /** 用户语音识别后的文本内容 */
  userText: string;

  /** 玩具回复的文本内容 */
  toyReply: string;

  /** 对话使用的语言，例如 zh-CN */
  language?: string;
}
