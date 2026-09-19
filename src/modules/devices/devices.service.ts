import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { DeviceStatusService } from "../device-status/device-status.service";
import { ManufacturerService } from "../manufacturer/manufacturer.service";
import { BindDeviceDto } from "./dto/bind-device.dto";
import { WifiConfigDto } from "./dto/wifi-config.dto";
import { DeviceControlDto } from "./dto/device-control.dto";

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deviceStatusService: DeviceStatusService,
    private readonly manufacturer: ManufacturerService,
  ) {}

  async bind(dto: BindDeviceDto) {
    // 查找或创建设备（可能已由 4G 对话懒创建）
    let device = await this.prisma.device.findUnique({
      where: { deviceId: dto.deviceId },
    });
    if (!device) {
      device = await this.prisma.device.create({
        data: { deviceId: dto.deviceId },
      });
    }

    // 检查是否已绑定
    const existing = await this.prisma.userDeviceBinding.findUnique({
      where: {
        userId_deviceId: {
          userId: dto.userId,
          deviceId: device.id,
        },
      },
    });

    if (existing) {
      return { success: true, deviceId: dto.deviceId, alreadyBound: true };
    }

    // 当前阶段不区分 owner/member，isOwner 默认 false，保留扩展性
    await this.prisma.userDeviceBinding.create({
      data: {
        userId: dto.userId,
        deviceId: device.id,
        isOwner: false,
      },
    });

    return { success: true, deviceId: dto.deviceId, alreadyBound: false };
  }

  async list(userId: string) {
    const bindings = await this.prisma.userDeviceBinding.findMany({
      where: { userId },
      include: { device: true },
    });
    return bindings.map((b) => b.device);
  }

  async detail(userId: string, id: string) {
    const binding = await this.prisma.userDeviceBinding.findFirst({
      where: { userId, device: { deviceId: id } },
      include: { device: true },
    });
    return binding?.device ?? null;
  }

  async status(id: string) {
    return this.deviceStatusService.getStatus(id);
  }

  async control(id: string, dto: DeviceControlDto) {
    // TODO: 转发控制指令到厂商服务器
    return { success: true, deviceId: id, action: dto.action };
  }

  async applyWifi(id: string, dto: WifiConfigDto) {
    // TODO: 通过厂商接口下发 WiFi 配置
    return { success: true, deviceId: id, ssid: dto.ssid };
  }

  async unbind(userId: string, id: string) {
    const device = await this.prisma.device.findUnique({
      where: { deviceId: id },
    });
    if (!device) {
      throw new NotFoundException(`Device ${id} not found`);
    }

    await this.prisma.userDeviceBinding.deleteMany({
      where: { userId, deviceId: device.id },
    });

    return { success: true, deviceId: id };
  }

  async findMembers(id: string) {
    const device = await this.prisma.device.findUnique({
      where: { deviceId: id },
    });
    if (!device) {
      throw new NotFoundException(`Device ${id} not found`);
    }

    const bindings = await this.prisma.userDeviceBinding.findMany({
      where: { deviceId: device.id },
      include: { user: { select: { id: true, openid: true, nickname: true } } },
    });

    return bindings.map((b) => ({
      userId: b.userId,
      isOwner: b.isOwner,
      boundAt: b.createdAt,
      user: b.user,
    }));
  }
}
