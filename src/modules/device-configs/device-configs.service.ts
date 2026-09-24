import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SwitchModeDto } from "./dto/switch-mode.dto";
import { ApplyDeviceConfigDto } from "./dto/apply-device-config.dto";
import { DeviceConfigResponseDto } from "./dto/device-config-response.dto";

@Injectable()
export class DeviceConfigsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

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

    // 无配置时返回 .env 默认值兜底
    const defaultTextbookId =
      this.configService.get<string>("DEFAULT_TEXTBOOK_ID") ||
      "sample-textbook";
    const defaultUnitId =
      this.configService.get<string>("DEFAULT_UNIT_ID") || "unit-1";
    const names = await this.fetchTextbookUnitNames(
      defaultTextbookId,
      defaultUnitId,
    );

    return {
      deviceId,
      mode: "locked_unit",
      textbookId: defaultTextbookId,
      textbookName: names.textbookName,
      unitId: defaultUnitId,
      unitName: names.unitName,
      conversationModeKey: null,
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
    const deviceInternalId = await this.ensureDeviceOwnership(
      userId,
      deviceId,
    );

    if (dto.textbookId && dto.unitId) {
      const textbook = await this.prisma.textbook.findUnique({
        where: { textbookId: dto.textbookId },
        select: { id: true },
      });

      if (!textbook) {
        throw new NotFoundException(`Textbook not found: ${dto.textbookId}`);
      }

      const unit = await this.prisma.unit.findUnique({
        where: {
          textbookId_unitId: {
            textbookId: textbook.id,
            unitId: dto.unitId,
          },
        },
      });

      if (!unit) {
        throw new NotFoundException(
          `Unit not found: textbookId=${dto.textbookId}, unitId=${dto.unitId}`,
        );
      }
    }

    const newConfig = await this.createActiveConfig(deviceInternalId, {
      mode: dto.mode,
      textbookId: dto.textbookId || null,
      unitId: dto.unitId || null,
      conversationModeKey: dto.conversationModeKey || null,
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
    const deviceInternalId = await this.ensureDeviceOwnership(
      userId,
      deviceId,
    );

    const newConfig = await this.createActiveConfig(deviceInternalId, {
      mode: dto.mode,
      textbookId: dto.textbookId || null,
      unitId: dto.unitId || null,
      conversationModeKey: dto.conversationModeKey || null,
      cefrLevel: null,
      language: dto.language || "bilingual",
      speechRate: dto.speechRate || "normal",
    });

    return await this.mapToResponseDto(newConfig, deviceId);
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
      throw new ForbiddenException(
        "Device not bound to current user",
      );
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
      textbookId: string | null;
      unitId: string | null;
      conversationModeKey: string | null;
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
    const names = await this.fetchTextbookUnitNames(
      config.textbookId,
      config.unitId,
    );

    return {
      deviceId: businessDeviceId,
      mode: config.mode,
      conversationModeKey: config.conversationModeKey,
      textbookId: config.textbookId,
      textbookName: names.textbookName,
      unitId: config.unitId,
      unitName: names.unitName,
      cefrLevel: config.cefrLevel,
      language: config.language,
      speechRate: config.speechRate,
    };
  }

  /**
   * 根据业务 ID 查询教材/单元名称
   */
  private async fetchTextbookUnitNames(
    textbookId?: string | null,
    unitId?: string | null,
  ): Promise<{ textbookName?: string | null; unitName?: string | null }> {
    if (!textbookId) {
      return { textbookName: null, unitName: null };
    }

    const textbook = await this.prisma.textbook.findUnique({
      where: { textbookId },
      select: { id: true, name: true },
    });

    if (!textbook) {
      return { textbookName: null, unitName: null };
    }

    let unitName: string | null = null;
    if (unitId) {
      const unit = await this.prisma.unit.findUnique({
        where: {
          textbookId_unitId: {
            textbookId: textbook.id,
            unitId,
          },
        },
        select: { name: true },
      });
      unitName = unit?.name ?? null;
    }

    return { textbookName: textbook.name, unitName };
  }
}
