import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Request } from "express";
import { DeviceConfigsService } from "./device-configs.service";
import { SwitchModeDto } from "./dto/switch-mode.dto";
import { ApplyDeviceConfigDto } from "./dto/apply-device-config.dto";
import { JwtAuthGuard } from "@/modules/users/guards/jwt-auth.guard";

interface RequestWithUser extends Request {
  user: { userId: string; openid: string };
}

@ApiTags("设备配置")
@Controller("device-configs")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DeviceConfigsController {
  constructor(private readonly deviceConfigsService: DeviceConfigsService) {}

  @Get(":deviceId/current")
  @ApiOperation({ summary: "获取设备当前生效配置" })
  async current(
    @Param("deviceId") deviceId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.deviceConfigsService.current(req.user.userId, deviceId);
  }

  @Post(":deviceId/apply")
  @ApiOperation({ summary: "应用教材/单元配置" })
  async apply(
    @Param("deviceId") deviceId: string,
    @Body() dto: ApplyDeviceConfigDto,
    @Req() req: RequestWithUser,
  ) {
    return this.deviceConfigsService.apply(req.user.userId, deviceId, dto);
  }

  @Post(":deviceId/mode")
  @ApiOperation({ summary: "切换对话模式/子模式" })
  async switchMode(
    @Param("deviceId") deviceId: string,
    @Body() dto: SwitchModeDto,
    @Req() req: RequestWithUser,
  ) {
    return this.deviceConfigsService.switchMode(
      req.user.userId,
      deviceId,
      dto,
    );
  }
}
