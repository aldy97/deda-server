import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Request } from "express";
import { LearningStatsService } from "./learning-stats.service";
import { JwtAuthGuard } from "@/modules/users/guards/jwt-auth.guard";

interface RequestWithUser extends Request {
  user: { userId: string; openid: string };
}

@ApiTags("学习统计")
@Controller("learning-stats")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class LearningStatsController {
  constructor(private readonly learningStatsService: LearningStatsService) {}

  @Get("dashboard")
  async dashboard(
    @Req() req: RequestWithUser,
    @Query("deviceId") deviceId?: string,
  ) {
    return this.learningStatsService.getDashboard(req.user.userId, deviceId);
  }

  @Get("daily")
  async daily(
    @Req() req: RequestWithUser,
    @Query() query: { deviceId?: string; days?: string },
  ) {
    return this.learningStatsService.getDailyTrend(
      req.user.userId,
      query.deviceId,
      Number(query.days) || 7,
    );
  }

  @Get("topics")
  async topics(
    @Req() req: RequestWithUser,
    @Query("deviceId") deviceId?: string,
  ) {
    return this.learningStatsService.getTopicBreakdown(
      req.user.userId,
      deviceId,
    );
  }

  @Get("timeline")
  async timeline(
    @Req() req: RequestWithUser,
    @Query() query: { deviceId?: string; page?: string; pageSize?: string },
  ) {
    return this.learningStatsService.getTimeline(
      req.user.userId,
      query.deviceId,
      Number(query.page) || 1,
      Number(query.pageSize) || 10,
    );
  }

  @Get("unit-progress/:deviceId")
  async unitProgress(
    @Param("deviceId") deviceId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.learningStatsService.getUnitProgress(req.user.userId, deviceId);
  }
}
