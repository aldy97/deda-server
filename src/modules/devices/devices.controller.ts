import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { DevicesService } from "./devices.service";
import { BindDeviceDto } from "./dto/bind-device.dto";
import { WifiConfigDto } from "./dto/wifi-config.dto";
import { DeviceControlDto } from "./dto/device-control.dto";

@ApiTags("设备管理")
@Controller("devices")
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @Post("bind")
  @ApiOperation({ summary: "家长 App 绑定设备（扫码或输入码）" })
  async bind(@Body() dto: BindDeviceDto) {
    return this.devicesService.bind(dto);
  }

  @Get()
  async list(@Query() query: any) {
    // TODO: 获取当前用户绑定的设备列表
    return this.devicesService.list(query);
  }

  @Get(":id")
  async detail(@Param("id") id: string) {
    // TODO: 获取单台设备详情
    return this.devicesService.detail(id);
  }

  @Get(":id/status")
  async status(@Param("id") id: string) {
    // TODO: 查询设备在线、电量、充电状态
    return this.devicesService.status(id);
  }

  @Post(":id/control")
  @ApiOperation({ summary: "控制设备：音量、开关机、打断模式、休眠、自动关机" })
  async control(@Param("id") id: string, @Body() dto: DeviceControlDto) {
    // TODO: 转发设备控制指令到厂商
    return this.devicesService.control(id, dto);
  }

  @Post(":id/wifi")
  @ApiOperation({ summary: "下发 WiFi 凭证到设备（家长手机原生扫描后传入）" })
  async wifi(@Param("id") id: string, @Body() dto: WifiConfigDto) {
    return this.devicesService.applyWifi(id, dto);
  }

  @Delete(":id")
  async unbind(@Param("id") id: string) {
    // TODO: 解绑设备
    return this.devicesService.unbind(id);
  }
}
