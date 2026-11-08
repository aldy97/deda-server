import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { MessagesAnalyticsService } from "./messages-analytics.service";

const DATE_MESSAGE = "日期格式必须为 YYYY-MM-DD";

/** 空串 query（startDate=）视为未提供 */
function emptyToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

export class MessagesQueryDto {
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  startDate?: string;

  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  endDate?: string;

  /** 业务设备 ID（Device.deviceId），非内部 UUID */
  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsIn(["user", "assistant"])
  role?: "user" | "assistant";

  @IsOptional()
  @IsIn(["completed", "failed"])
  status?: "completed" | "failed";

  @IsOptional()
  @IsString()
  mode?: string;

  @IsOptional()
  @IsString()
  conversationModeKey?: string;

  @IsOptional()
  @IsString()
  turnId?: string;

  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  keyword?: string;

  /** 排序白名单：只允许 spokeAt（防注入也防非索引列排序） */
  @IsOptional()
  @IsIn(["spokeAt_desc", "spokeAt_asc"])
  sort?: "spokeAt_desc" | "spokeAt_asc";

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

@ApiTags("analytics-messages")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/messages")
export class MessagesAnalyticsController {
  constructor(private readonly messages: MessagesAnalyticsService) {}

  @Get()
  @ApiOperation({
    summary:
      "消息明细列表（spokeAt 区间按 Asia/Shanghai 当日边界；deviceId 为业务设备 ID；不含 rawPayload）",
  })
  listMessages(@Query() query: MessagesQueryDto) {
    return this.messages.listMessages(query);
  }

  @Get(":id")
  @ApiOperation({
    summary: "消息详情（整行，含 rawPayload 原样返回；id 不存在返回 404）",
  })
  getMessage(@Param("id") id: string) {
    return this.messages.getMessage(id);
  }
}
