import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { FleetService } from "./fleet.service";
import {
  FleetChurnRiskQueryDto,
  FleetDeviceDetailQueryDto,
  FleetDevicesQueryDto,
  FleetPresenceTrendQueryDto,
  FleetSummaryQueryDto,
} from "./dto/fleet-query.dto";

@ApiTags("analytics-fleet")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/fleet")
export class FleetController {
  constructor(private readonly fleetService: FleetService) {}

  @Get("summary")
  @ApiOperation({ summary: "舰队概览（实时 + 天级指标）" })
  getSummary(@Query() query: FleetSummaryQueryDto) {
    return this.fleetService.getSummary(query);
  }

  @Get("presence-trend")
  @ApiOperation({ summary: "设备开机趋势（天级，最多 62 天）" })
  getPresenceTrend(@Query() query: FleetPresenceTrendQueryDto) {
    return this.fleetService.getPresenceTrend(query);
  }

  @Get("firmware-distribution")
  @ApiOperation({ summary: "固件版本分布" })
  getFirmwareDistribution() {
    return this.fleetService.getFirmwareDistribution();
  }

  @Get("churn-risk")
  @ApiOperation({ summary: "流失风险设备列表" })
  getChurnRisk(@Query() query: FleetChurnRiskQueryDto) {
    return this.fleetService.getChurnRisk(query);
  }

  @Get("devices")
  @ApiOperation({ summary: "设备列表（分页 + 搜索）" })
  getDevices(@Query() query: FleetDevicesQueryDto) {
    return this.fleetService.getDevices(query);
  }

  @Get("devices/:deviceId")
  @ApiOperation({ summary: "单台设备详情" })
  @ApiParam({ name: "deviceId", description: "设备业务 ID（小写 MAC）" })
  async getDeviceDetail(
    @Param("deviceId") deviceId: string,
    @Query() query: FleetDeviceDetailQueryDto,
  ) {
    const result = await this.fleetService.getDeviceDetail(deviceId, query);
    if (!result) throw new NotFoundException("Device not found");
    return result;
  }
}
