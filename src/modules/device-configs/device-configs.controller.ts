import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DeviceConfigsService } from './device-configs.service';

@ApiTags('设备配置')
@Controller('device-configs')
export class DeviceConfigsController {
  constructor(private readonly deviceConfigsService: DeviceConfigsService) {}

  @Get(':deviceId/current')
  async current(@Param('deviceId') deviceId: string) {
    // TODO: 获取设备当前生效配置
    return this.deviceConfigsService.current(deviceId);
  }

  @Post(':deviceId/apply')
  async apply(@Param('deviceId') deviceId: string, @Body() dto: any) {
    // TODO: 提交教材/单元配置并下发厂商
    return this.deviceConfigsService.apply(deviceId, dto);
  }
}
