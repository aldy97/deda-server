import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  AnalyticsCohortsQueryDto,
  AnalyticsCurveQueryDto,
  AnalyticsDateRangeQueryDto,
} from "./dto/analytics-query.dto";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { RetentionService } from "./retention.service";

@ApiTags("analytics-retention")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics")
export class RetentionController {
  constructor(private readonly retentionService: RetentionService) {}

  @Get("retention/cohorts")
  @ApiOperation({
    summary:
      "留存 cohort 热力表（basis=activation 首次绑定 / firstUse 首次对话）",
  })
  getCohorts(@Query() query: AnalyticsCohortsQueryDto) {
    return this.retentionService.getCohorts(query);
  }

  @Get("retention/curve")
  @ApiOperation({
    summary: "合并留存曲线（D1/3/7/14/30/60/90，对标 90 天留存口径）",
  })
  getCurve(@Query() query: AnalyticsCurveQueryDto) {
    return this.retentionService.getCurve(query);
  }

  @Get("activation/funnel")
  @ApiOperation({
    summary: "激活漏斗（无出货数据时 shipped=null，前端空态）",
  })
  getActivationFunnel(@Query() query: AnalyticsDateRangeQueryDto) {
    return this.retentionService.getActivationFunnel(query);
  }
}
