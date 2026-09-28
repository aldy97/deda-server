import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SwitchModeDto } from "./dto/switch-mode.dto";
import { ApplyDeviceConfigDto } from "./dto/apply-device-config.dto";
import { DeviceConfigResponseDto } from "./dto/device-config-response.dto";
import { DEVICE_MODES, DeviceMode } from "./device-config.constants";

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
    const deviceInternalId = await this.ensureDeviceOwnership(userId, deviceId);

    await this.validateModePayload(dto);

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
    const deviceInternalId = await this.ensureDeviceOwnership(userId, deviceId);

    await this.validateModePayload(dto);

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
   * 校验 mode 与 textbookId / unitId / conversationModeKey 的组合规则：
   * - free_chat：禁止 textbookId/unitId，必须提供 free_chat 分类的启用子模式
   * - textbook_learning：必须提供 textbookId，unitId 可选
   * - locked_unit：必须提供 textbookId + unitId
   * - free_textbook：必须提供 textbookId，禁止 unitId
   * - textbook 类 mode 的 conversationModeKey 可选，但须属于 textbook_learning 分类
   */
  private async validateModePayload(dto: {
    mode: string;
    textbookId?: string;
    unitId?: string;
    conversationModeKey?: string;
  }): Promise<void> {
    const { mode, textbookId, unitId, conversationModeKey } = dto;

    if (!DEVICE_MODES.includes(mode as DeviceMode)) {
      throw new BadRequestException(`Invalid mode: ${mode}`);
    }

    if (mode === "free_chat") {
      if (textbookId || unitId) {
        throw new BadRequestException(
          "free_chat mode does not accept textbookId/unitId",
        );
      }
      if (!conversationModeKey) {
        throw new BadRequestException(
          "free_chat mode requires conversationModeKey",
        );
      }
    } else {
      if (!textbookId) {
        throw new BadRequestException(`${mode} mode requires textbookId`);
      }
      if (mode === "locked_unit" && !unitId) {
        throw new BadRequestException("locked_unit mode requires unitId");
      }
      if (mode === "free_textbook" && unitId) {
        throw new BadRequestException(
          "free_textbook mode does not accept unitId",
        );
      }
    }

    if (textbookId) {
      const textbook = await this.prisma.textbook.findUnique({
        where: { textbookId },
        select: { id: true },
      });

      if (!textbook) {
        throw new NotFoundException(`Textbook not found: ${textbookId}`);
      }

      if (unitId) {
        const unit = await this.prisma.unit.findUnique({
          where: {
            textbookId_unitId: {
              textbookId: textbook.id,
              unitId,
            },
          },
        });

        if (!unit) {
          throw new NotFoundException(
            `Unit not found: textbookId=${textbookId}, unitId=${unitId}`,
          );
        }
      }
    }

    if (conversationModeKey) {
      const expectedCategory =
        mode === "free_chat" ? "free_chat" : "textbook_learning";
      const conversationMode = await this.prisma.conversationMode.findFirst({
        where: { key: conversationModeKey, isActive: true },
        include: { category: true },
      });

      if (!conversationMode) {
        throw new BadRequestException(
          `Unknown or inactive conversationModeKey: ${conversationModeKey}`,
        );
      }

      if (conversationMode.category.key !== expectedCategory) {
        throw new BadRequestException(
          `conversationModeKey ${conversationModeKey} does not belong to category ${expectedCategory}`,
        );
      }
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
