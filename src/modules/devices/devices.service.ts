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

  async bind(userId: string, dto: BindDeviceDto) {
    if (!dto.deviceId && !dto.deviceCode) {
      throw new Error('deviceId or deviceCode is required');
    }

    let device;

    if (dto.deviceId) {
      // 按 deviceId 查找或创建（可能已由 4G 对话懒创建）
      device = await this.prisma.device.findUnique({
        where: { deviceId: dto.deviceId },
      });
      if (!device) {
        device = await this.prisma.device.create({
          data: { deviceId: dto.deviceId },
        });
      }
    } else if (dto.deviceCode) {
      // 按 deviceCode 查找，不存在则报错（避免随意创建）
      device = await this.prisma.device.findUnique({
        where: { deviceCode: dto.deviceCode },
      });
      if (!device) {
        throw new NotFoundException(`Device with code ${dto.deviceCode} not found`);
      }
    } else {
      throw new Error('deviceId or deviceCode is required');
    }

    // 检查是否已绑定
    const existing = await this.prisma.userDeviceBinding.findUnique({
      where: {
        userId_deviceId: {
          userId,
          deviceId: device.id,
        },
      },
    });

    if (existing) {
      return { success: true, deviceId: device.deviceId, alreadyBound: true };
    }

    // 当前阶段不区分 owner/member，isOwner 默认 true（第一个绑定者）
    await this.prisma.userDeviceBinding.create({
      data: {
        userId,
        deviceId: device.id,
        isOwner: true,
      },
    });

    return { success: true, deviceId: device.deviceId, alreadyBound: false };
  }

  async list(userId: string) {
    const bindings = await this.prisma.userDeviceBinding.findMany({
      where: { userId },
      include: { device: true },
    });
    return bindings.map((b) => ({
      id: b.device.deviceId,
      name: b.device.deviceCode || b.device.deviceId,
      deviceId: b.device.deviceId,
      deviceCode: b.device.deviceCode,
      networkType: b.device.networkType,
      firmwareVersion: b.device.firmwareVersion,
    }));
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
