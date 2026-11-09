import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import { LLM_SCENES } from "../llm/llm.service";
import { AnalyticsDateRangeQueryDto } from "./dto/analytics-query.dto";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { LlmAnalyticsService } from "./llm-analytics.service";

/** 空串 query（scene=）视为未提供 */
function emptyToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

export class LlmTrendQueryDto extends AnalyticsDateRangeQueryDto {
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsIn(["day", "week", "month"])
  granularity?: "day" | "week" | "month";

  /** 缺省 = 全部场景聚合；非法值 400 */
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsIn(LLM_SCENES)
  scene?: string;
}

export class LlmRecentFailuresQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;

  /** 缺省 = 全部场景；非法值 400 */
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsIn(LLM_SCENES)
  scene?: string;
}

@ApiTags("analytics-llm")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/llm")
export class LlmAnalyticsController {
  constructor(private readonly llmAnalytics: LlmAnalyticsService) {}

  @Get("summary")
  @ApiOperation({
    summary:
      "LLM 分场景汇总（成功率/延迟与首包分位数/token/失败原因分布；分母 0 时比率为 null）",
  })
  getSummary(@Query() query: AnalyticsDateRangeQueryDto) {
    return this.llmAnalytics.getSummary(query);
  }

  @Get("trend")
  @ApiOperation({
    summary:
      "LLM 调用趋势（day/week/month；scene 可选，非法 400；无数据日期补零）",
  })
  getTrend(@Query() query: LlmTrendQueryDto) {
    return this.llmAnalytics.getTrend(query);
  }

  @Get("recent-failures")
  @ApiOperation({
    summary: "LLM 最近失败明细（createdAt 倒序；pageSize ≤ 100）",
  })
  getRecentFailures(@Query() query: LlmRecentFailuresQueryDto) {
    return this.llmAnalytics.getRecentFailures(query);
  }
}
