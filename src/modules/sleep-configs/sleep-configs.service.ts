import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { UpdateSleepConfigDto } from "./dto/update-sleep-config.dto";

@Injectable()
export class SleepConfigsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 查询指定设备的哄睡配置
   * @returns SleepConfig 或 null（未设置，前端展示默认值）
   */
  async getByDevice(userId: string, deviceId: string) {
    const binding = await this.ensureDeviceOwnership(userId, deviceId);

    return this.prisma.sleepConfig.findUnique({
      where: { deviceId: binding.device.id },
    });
  }

  /**
   * 创建或部分更新指定设备的哄睡配置
   * - 从未设置过时按「默认值 + 本次入参」创建
   * - 生效 durationMode=custom 时 durationMinutes 必填（∈ {10,15,20,25,30}，DTO 已校验取值）
   * - 生效 durationMode=default 时忽略并清空 durationMinutes
   */
  async upsertByDevice(
    userId: string,
    deviceId: string,
    dto: UpdateSleepConfigDto,
  ) {
    const binding = await this.ensureDeviceOwnership(userId, deviceId);
    const internalDeviceId = binding.device.id;

    const existing = await this.prisma.sleepConfig.findUnique({
      where: { deviceId: internalDeviceId },
    });

    const effectiveMode =
      dto.durationMode ?? existing?.durationMode ?? "default";

    let durationMinutes: number | null;
    if (effectiveMode === "default") {
      // default 模式不保留手动时长
      durationMinutes = null;
    } else {
      durationMinutes =
        dto.durationMinutes !== undefined
          ? dto.durationMinutes
          : (existing?.durationMinutes ?? null);
      if (durationMinutes == null) {
        throw new BadRequestException(
          "durationMinutes is required when durationMode is custom",
        );
      }
    }

    const data = {
      enabled: dto.enabled,
      durationMode: dto.durationMode,
      durationMinutes,
      contentType: dto.contentType,
      sleepTime: dto.sleepTime,
      forceSleep: dto.forceSleep,
    };

    return this.prisma.sleepConfig.upsert({
      where: { deviceId: internalDeviceId },
      update: data,
      create: {
        deviceId: internalDeviceId,
        ...data,
      },
    });
  }

  /**
   * 校验当前用户是否拥有该设备
   */
  private async ensureDeviceOwnership(userId: string, deviceId: string) {
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

    return binding;
  }
}
