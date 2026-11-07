import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsOptional, Matches } from "class-validator";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { UsersAnalyticsService } from "./users-analytics.service";

class UsersSummaryQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "日期格式必须为 YYYY-MM-DD" })
  startDate?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "日期格式必须为 YYYY-MM-DD" })
  endDate?: string;
}

@ApiTags("analytics-users")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/users")
export class UsersAnalyticsController {
  constructor(private readonly usersService: UsersAnalyticsService) {}

  @Get("summary")
  @ApiOperation({
    summary: "用户汇总（startDate/endDate 同时提供时返回区间新增用户）",
  })
  getSummary(@Query() query: UsersSummaryQueryDto) {
    return this.usersService.getSummary(query);
  }

  @Get("demographics")
  @ApiOperation({
    summary: "用户画像（年龄分布只出年龄段，不出姓名生日等 PII）",
  })
  getDemographics() {
    return this.usersService.getDemographics();
  }
}
