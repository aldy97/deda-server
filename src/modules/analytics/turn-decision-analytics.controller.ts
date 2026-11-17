import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { AnalyticsDateRangeQueryDto } from "./dto/analytics-query.dto";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { TurnDecisionAnalyticsService } from "./turn-decision-analytics.service";

/** 空串 query（category=）视为未提供 */
function emptyToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

/**
 * safetyCategory 的取值域白名单。
 * 与 child-safety.service 的 SafetyCategory 保持一致；不用 IsString 是为了
 * 让拼错的类别在入口就 400，而不是静默返回空结果被误读成「零拦截」。
 */
const SAFETY_CATEGORIES: string[] = [
  "sexual",
  "self_harm",
  "violence",
  "emotional_harm",
  "safe",
];

export class DecisionTrendQueryDto extends AnalyticsDateRangeQueryDto {
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsIn(["day", "week", "month"])
  granularity?: "day" | "week" | "month";
}

export class ReviewQueueQueryDto extends AnalyticsDateRangeQueryDto {
  /** 缺省 = 全部类别；非法值 400 */
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsIn(SAFETY_CATEGORIES)
  category?: string;

  /** 内部设备 UUID（turn_decision_logs.deviceId），非业务 deviceId */
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  @MaxLength(64)
  deviceId?: string;

  /** 排序白名单：只允许 createdAt（防注入也防非索引列排序） */
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsIn(["createdAt_desc", "createdAt_asc"])
  sort?: "createdAt_desc" | "createdAt_asc";

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
}

/**
 * 判定质量监控接口（安全拦截 + 意图路由）。
 *
 * 与 /analytics/llm 的分工：那边是「模型调用健康度」（成功率、延迟、token、费用），
 * 这边是「模型判定可信度」（拦了多少、放行里有多少其实没审、意图有多少是兜底兜出来的）。
 * 看板 /llm 页的安全与意图两个 tab 消费本组接口。
 */
@ApiTags("analytics-decisions")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/decisions")
export class TurnDecisionAnalyticsController {
  constructor(
    private readonly turnDecisionAnalytics: TurnDecisionAnalyticsService,
  ) {}

  @Get("safety-summary")
  @ApiOperation({
    summary:
      "安全判定概览（拦截率/类别·层级·来源分桶/fail-open·非法标签·未评估计数/可复核条数；分母 0 时比率为 null）",
  })
  getSafetySummary(@Query() query: AnalyticsDateRangeQueryDto) {
    return this.turnDecisionAnalytics.getSafetySummary(query);
  }

  @Get("safety-trend")
  @ApiOperation({
    summary:
      "安全判定趋势（day/week/month；无数据桶补零且比率为 null；静默降级按 source 分桶）",
  })
  getSafetyTrend(@Query() query: DecisionTrendQueryDto) {
    return this.turnDecisionAnalytics.getSafetyTrend(query);
  }

  @Get("intent-summary")
  @ApiOperation({
    summary:
      "意图判定概览（意图分布/决策来源分布/模型调用率/兜底率/intent×source 交叉矩阵；not_routed 与 adventure_takeover 单列）",
  })
  getIntentSummary(@Query() query: AnalyticsDateRangeQueryDto) {
    return this.turnDecisionAnalytics.getIntentSummary(query);
  }

  @Get("intent-trend")
  @ApiOperation({
    summary:
      "意图判定趋势（逐桶给出总数/模型调用数/兜底数/意图分布；无数据桶补零）",
  })
  getIntentTrend(@Query() query: DecisionTrendQueryDto) {
    return this.turnDecisionAnalytics.getIntentTrend(query);
  }

  @Get("review-queue")
  @ApiOperation({
    summary:
      "人工复核队列（恒定只返回留有原文的轮次：拦截 + 非 safe 类别；pageSize ≤ 100；本期只读）",
  })
  getReviewQueue(@Query() query: ReviewQueueQueryDto) {
    return this.turnDecisionAnalytics.getReviewQueue(query);
  }
}
