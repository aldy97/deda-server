import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from "class-validator";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { FeedbackAnalyticsService } from "./feedback-analytics.service";

const DATE_MESSAGE = "日期格式必须为 YYYY-MM-DD";

/** 空串 query（startDate=）视为未提供；布尔字符串转 boolean */
function emptyToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

function queryBoolean({ value }: { value: unknown }): unknown {
  const normalized = emptyToUndefined(value);
  if (normalized === undefined) return undefined;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return normalized;
}

export class ParentReportFeedbacksQueryDto {
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  startDate?: string;

  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  endDate?: string;

  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  isUseful?: boolean;

  /** 业务设备 ID（Device.deviceId），非内部 UUID；查不到设备返回空页 */
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  deviceId?: string;

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

export class UserFeedbacksQueryDto {
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  startDate?: string;

  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  endDate?: string;

  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  hasContact?: boolean;

  /** 业务设备 ID：经绑定关系反查该设备全部绑定账号的反馈 */
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @IsString()
  deviceId?: string;

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

@ApiTags("analytics-feedback")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/feedback")
export class FeedbackAnalyticsController {
  constructor(private readonly feedbackAnalytics: FeedbackAnalyticsService) {}

  @Get("parent-reports")
  @ApiOperation({
    summary:
      "家长报告有用性反馈（日期区间按 reportDate；summary 为区间内整体有用率，不受 isUseful 过滤影响；deviceId 为业务设备 ID，单设备过滤；items 携带对应日报内容 report）",
  })
  listParentReportFeedbacks(@Query() query: ParentReportFeedbacksQueryDto) {
    return this.feedbackAnalytics.listParentReportFeedbacks(query);
  }

  @Get("user-feedbacks")
  @ApiOperation({
    summary:
      "用户反馈列表（日期区间按 createdAt；hasContact=true 仅看留联系方式；用户已注销时 user 为 null；deviceId 为业务设备 ID，经绑定关系反查该设备全部绑定账号）",
  })
  listUserFeedbacks(@Query() query: UserFeedbacksQueryDto) {
    return this.feedbackAnalytics.listUserFeedbacks(query);
  }
}
