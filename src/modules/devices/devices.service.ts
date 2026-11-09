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
import { DeviceLinkService } from "../device-link/device-link.service";
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
    private readonly deviceLink: DeviceLinkService,
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
    const device = await this.prisma.device.findUnique({
      where: { deviceId: id },
    });
    if (!device) {
      throw new NotFoundException(`Device ${id} not found`);
    }

    // 新 MQTT 协议（docs/vendor-mqtt-protocol.md）：状态来自 device-link 的
    // Redis 缓存，在线判定按协议 8.2 节 15 秒心跳窗口计算。
    // isCharging 暂无协议字段来源，固定返回 null（已请机芯厂补充）。
    const link = await this.deviceLink.getStatus(
      device.macAddress ?? device.deviceId,
    );
    return {
      deviceId: id,
      status: link.online ? ("online" as const) : ("offline" as const),
      battery: link.battery,
      isCharging: null,
      lastActiveAt: link.lastSeenAt
        ? new Date(link.lastSeenAt).toISOString()
        : null,
    };
  }

  async control(id: string, dto: DeviceControlDto) {
    // 新 MQTT 协议目前仅支持 volume 下发；power/interrupt/sleep/auto_shutdown
    // 待机芯厂补充协议后接入，本次维持既有假成功行为。
    if (dto.action === "volume") {
      if (dto.volume === undefined) {
        throw new BadRequestException("volume is required when action=volume");
      }
      const device = await this.prisma.device.findUnique({
        where: { deviceId: id },
      });
      if (!device) {
        throw new NotFoundException(`Device ${id} not found`);
      }
      this.deviceLink.setVolume(
        device.macAddress ?? device.deviceId,
        dto.volume,
      );
    }
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
