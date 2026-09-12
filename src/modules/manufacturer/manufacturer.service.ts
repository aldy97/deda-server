import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

/**
 * 机芯厂商 API 客户端封装
 * 负责：连接设备、切换打断模式、获取设备信息、查询配网状态、
 * 获取绑定设备列表、调节音量/亮度、切换对话模式、查询在线状态、
 * 查询电量、查询充电状态、休眠设定、音乐播放控制等。
 */
@Injectable()
export class ManufacturerService {
  private readonly baseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = this.config.get<string>('MANUFACTURER_BASE_URL') || '';
  }

  async switchConversationMode(deviceId: string, config: any) {
    // TODO: 调用厂商切换对话模式接口，扩展参数：教材ID、单元ID、学习模式、CEFR等级
    return { success: true };
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
    return null;
  }

  async controlBrightness(deviceId: string, brightness: number) {
    // TODO: 调节机芯亮度
    return null;
  }

  async setSleep(deviceId: string, enabled: boolean, timeoutMinutes?: number) {
    // TODO: 休眠设定
    return null;
  }

  async controlMusic(deviceId: string, action: string) {
    // TODO: 音乐播放控制
    return null;
  }
}
