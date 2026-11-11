import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { ParentReportsAnalyticsService } from "./parent-reports-analytics.service";

export class ParentReportsQueryDto {
  /** 业务设备 ID（Device.deviceId），非内部 UUID；查不到设备 404 */
  @IsString()
  @IsNotEmpty()
  deviceId!: string;

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

@ApiTags("analytics-parent-reports")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/parent-reports")
export class ParentReportsAnalyticsController {
  constructor(private readonly parentReports: ParentReportsAnalyticsService) {}

  @Get()
  @ApiOperation({
    summary:
      "单设备家长日报列表（按 reportDate 倒序分页；deviceId 为业务设备 ID；含生成状态与四个观察字段+建议；设备不存在 404）",
  })
  listByDevice(@Query() query: ParentReportsQueryDto) {
    return this.parentReports.listByDevice(query);
  }
}
