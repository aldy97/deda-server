import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { BindDeviceDto } from "./dto/bind-device.dto";
import { WifiConfigDto } from "./dto/wifi-config.dto";
import { DeviceControlDto } from "./dto/device-control.dto";

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async bind(dto: BindDeviceDto) {
    // TODO: 校验设备合法性，建立用户-设备-孩子档案绑定关系
    return { success: true, deviceId: dto.deviceId };
  }

  async list(query: any) {
    // TODO: 查询绑定关系并拉取厂商状态
    return [];
  }

  async detail(id: string) {
    // TODO: 查询设备详情
    return null;
  }

  async status(id: string) {
    // TODO: 调用厂商接口查询设备状态并缓存
    return null;
  }

  async control(id: string, dto: DeviceControlDto) {
    // TODO: 转发控制指令到厂商服务器
    return { success: true, deviceId: id, action: dto.action };
  }

  async applyWifi(id: string, dto: WifiConfigDto) {
    // TODO: 通过厂商接口下发 WiFi 配置
    return { success: true, deviceId: id, ssid: dto.ssid };
  }

  async unbind(id: string) {
    // TODO: 删除绑定关系
    return { success: true, deviceId: id };
  }
}
