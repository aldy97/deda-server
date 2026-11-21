import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import type { SpeechRateItemDto } from "./dto/speech-rate-admin.dto";

/** 语速档位 → spd 倍数映射的行视图（dashboard 直接渲染） */
export interface SpeechRateRow {
  tier: string;
  spd: number;
}

/**
 * 语速档位 → 倍数映射的管理端读写（全局平台配置，替代原 env SPEECH_RATE_MAP_JSON）。
 *
 * 读路径在 baidu-agent 的 VoiceReconcileService.resolveSpd 里每轮 getvalue 实时查库；
 * 这里只负责管理端的 list / upsert，改后无需重启、下一轮 getvalue 即生效。
 */
@Injectable()
export class SpeechRateAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<SpeechRateRow[]> {
    const rows = await this.prisma.speechRateConfig.findMany({
      orderBy: { tier: "asc" },
    });
    return rows.map(({ tier, spd }) => ({ tier, spd }));
  }

  async upsert(items: SpeechRateItemDto[]): Promise<SpeechRateRow[]> {
    await this.prisma.$transaction(
      items.map(({ tier, spd }) =>
        this.prisma.speechRateConfig.upsert({
          where: { tier },
          update: { spd },
          create: { tier, spd },
        }),
      ),
    );
    return this.list();
  }
}
