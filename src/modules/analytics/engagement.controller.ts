import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  AnalyticsDateQueryDto,
  AnalyticsDateRangeQueryDto,
} from "./dto/analytics-query.dto";
import { EngagementService } from "./engagement.service";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";

@ApiTags("analytics-engagement")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/engagement")
export class EngagementController {
  constructor(private readonly engagementService: EngagementService) {}

  @Get("summary")
  @ApiOperation({
    summary: "使用行为汇总（时长为 0.5min/条估算口径，含 P50/P90）",
  })
  getSummary(@Query() query: AnalyticsDateRangeQueryDto) {
    return this.engagementService.getSummary(query);
  }

  @Get("duration-distribution")
  @ApiOperation({
    summary: "日均使用时长分布（date 缺省=昨天，估算口径）",
  })
  getDurationDistribution(@Query() query: AnalyticsDateQueryDto) {
    return this.engagementService.getDurationDistribution(query);
  }

  @Get("hourly-heatmap")
  @ApiOperation({
    summary: "活跃时段热力图（7 行周一到周日 × 24 列，Asia/Shanghai）",
  })
  getHourlyHeatmap(@Query() query: AnalyticsDateRangeQueryDto) {
    return this.engagementService.getHourlyHeatmap(query);
  }

  @Get("mode-usage")
  @ApiOperation({
    summary: "对话模式分布趋势（口径与小程序 learning-stats/mode-usage 一致）",
  })
  getModeUsage(@Query() query: AnalyticsDateRangeQueryDto) {
    return this.engagementService.getModeUsage(query);
  }

  @Get("feature-adoption")
  @ApiOperation({
    summary: "功能渗透率（哄睡/冒险/习惯/英语，近 30 天活跃口径）",
  })
  getFeatureAdoption(@Query() query: AnalyticsDateQueryDto) {
    return this.engagementService.getFeatureAdoption(query);
  }
}
