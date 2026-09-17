import { Controller, Get, Post, Param, Body } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { DeviceConfigsService } from "./device-configs.service";
import { SwitchModeDto } from "./dto/switch-mode.dto";

@ApiTags("设备配置")
@Controller("device-configs")
export class DeviceConfigsController {
  constructor(private readonly deviceConfigsService: DeviceConfigsService) {}

  @Get(":deviceId/current")
  async current(@Param("deviceId") deviceId: string) {
    // TODO: 获取设备当前生效配置
    return this.deviceConfigsService.current(deviceId);
  }

  @Post(":deviceId/apply")
  async apply(@Param("deviceId") deviceId: string, @Body() dto: any) {
    // TODO: 提交教材/单元配置并下发厂商
    return this.deviceConfigsService.apply(deviceId, dto);
  }

  @Post(":deviceId/mode")
  @ApiOperation({
    summary: "切换对话模式/语言/语速，并同步机芯厂 ASR/TTS 参数",
  })
  async switchMode(
    @Param("deviceId") deviceId: string,
    @Body() dto: SwitchModeDto,
  ) {
    // TODO: 保存配置快照，调用厂商配置同步接口，必要时通过 WebSocket 通知设备发声
    return this.deviceConfigsService.switchMode(deviceId, dto);
  }
}
