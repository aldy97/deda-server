import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
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

export class LlmByTurnQueryDto {
  /** 对话轮次 ID（messages.turn_id） */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  turnId!: string;
}

export class LlmTurnHandoffQueryDto extends AnalyticsDateRangeQueryDto {
  /** 空窗判定阈值 ms：chat_main 首包晚于 filler 完成超过该值记空窗；缺省 0 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60_000)
  gapThresholdMs?: number;
}

export class LlmSlowCallsQueryDto extends AnalyticsDateRangeQueryDto {
  /** 缺省 = 全部场景；非法值 400 */
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsIn(LLM_SCENES)
  scene?: string;

  /** 缺省 20，上限 50 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
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

  @Get("by-turn")
  @ApiOperation({
    summary:
      "单轮 LLM 调用链路（按 turnId 查同轮全部调用，createdAt 升序；无记录返回空数组）",
  })
  getByTurn(@Query() query: LlmByTurnQueryDto) {
    return this.llmAnalytics.getByTurn(query.turnId);
  }

  @Get("turn-handoff")
  @ApiOperation({
    summary:
      "轮次衔接健康度（防死空气，生成侧口径）：按 turnId join filler 与 chat_main，输出 gap 分位数/空窗率/Top 空窗轮次",
  })
  getTurnHandoff(@Query() query: LlmTurnHandoffQueryDto) {
    return this.llmAnalytics.getTurnHandoff(query);
  }

  @Get("slow-calls")
  @ApiOperation({
    summary:
      "慢调用长尾明细（仅成功调用，latencyMs 倒序；limit ≤ 50，缺省 20）",
  })
  getSlowCalls(@Query() query: LlmSlowCallsQueryDto) {
    return this.llmAnalytics.getSlowCalls(query);
  }
}
