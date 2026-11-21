import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { VoiceSpeedAdminService } from "./voice-speed-admin.service";
import { UpdateVoiceSpeedDto } from "./dto/voice-speed-admin.dto";

/**
 * 全局语速配置的管理端接口（dashboard）。
 *
 * 路径挂在 analytics/ 前缀下（dashboard 的 vite dev proxy 与生产 nginx 都只转发
 * /analytics）。写后 getvalue 每轮实时查库，无需重启。
 */
@ApiTags("analytics-voice-speed")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/voice-speed")
export class VoiceSpeedAdminController {
  constructor(private readonly voiceSpeed: VoiceSpeedAdminService) {}

  @Get()
  @ApiOperation({ summary: "全局语速配置（非哄睡 + 哄睡）" })
  get() {
    return this.voiceSpeed.get();
  }

  @Patch()
  @ApiOperation({ summary: "更新全局语速配置，改后下一轮 getvalue 生效" })
  update(@Body() dto: UpdateVoiceSpeedDto) {
    return this.voiceSpeed.update(dto);
  }
}
