import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Inject,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SwitchModeDto } from "./dto/switch-mode.dto";
import { ApplyDeviceConfigDto } from "./dto/apply-device-config.dto";
import { DeviceConfigResponseDto } from "./dto/device-config-response.dto";
import { DEVICE_MODES, DeviceMode } from "./device-config.constants";
import {
  VOICE_CATALOG_PORT,
  VOICE_RECONCILE_PORT,
  VoiceCatalogPort,
  VoiceReconcilePort,
  VOICE_PAYLOAD_KEY,
  parseVoicePayload,
} from "@/modules/baidu-agent/baidu-agent.types";
import { UpdateVoiceConfigDto } from "./dto/update-voice-config.dto";
import { VoiceConfigResponseDto } from "./dto/voice-config-response.dto";

/**
 * POST /device-configs/:deviceId/voice 的返回体。
 * 与 GET 返回体不同：多了 applied/reason，少了 catalog/available/canApplyLive。
 */
export interface VoiceApplyResponse {
  deviceId: string;
  vcn: string | null;
  speechRate: string | null;
  spd: number | null;
  applied: string;
  reason: string | null;
}

@Injectable()
export class DeviceConfigsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(VOICE_CATALOG_PORT) private readonly catalog: VoiceCatalogPort,
    @Inject(VOICE_RECONCILE_PORT)
    private readonly reconcile: VoiceReconcilePort,
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

  /**
   * 查询设备当前音色/语速配置及可用目录。
   *
   * 为什么不在 App 层做语种过滤：实例语种来自设备 start 上报的 lang，
   * App 侧拿不到，因此这里返回全量目录，语种过滤在实际下发时由
   * VoiceReconcileService 按实例 lang 执行。
   *
   * 为什么不查 Redis 判断设备是否在对话中：那属于 reconcile 的职责，
   * 且会让 GET 产生副作用依赖；"设备不在对话中"的情况留给 POST 的返回值体现。
   *
   * canApplyLive 只表示"配置齐备（vcn + speechRate + spd 三者都有值）"，
   * 实际是否 live 生效取决于 POST 时设备是否有活跃实例。
   */
  async getVoiceConfig(
    userId: string,
    deviceId: string,
  ): Promise<VoiceConfigResponseDto> {
    const deviceInternalId = await this.ensureDeviceOwnership(userId, deviceId);

    const config = await this.prisma.deviceConfig.findFirst({
      where: {
        device: { deviceId },
        isActive: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const voicePayload = config ? parseVoicePayload(config.payload) : null;
    const vcn = voicePayload?.vcn ?? null;
    const speechRate: string | null = config?.speechRate ?? null;

    const catalog = this.catalog.listUsable();
    const available = this.catalog.available;

    /**
     * canApplyLive / reason 判定——只做只读判定，绝不触发下发。
     */
    let canApplyLive = false;
    let reason: string | null = null;

    const spd = await this.reconcile.resolveActiveSpd(deviceInternalId);

    if (!available) {
      reason = "empty_catalog";
    } else if (vcn === null) {
      // 没有音色期望值，reason 用 null 而不是编造一个
      reason = null;
    } else {
      canApplyLive = true;
    }

    return {
      deviceId,
      vcn,
      speechRate,
      spd,
      catalog: catalog.map(({ timbreId, name, language }) => ({
        timbreId,
        name,
        language,
      })),
      available,
      canApplyLive,
      reason,
    };
  }

  /**
   * 更新设备音色/语速期望值并尝试实时下发。
   *
   * 为什么 vcn 存 payload 而不是新列：复用已有的 payload Json 列避免引入
   * migration，且音色目录本身还是 placeholder，等目录确定后再决定是否规范化。
   *
   * 语种过滤不在此处做：实例语种来自设备 start 上报，App 层不知道，
   * 因此此处只用 catalog.find(vcn) 做存在性校验，不传 lang。
   */
  async updateVoiceConfig(
    userId: string,
    deviceId: string,
    dto: UpdateVoiceConfigDto,
  ): Promise<VoiceApplyResponse> {
    // 校验：至少给一个字段
    if (dto.vcn === undefined && dto.speechRate === undefined) {
      throw new BadRequestException("vcn or speechRate is required");
    }

    const { deviceInternalId, device } =
      await this.ensureDeviceOwnershipWithDevice(userId, deviceId);

    // 读当前生效配置作为基线
    const baseline = await this.prisma.deviceConfig.findFirst({
      where: { deviceId: deviceInternalId, isActive: true },
      orderBy: { createdAt: "desc" },
    });

    const baselineVoice = baseline ? parseVoicePayload(baseline.payload) : null;
    const baselineVcn = baselineVoice?.vcn ?? null;
    const baselineSpeechRate: string = baseline?.speechRate ?? "normal";
    const baselineMode: string = baseline?.mode ?? "free_chat";
    const baselineCefrLevel: string | null = baseline?.cefrLevel ?? null;
    const baselineLanguage: string = baseline?.language ?? "bilingual";
    const baselinePayload: Record<string, unknown> =
      (baseline?.payload as Record<string, unknown>) ?? {};

    // 合并期望值：入参 ?? 基线值
    const newVcn = dto.vcn !== undefined ? dto.vcn : baselineVcn;
    const newSpeechRate =
      dto.speechRate !== undefined ? dto.speechRate : baselineSpeechRate;

    // 校验 vcn 存在且已训练
    if (newVcn !== null) {
      const entry = this.catalog.find(newVcn);
      if (!entry || entry.status !== "TRAINED") {
        throw new BadRequestException("unknown vcn");
      }
    }

    // 构建新 payload：复制基线 payload 的非 voice 键，写入新的 voice 键
    const baselineRest = { ...baselinePayload };
    delete baselineRest[VOICE_PAYLOAD_KEY];
    const newPayload: Prisma.InputJsonValue | null =
      newVcn !== null
        ? ({
            ...baselineRest,
            [VOICE_PAYLOAD_KEY]: {
              vcn: newVcn,
              updatedAt: new Date().toISOString(),
            },
          } as Prisma.InputJsonValue)
        : Object.keys(baselineRest).length > 0
          ? (baselineRest as Prisma.InputJsonValue)
          : null;

    // 落库：失效旧配置 + 创建新配置
    await this.createActiveConfig(deviceInternalId, {
      mode: baselineMode,
      cefrLevel: baselineCefrLevel,
      language: baselineLanguage,
      speechRate: newSpeechRate,
      payload: newPayload,
    });

    // 下发：mac 口径与 devices.service.ts 一致
    const mac = device.macAddress ?? device.deviceId;
    const spd = await this.reconcile.resolveActiveSpd(deviceInternalId);

    let applied: string;
    let reason: string | null;

    try {
      const outcome = await this.reconcile.applyToActiveInstance(
        mac,
        { vcn: newVcn },
        deviceInternalId,
      );
      applied = outcome.applied;
      reason = outcome.reason ?? null;
    } catch {
      // reconcile 异常不抛 500——配置已落库，下一轮对话会追平
      applied = "deferred";
      reason = "internal_error";
    }

    return {
      deviceId,
      vcn: newVcn,
      speechRate: newSpeechRate,
      spd,
      applied,
      reason,
    };
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
    const { deviceInternalId } = await this.ensureDeviceOwnershipWithDevice(
      userId,
      deviceId,
    );
    return deviceInternalId;
  }

  /**
   * 校验设备归属并返回内部 ID 及设备记录。
   * 用于需要 mac 取值的场景（音色下发），mac 口径与 devices.service.ts 一致。
   */
  private async ensureDeviceOwnershipWithDevice(
    userId: string,
    deviceId: string,
  ): Promise<{
    deviceInternalId: string;
    device: { macAddress: string | null; deviceId: string };
  }> {
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

    return {
      deviceInternalId: binding.device.id,
      device: binding.device,
    };
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
      payload?: Prisma.InputJsonValue;
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
        mode: data.mode,
        cefrLevel: data.cefrLevel,
        language: data.language,
        speechRate: data.speechRate,
        isActive: true,
        ...(data.payload !== undefined ? { payload: data.payload } : {}),
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
