import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  CHARACTER_TIMBRE_PORT,
  type CharacterTimbrePort,
} from "@/modules/baidu-agent/baidu-agent.types";
import { PromptRegistryService } from "@/modules/prompt-registry/prompt-registry.service";
import type {
  CreateVoiceTimbreDto,
  UpdateVoiceTimbreDto,
} from "./dto/voice-timbre-admin.dto";

export interface VoiceTimbreView {
  characterKey: string;
  timbreId: string;
  updatedAt: string;
  /** 是否有对应人设 prompt；false 时对话会回落 elly，界面必须提示 */
  personaConfigured: boolean;
  /** 当前有多少台设备的 characterKey 指向该角色 */
  devicesInUse: number;
}

export interface VoiceTimbreRecordView {
  characterKey: string;
  timbreId: string;
  updatedAt: string;
}

const prismaCode = (error: unknown): string | undefined =>
  (error as { code?: string } | null)?.code;

/**
 * 角色音色映射的管理端读写。
 *
 * 读路径（getvalue）走 CharacterTimbreService 的内存缓存；这里每次操作后
 * invalidate，下一轮 getvalue 即生效。写操作记日志（无 PII），供回溯。
 */
@Injectable()
export class VoiceTimbreAdminService {
  private readonly logger = new Logger(VoiceTimbreAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CHARACTER_TIMBRE_PORT)
    private readonly cache: CharacterTimbrePort,
    private readonly promptRegistry: PromptRegistryService,
  ) {}

  async list(): Promise<VoiceTimbreView[]> {
    // 人设状态以运行时注册表为准：内置角色恒已配置，动态角色以「已发布」为准
    await this.promptRegistry.reload();
    const [rows, counts] = await Promise.all([
      this.prisma.characterTimbre.findMany({
        orderBy: { characterKey: "asc" },
      }),
      this.prisma.device.groupBy({
        by: ["characterKey"],
        _count: { _all: true },
      }),
    ]);
    const usage = new Map(
      counts.map((item) => [item.characterKey, item._count._all]),
    );

    return rows.map((row) => ({
      characterKey: row.characterKey,
      timbreId: row.timbreId,
      updatedAt: row.updatedAt.toISOString(),
      personaConfigured: this.promptRegistry.hasPersona(row.characterKey),
      devicesInUse: usage.get(row.characterKey) ?? 0,
    }));
  }

  async create(dto: CreateVoiceTimbreDto): Promise<VoiceTimbreRecordView> {
    try {
      const row = await this.prisma.characterTimbre.create({
        data: { characterKey: dto.characterKey, timbreId: dto.timbreId },
      });
      this.afterWrite("create", row.characterKey, null, row.timbreId);
      return toRecordView(row);
    } catch (error) {
      if (prismaCode(error) === "P2002") {
        throw new ConflictException(
          `characterKey ${dto.characterKey} already exists`,
        );
      }
      throw error;
    }
  }

  async update(
    characterKey: string,
    dto: UpdateVoiceTimbreDto,
  ): Promise<VoiceTimbreRecordView> {
    const existing = await this.prisma.characterTimbre.findUnique({
      where: { characterKey },
    });
    if (!existing) {
      throw new NotFoundException(`characterKey ${characterKey} not found`);
    }

    try {
      const row = await this.prisma.characterTimbre.update({
        where: { characterKey },
        data: { timbreId: dto.timbreId },
      });
      this.afterWrite(
        "update",
        row.characterKey,
        existing.timbreId,
        row.timbreId,
      );
      return toRecordView(row);
    } catch (error) {
      if (prismaCode(error) === "P2025") {
        throw new NotFoundException(`characterKey ${characterKey} not found`);
      }
      throw error;
    }
  }

  async remove(characterKey: string, force: boolean): Promise<void> {
    const devicesInUse = await this.prisma.device.count({
      where: { characterKey },
    });
    if (devicesInUse > 0 && !force) {
      throw new ConflictException(
        `角色 ${characterKey} 仍有 ${devicesInUse} 台设备在用，删除后这些设备将无法对话；确认请带 force=true 重试`,
      );
    }

    let deleted: { timbreId: string };
    try {
      deleted = await this.prisma.characterTimbre.delete({
        where: { characterKey },
      });
    } catch (error) {
      if (prismaCode(error) === "P2025") {
        throw new NotFoundException(`characterKey ${characterKey} not found`);
      }
      throw error;
    }

    this.afterWrite("delete", characterKey, deleted.timbreId, null);
  }

  private afterWrite(
    action: "create" | "update" | "delete",
    characterKey: string,
    before: string | null,
    after: string | null,
  ): void {
    this.cache.invalidate();
    this.logger.log(
      `voice timbre ${action}: characterKey=${characterKey}, before=${before ?? "-"}, after=${after ?? "-"}`,
    );
  }
}

function toRecordView(row: {
  characterKey: string;
  timbreId: string;
  updatedAt: Date;
}): VoiceTimbreRecordView {
  return {
    characterKey: row.characterKey,
    timbreId: row.timbreId,
    updatedAt: row.updatedAt.toISOString(),
  };
}
