import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Request } from "express";
import { SleepConfigsService } from "./sleep-configs.service";
import { UpdateSleepConfigDto } from "./dto/update-sleep-config.dto";
import { JwtAuthGuard } from "@/modules/users/guards/jwt-auth.guard";

interface RequestWithUser extends Request {
  user: { userId: string; openid: string };
}

@ApiTags("哄睡配置")
@Controller("sleep-configs")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SleepConfigsController {
  constructor(private readonly sleepConfigsService: SleepConfigsService) {}

  @Get("device/:deviceId")
  @ApiOperation({ summary: "读取设备哄睡配置，未设置返回 data: null" })
  async getByDevice(
    @Param("deviceId") deviceId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.sleepConfigsService.getByDevice(req.user.userId, deviceId);
  }

  @Patch("device/:deviceId")
  @ApiOperation({ summary: "部分更新设备哄睡配置，返回更新后的完整配置" })
  async updateByDevice(
    @Param("deviceId") deviceId: string,
    @Body() dto: UpdateSleepConfigDto,
    @Req() req: RequestWithUser,
  ) {
    return this.sleepConfigsService.upsertByDevice(
      req.user.userId,
      deviceId,
      dto,
    );
  }
}
