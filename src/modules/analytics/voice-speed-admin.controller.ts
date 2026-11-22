import { Body, Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SuperAdminGuard } from "./guards/super-admin.guard";
import { VoiceSpeedAdminService } from "./voice-speed-admin.service";
import { VoiceSpeedBroadcastService } from "./voice-speed-broadcast.service";
import {
  ApplyVoiceSpeedDto,
  UpdateVoiceSpeedDto,
} from "./dto/voice-speed-admin.dto";

/**
 * 全局语速配置的管理端接口（dashboard）。
 *
 * 路径挂在 analytics/ 前缀下（dashboard 的 vite dev proxy 与生产 nginx 都只转发
 * /analytics）。写后 getvalue 每轮实时查库，无需重启。
 */
@ApiTags("analytics-voice-speed")
@ApiBearerAuth()
@UseGuards(SuperAdminGuard)
@Controller("analytics/voice-speed")
export class VoiceSpeedAdminController {
  constructor(
    private readonly voiceSpeed: VoiceSpeedAdminService,
    private readonly broadcast: VoiceSpeedBroadcastService,
  ) {}

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

  @Post("apply")
  @ApiOperation({
    summary: "把当前全局语速立即下发到在线实例（不改变下一轮口径）",
  })
  async apply(@Body() dto: ApplyVoiceSpeedDto) {
    const config = await this.voiceSpeed.get();
    return this.broadcast.apply(config, dto ?? {});
  }
}
