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

@Module({
  imports: [PassportModule],
  controllers: [
    AnalyticsAuthController,
    OverviewController,
    RetentionController,
    EngagementController,
    UsersAnalyticsController,
    ContentController,
    QualityController,
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
  ],
})
export class AnalyticsModule {}
