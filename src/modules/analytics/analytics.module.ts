import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { AnalyticsAuthController } from "./analytics-auth.controller";
import {
  ANALYTICS_JWT_SERVICE,
  AnalyticsAuthService,
} from "./analytics-auth.service";
import { AnalyticsJwtStrategy } from "./strategies/analytics-jwt.strategy";
import { OverviewController } from "./overview.controller";
import { OverviewService } from "./overview.service";
import { RetentionController } from "./retention.controller";
import { RetentionService } from "./retention.service";
import { EngagementController } from "./engagement.controller";
import { EngagementService } from "./engagement.service";
import { UsersAnalyticsController } from "./users-analytics.controller";
import { UsersAnalyticsService } from "./users-analytics.service";
import {
  ContentController,
  QualityController,
} from "./content-quality.controller";
import { ContentService } from "./content.service";
import { QualityService } from "./quality.service";
import { FeedbackAnalyticsController } from "./feedback-analytics.controller";
import { FeedbackAnalyticsService } from "./feedback-analytics.service";
import { MessagesAnalyticsController } from "./messages-analytics.controller";
import { MessagesAnalyticsService } from "./messages-analytics.service";
import { MemoriesAnalyticsController } from "./memories-analytics.controller";
import { MemoriesAnalyticsService } from "./memories-analytics.service";
import { LlmAnalyticsController } from "./llm-analytics.controller";
import { LlmAnalyticsService } from "./llm-analytics.service";
import { AliyunBillClient } from "./aliyun-bill.client";
import { BillingSyncService } from "./billing-sync.service";
import { LlmCostService } from "./llm-cost.service";
import { ParentReportsAnalyticsController } from "./parent-reports-analytics.controller";
import { ParentReportsAnalyticsService } from "./parent-reports-analytics.service";
import { DevicesAdminController } from "./devices-admin.controller";
import { TurnDecisionAnalyticsController } from "./turn-decision-analytics.controller";
import { TurnDecisionAnalyticsService } from "./turn-decision-analytics.service";
import { DeviceLinkModule } from "../device-link/device-link.module";

@Module({
  imports: [PassportModule, DeviceLinkModule],
  controllers: [
    AnalyticsAuthController,
    DevicesAdminController,
    OverviewController,
    RetentionController,
    EngagementController,
    UsersAnalyticsController,
    ContentController,
    QualityController,
    FeedbackAnalyticsController,
    MessagesAnalyticsController,
    MemoriesAnalyticsController,
    LlmAnalyticsController,
    ParentReportsAnalyticsController,
    TurnDecisionAnalyticsController,
  ],
  providers: [
    {
      provide: ANALYTICS_JWT_SERVICE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        new JwtService({
          secret:
            configService.get<string>("ANALYTICS_JWT_SECRET") ||
            "dev-analytics-jwt-secret",
          signOptions: {
            expiresIn:
              configService.get<string>("ANALYTICS_JWT_EXPIRES_IN") || "12h",
          },
        }),
    },
    AnalyticsAuthService,
    AnalyticsJwtStrategy,
    OverviewService,
    RetentionService,
    EngagementService,
    UsersAnalyticsService,
    ContentService,
    QualityService,
    FeedbackAnalyticsService,
    MessagesAnalyticsService,
    MemoriesAnalyticsService,
    LlmAnalyticsService,
    AliyunBillClient,
    BillingSyncService,
    LlmCostService,
    ParentReportsAnalyticsService,
    TurnDecisionAnalyticsService,
  ],
})
export class AnalyticsModule {}
