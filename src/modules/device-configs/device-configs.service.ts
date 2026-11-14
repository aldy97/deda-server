import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SwitchModeDto } from "./dto/switch-mode.dto";
import { ApplyDeviceConfigDto } from "./dto/apply-device-config.dto";
import { DeviceConfigResponseDto } from "./dto/device-config-response.dto";
import { DEVICE_MODES, DeviceMode } from "./device-config.constants";

@Injectable()
export class DeviceConfigsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 查询设备当前生效配置
   */
  async current(
    userId: string,
    deviceId: string,
  ): Promise<DeviceConfigResponseDto> {
    await this.ensureDeviceOwnership(userId, deviceId);

    const config = await this.prisma.deviceConfig.findFirst({
      where: {
        device: { deviceId },
        isActive: true,
      },
      orderBy: { createdAt: "desc" },
    });

    if (config) {
      return await this.mapToResponseDto(config, deviceId);
    }

    return {
      deviceId,
      mode: "free_chat",
      cefrLevel: null,
      language: "bilingual",
      speechRate: "normal",
    };
  }

  /**
   * 应用教材/单元等完整配置
   */
  async apply(
    userId: string,
    deviceId: string,
    dto: ApplyDeviceConfigDto,
  ): Promise<DeviceConfigResponseDto> {
    const deviceInternalId = await this.ensureDeviceOwnership(userId, deviceId);

    await this.validateModePayload(dto);

    const newConfig = await this.createActiveConfig(deviceInternalId, {
      mode: dto.mode,
      cefrLevel: dto.cefrLevel || null,
      language: dto.language || "bilingual",
      speechRate: dto.speechRate || "normal",
    });

    return await this.mapToResponseDto(newConfig, deviceId);
  }

  /**
   * 切换对话模式/子模式
   */
  async switchMode(
    userId: string,
    deviceId: string,
    dto: SwitchModeDto,
  ): Promise<DeviceConfigResponseDto> {
    const deviceInternalId = await this.ensureDeviceOwnership(userId, deviceId);

    await this.validateModePayload(dto);

    const newConfig = await this.createActiveConfig(deviceInternalId, {
      mode: dto.mode,
      cefrLevel: null,
      language: dto.language || "bilingual",
      speechRate: dto.speechRate || "normal",
    });

    return await this.mapToResponseDto(newConfig, deviceId);
  }

  /** 校验 mode 是否为合法 DEVICE_MODES 值。 */
  private validateModePayload(dto: { mode: string }): void {
    const { mode } = dto;

    if (!DEVICE_MODES.includes(mode as DeviceMode)) {
      throw new BadRequestException(`Invalid mode: ${mode}`);
    }
  }

  /**
   * 校验设备归属
   * @returns 设备内部 ID
   */
  private async ensureDeviceOwnership(
    userId: string,
    deviceId: string,
  ): Promise<string> {
    const binding = await this.prisma.userDeviceBinding.findFirst({
      where: {
        userId,
        device: { deviceId },
      },
      include: { device: true },
    });

    if (!binding) {
      throw new ForbiddenException("Device not bound to current user");
    }

    return binding.device.id;
  }

  /**
   * 失效旧配置并创建新配置
   */
  private async createActiveConfig(
    deviceInternalId: string,
    data: {
      mode: string;
      cefrLevel: string | null;
      language: string;
      speechRate: string;
    },
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.deviceConfig.updateMany({
        where: { deviceId: deviceInternalId, isActive: true },
        data: { isActive: false },
      });
    });

    return this.prisma.deviceConfig.create({
      data: {
        deviceId: deviceInternalId,
        ...data,
        isActive: true,
      },
    });
  }

  private async mapToResponseDto(
    config: any,
    businessDeviceId: string,
  ): Promise<DeviceConfigResponseDto> {
    return {
      deviceId: businessDeviceId,
      mode: config.mode,
      cefrLevel: config.cefrLevel,
      language: config.language,
      speechRate: config.speechRate,
    };
  }
}
