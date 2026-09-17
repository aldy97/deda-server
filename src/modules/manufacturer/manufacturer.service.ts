import { Injectable } from "@nestjs/common";
import { HttpService } from "@nestjs/axios";
import { ConfigService } from "@nestjs/config";

/**
 * 机芯厂商 API 客户端封装
 * 负责：连接设备、切换打断模式、获取设备信息、查询配网状态、
 * 获取绑定设备列表、调节音量/亮度、切换对话模式、查询在线状态、
 * 查询电量、查询充电状态、休眠设定、音乐播放控制、网易云绑定等。
 */
@Injectable()
export class ManufacturerService {
  private readonly baseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = this.config.get<string>("MANUFACTURER_BASE_URL") || "";
  }

  async switchConversationMode(deviceId: string, config: any) {
    // TODO: 调用厂商切换对话模式接口，扩展参数：教材ID、单元ID、学习模式、CEFR等级
    return { success: true };
  }

  async syncModeConfig(
    deviceId: string,
    config: {
      mode: string;
      language?: string;
      speechRate?: string;
      textbookId?: string;
      unitId?: string;
    },
  ) {
    // TODO: 同步当前生效模式/语言/语速给机芯厂，确保 ASR/TTS 参数匹配
    return { success: true, deviceId };
  }

  async getDeviceInfo(deviceId: string) {
    // TODO: 获取设备编码、固件版本、WiFi名称、IP地址、网络类型
    return null;
  }

  async getNetworkStatus(deviceId: string) {
    // TODO: 查询 4G/WiFi 配网状态
    return null;
  }

  async getOnlineStatus(deviceId: string) {
    // TODO: 查询设备在线离线状态
    return null;
  }

  async getBattery(deviceId: string) {
    // TODO: 查询电量百分比
    return null;
  }

  async getChargeStatus(deviceId: string) {
    // TODO: 查询充电状态
    return null;
  }

  async controlVolume(deviceId: string, volume: number) {
    // TODO: 调节音量
    return { success: true, deviceId, volume };
  }

  async controlBrightness(deviceId: string, brightness: number) {
    // TODO: 调节机芯亮度
    return { success: true, deviceId, brightness };
  }

  async controlPower(deviceId: string, powerOn: boolean) {
    // TODO: 开关机/唤醒/休眠
    return { success: true, deviceId, powerOn };
  }

  async controlInterrupt(deviceId: string, enabled: boolean) {
    // TODO: 开启/关闭打断模式
    return { success: true, deviceId, interruptEnabled: enabled };
  }

  async setSleep(deviceId: string, enabled: boolean, timeoutMinutes?: number) {
    // TODO: 休眠设定
    return { success: true, deviceId, enabled, timeoutMinutes };
  }

  async setAutoShutdown(
    deviceId: string,
    enabled: boolean,
    timeoutMinutes?: number,
  ) {
    // TODO: 自动关机设定
    return { success: true, deviceId, enabled, timeoutMinutes };
  }

  async applyWifi(deviceId: string, ssid: string, password: string) {
    // TODO: 下发 WiFi 凭证到设备
    return { success: true, deviceId, ssid };
  }

  async controlMusic(
    deviceId: string,
    action: string,
    songId?: string,
    volume?: number,
  ) {
    // TODO: 音乐播放控制
    return { success: true, deviceId, action, songId, volume };
  }

  async bindNeteaseMusic(deviceId: string, authCode: string) {
    // TODO: 将网易云授权信息同步给机芯厂
    return { success: true, deviceId };
  }

  async reboot(deviceId: string, factoryReset = false) {
    // TODO: 远程重启/恢复出厂
    return { success: true, deviceId, factoryReset };
  }

  async ota(deviceId: string, firmwareVersion: string, firmwareUrl: string) {
    // TODO: 下发 OTA
    return { success: true, deviceId, firmwareVersion, firmwareUrl };
  }
}
