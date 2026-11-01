import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { DeviceStatusService } from "../device-status/device-status.service";
import { ManufacturerService } from "../manufacturer/manufacturer.service";
import { BindDeviceDto } from "./dto/bind-device.dto";
import { WifiConfigDto } from "./dto/wifi-config.dto";
import { DeviceControlDto } from "./dto/device-control.dto";
import { UpdateDeviceOrderDto } from "./dto/update-device-order.dto";

const BINDING_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
};

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deviceStatusService: DeviceStatusService,
    private readonly manufacturer: ManufacturerService,
  ) {}

  async bind(userId: string, dto: BindDeviceDto) {
    if (!dto.deviceId && !dto.deviceCode) {
      throw new Error("deviceId or deviceCode is required");
    }

    return this.prisma.$transaction(async (tx) => {
      let device;

      if (dto.deviceId) {
        // 按 deviceId 查找或创建（可能已由 4G 对话懒创建）
        device = await tx.device.findUnique({
          where: { deviceId: dto.deviceId },
        });
        if (!device) {
          device = await tx.device.create({
            data: { deviceId: dto.deviceId },
          });
        }
      } else if (dto.deviceCode) {
        // 按 deviceCode 查找，不存在则报错（避免随意创建）
        device = await tx.device.findUnique({
          where: { deviceCode: dto.deviceCode },
        });
        if (!device) {
          throw new NotFoundException(
            `Device with code ${dto.deviceCode} not found`,
          );
        }
      } else {
        throw new Error("deviceId or deviceCode is required");
      }

      const existing = await tx.userDeviceBinding.findUnique({
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

      const lastBinding = await tx.userDeviceBinding.aggregate({
        where: { userId },
        _max: { sortOrder: true },
      });
      await tx.userDeviceBinding.create({
        data: {
          userId,
          deviceId: device.id,
          isOwner: true,
          sortOrder: (lastBinding._max.sortOrder ?? -1) + 1,
        },
      });

      return { success: true, deviceId: device.deviceId, alreadyBound: false };
    }, BINDING_TRANSACTION_OPTIONS);
  }

  async list(userId: string) {
    const bindings = await this.prisma.userDeviceBinding.findMany({
      where: { userId },
      include: { device: { include: { childProfile: true } } },
      orderBy: [
        { sortOrder: "asc" },
        { createdAt: "asc" },
        { deviceId: "asc" },
      ],
    });
    return bindings.map((b) => ({
      id: b.device.deviceId,
      name: b.device.deviceCode || b.device.deviceId,
      deviceId: b.device.deviceId,
      deviceCode: b.device.deviceCode,
      networkType: b.device.networkType,
      firmwareVersion: b.device.firmwareVersion,
      childProfile: b.device.childProfile
        ? {
            name: b.device.childProfile.name,
            englishName: b.device.childProfile.englishName,
          }
        : null,
    }));
  }

  async updateOrder(userId: string, dto: UpdateDeviceOrderDto) {
    const orderedDeviceIds = dto.orderedDeviceIds;
    if (
      !Array.isArray(orderedDeviceIds) ||
      orderedDeviceIds.length === 0 ||
      orderedDeviceIds.some(
        (deviceId) => typeof deviceId !== "string" || deviceId.trim() === "",
      ) ||
      new Set(orderedDeviceIds).size !== orderedDeviceIds.length
    ) {
      throw new BadRequestException(
        "orderedDeviceIds must be a non-empty array of unique device IDs",
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const [bindings, devices] = await Promise.all([
          tx.userDeviceBinding.findMany({
            where: { userId },
            include: { device: true },
          }),
          tx.device.findMany({
            where: { deviceId: { in: orderedDeviceIds } },
            select: { id: true, deviceId: true },
          }),
        ]);
        const bindingByDeviceId = new Map(
          bindings.map((binding) => [binding.device.deviceId, binding]),
        );
        const existingDeviceIds = new Set(
          devices.map((device) => device.deviceId),
        );

        if (orderedDeviceIds.some((id) => !existingDeviceIds.has(id))) {
          throw new ConflictException(
            "The device list changed; reload it before reordering",
          );
        }
        if (orderedDeviceIds.some((id) => !bindingByDeviceId.has(id))) {
          throw new ForbiddenException(
            "Cannot reorder a device that is not bound to the current user",
          );
        }
        if (
          bindings.length !== orderedDeviceIds.length ||
          bindings.some(
            (binding) => !orderedDeviceIds.includes(binding.device.deviceId),
          )
        ) {
          throw new ConflictException(
            "The complete bound device list is required",
          );
        }

        for (const [sortOrder, deviceId] of orderedDeviceIds.entries()) {
          await tx.userDeviceBinding.update({
            where: { id: bindingByDeviceId.get(deviceId).id },
            data: { sortOrder },
          });
        }
        return { orderedDeviceIds };
      }, BINDING_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      if ((error as { code?: string })?.code === "P2034") {
        throw new ConflictException(
          "The device list changed during reordering; reload and retry",
        );
      }
      throw error;
    }
  }

  async detail(userId: string, id: string) {
    const binding = await this.prisma.userDeviceBinding.findFirst({
      where: { userId, device: { deviceId: id } },
      include: { device: true },
    });
    return binding?.device ?? null;
  }

  async status(id: string) {
    // TODO: 等待 MQTT 与机芯厂商对接后替换为真实状态
    // 当前为硬编码状态，仅用于 wechat-app 联调验证设备状态展示。
    return {
      deviceId: id,
      status: "online" as const,
      battery: 78,
      isCharging: true,
      lastActiveAt: new Date().toISOString(),
    };
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
    return this.prisma.$transaction(async (tx) => {
      const device = await tx.device.findUnique({
        where: { deviceId: id },
      });
      if (!device) {
        throw new NotFoundException(`Device ${id} not found`);
      }

      await tx.userDeviceBinding.deleteMany({
        where: { userId, deviceId: device.id },
      });

      return { success: true, deviceId: id };
    }, BINDING_TRANSACTION_OPTIONS);
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
