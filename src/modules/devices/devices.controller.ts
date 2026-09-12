import { Controller, Get, Post, Delete, Param, Body, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DevicesService } from './devices.service';

@ApiTags('设备管理')
@Controller('devices')
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @Get()
  async list(@Query() query: any) {
    // TODO: 获取当前用户绑定的设备列表
    return this.devicesService.list(query);
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    // TODO: 获取单台设备详情
    return this.devicesService.detail(id);
  }

  @Get(':id/status')
  async status(@Param('id') id: string) {
    // TODO: 查询设备在线、电量、充电状态
    return this.devicesService.status(id);
  }

  @Post(':id/control')
  async control(@Param('id') id: string, @Body() dto: any) {
    // TODO: 转发设备控制指令到厂商
    return this.devicesService.control(id, dto);
  }

  @Delete(':id')
  async unbind(@Param('id') id: string) {
    // TODO: 解绑设备
    return this.devicesService.unbind(id);
  }
}
