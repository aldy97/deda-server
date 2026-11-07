import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  AnalyticsDateQueryDto,
  AnalyticsTrendQueryDto,
} from "./dto/analytics-query.dto";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { OverviewService } from "./overview.service";

@ApiTags("analytics-overview")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/overview")
export class OverviewController {
  constructor(private readonly overviewService: OverviewService) {}

  @Get()
  @ApiOperation({
    summary: "总览 KPI（date 缺省=昨天 T-1；时长为 0.5min/条估算口径）",
  })
  getOverview(@Query() query: AnalyticsDateQueryDto) {
    return this.overviewService.getOverview(query);
  }

  @Get("trend")
  @ApiOperation({
    summary: "主趋势图（多指标逗号分隔，无数据日期补零）",
  })
  getTrend(@Query() query: AnalyticsTrendQueryDto) {
    return this.overviewService.getTrend(query);
  }
}
