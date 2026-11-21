import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_NORMAL_SPD,
  DEFAULT_SLEEP_SPD,
  VOICE_SPEED_CONFIG_ID,
} from "@/modules/baidu-agent/baidu-agent.types";
import type { UpdateVoiceSpeedDto } from "./dto/voice-speed-admin.dto";

/** 全局语速配置的读写视图（dashboard 直接渲染） */
export interface VoiceSpeedConfigView {
  normalSpd: number;
  sleepSpd: number;
}

/**
 * 全局语速配置（非哄睡 normalSpd + 哄睡 sleepSpd）的管理端读写。
 *
 * 读路径在 baidu-agent 的 VoiceReconcileService（resolveNormalSpd / resolveSleepSpd）
 * 每轮 getvalue 实时查库；这里只负责管理端 get / update，改后无需重启、下一轮生效。
 */
@Injectable()
export class VoiceSpeedAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<VoiceSpeedConfigView> {
    const row = await this.prisma.voiceSpeedConfig.findUnique({
      where: { id: VOICE_SPEED_CONFIG_ID },
    });
    return {
      normalSpd: row?.normalSpd ?? DEFAULT_NORMAL_SPD,
      sleepSpd: row?.sleepSpd ?? DEFAULT_SLEEP_SPD,
    };
  }

  async update(dto: UpdateVoiceSpeedDto): Promise<VoiceSpeedConfigView> {
    await this.prisma.voiceSpeedConfig.upsert({
      where: { id: VOICE_SPEED_CONFIG_ID },
      update: { normalSpd: dto.normalSpd, sleepSpd: dto.sleepSpd },
      create: {
        id: VOICE_SPEED_CONFIG_ID,
        normalSpd: dto.normalSpd,
        sleepSpd: dto.sleepSpd,
      },
    });
    return this.get();
  }
}
