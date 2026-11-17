import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Request } from "express";
import { LearningStatsService } from "./learning-stats.service";
import { JwtAuthGuard } from "@/modules/users/guards/jwt-auth.guard";
import {
  ModeUsageQueryDto,
  ParentReportFeedbackDto,
  ParentReportQueryDto,
} from "./dto/learning-stats.dto";

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
    @Query()
    query: {
      deviceId?: string;
      range?: "today" | "week" | "month";
      mode?: string;
    },
  ) {
    return this.learningStatsService.getDashboard(
      req.user.userId,
      query.deviceId,
      query.range,
      {
        mode: query.mode,
      },
    );
  }

  @Get("daily")
  async daily(
    @Req() req: RequestWithUser,
    @Query()
    query: {
      deviceId?: string;
      days?: string;
      mode?: string;
      scope?: "all";
    },
  ) {
    return this.learningStatsService.getDailyTrend(
      req.user.userId,
      query.deviceId,
      Number(query.days) || 7,
      {
        mode: query.mode,
        ...(query.scope === "all" ? { scope: "all" as const } : {}),
      },
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

  @Get("activities")
  async activities(
    @Req() req: RequestWithUser,
    @Query()
    query: {
      deviceId?: string;
      page?: string;
      pageSize?: string;
      range?: "today" | "week" | "month";
      mode?: string;
    },
  ) {
    return this.learningStatsService.getActivities(
      req.user.userId,
      query.deviceId,
      {
        page: Number(query.page) || 1,
        pageSize: Number(query.pageSize) || 10,
        range: query.range,
        mode: query.mode,
      },
    );
  }

  @Get("insights")
  async insights(
    @Req() req: RequestWithUser,
    @Query()
    query: {
      deviceId?: string;
      range?: "today" | "week" | "month";
    },
  ) {
    return this.learningStatsService.getInsights(
      req.user.userId,
      query.deviceId,
      query.range,
    );
  }

  @Get("health")
  async health(
    @Req() req: RequestWithUser,
    @Query()
    query: {
      deviceId?: string;
      range?: "today" | "week" | "month";
    },
  ) {
    return this.learningStatsService.getHealth(
      req.user.userId,
      query.deviceId,
      query.range,
    );
  }

  @Get("mode-usage")
  async modeUsage(
    @Req() req: RequestWithUser,
    @Query() query: ModeUsageQueryDto,
  ) {
    return this.learningStatsService.getModeUsage(
      req.user.userId,
      query.deviceId,
      query.days ? Number(query.days) : 7,
      query.endDate,
    );
  }

  @Get("parent-report")
  async parentReport(
    @Req() req: RequestWithUser,
    @Query() query: ParentReportQueryDto,
  ) {
    return this.learningStatsService.getParentReport(
      req.user.userId,
      query.deviceId,
      query.date,
    );
  }

  @Post("parent-report/feedback")
  @HttpCode(200)
  async parentReportFeedback(
    @Req() req: RequestWithUser,
    @Body() body: ParentReportFeedbackDto,
  ) {
    return this.learningStatsService.submitParentReportFeedback(
      req.user.userId,
      body.deviceId,
      body.reportDate,
      body.useful,
    );
  }
}
