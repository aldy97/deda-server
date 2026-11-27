import {
  Controller,
  Get,
  NotFoundException,
  Param,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { ParentsAnalyticsService } from "./parents-analytics.service";

/**
 * 家长视角单独挂一个 controller：路由前缀 analytics/parents 与
 * analytics/users 不重叠，避免与 summary/demographics 抢路由匹配顺序。
 */
@ApiTags("analytics-users")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/parents")
export class ParentsAnalyticsController {
  constructor(private readonly parentsService: ParentsAnalyticsService) {}

  @Get(":userId")
  @ApiOperation({
    summary:
      "家长视角详情（按 userId 精确取单条；下发昵称/手机号，不含 openid）",
  })
  async getParent(@Param("userId") userId: string) {
    const detail = await this.parentsService.getParentDetail(userId);
    if (!detail) {
      throw new NotFoundException("parent not found");
    }
    return detail;
  }
}
