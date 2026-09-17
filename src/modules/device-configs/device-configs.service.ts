import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { SwitchModeDto } from "./dto/switch-mode.dto";

@Injectable()
export class DeviceConfigsService {
  constructor(private readonly prisma: PrismaService) {}

  async current(deviceId: string) {
    // TODO: 查询设备当前配置快照
    return null;
  }

  async apply(deviceId: string, dto: any) {
    // TODO: 校验教材单元合法性，调用厂商切换对话模式接口，保存配置快照
    return null;
  }

  async switchMode(deviceId: string, dto: SwitchModeDto) {
    // TODO: 保存模式/语言/语速，调用厂商配置同步，必要时通知设备播放切换提示音
    return {
      success: true,
      deviceId,
      mode: dto.mode,
      textbookId: dto.textbookId || null,
      unitId: dto.unitId || null,
      language: dto.language || "bilingual",
      speechRate: dto.speechRate || "normal",
    };
  }
}
