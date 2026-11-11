import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { ServeStaticModule } from "@nestjs/serve-static";
import { existsSync } from "fs";
import { resolve } from "path";
import appConfig from "./config/app.config";
import databaseConfig from "./config/database.config";
import redisConfig from "./config/redis.config";
import { UsersModule } from "./modules/users/users.module";
import { DevicesModule } from "./modules/devices/devices.module";
import { ChildProfilesModule } from "./modules/child-profiles/child-profiles.module";
import { DeviceConfigsModule } from "./modules/device-configs/device-configs.module";
import { ConversationsModule } from "./modules/conversations/conversations.module";
import { LearningStatsModule } from "./modules/learning-stats/learning-stats.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";
import { ManufacturerModule } from "./modules/manufacturer/manufacturer.module";
import { VendorModule } from "./modules/vendor/vendor.module";
import { HealthModule } from "./modules/health/health.module";
import { MusicModule } from "./modules/music/music.module";
import { LlmModule } from "./modules/llm/llm.module";
import { RedisModule } from "./common/redis/redis.module";
import { PrismaModule } from "./common/prisma/prisma.module";
import { MqttModule } from "./common/mqtt/mqtt.module";
import { DeviceStatusModule } from "./modules/device-status/device-status.module";
import { DeviceLinkModule } from "./modules/device-link/device-link.module";
import { ConversationModesModule } from "./modules/conversation-modes/conversation-modes.module";
import { AdventureModule } from "./modules/adventure/adventure.module";
import { FeedbacksModule } from "./modules/feedbacks/feedbacks.module";
import { SleepConfigsModule } from "./modules/sleep-configs/sleep-configs.module";
import { SleepSchedulerModule } from "./modules/sleep-configs/sleep-scheduler.module";
import { PushNotificationsModule } from "./modules/push-notifications/push-notifications.module";
import { LlmAdapterModule } from "./modules/llm-adapter/llm-adapter.module";
import { ClientApiModule } from "./modules/client-api/client-api.module";
import { AnalyticsModule } from "./modules/analytics/analytics.module";

/**
 * deda-dashboard SPA 静态托管（备案期间 staging 直连 :3001/dashboard 的承载方式；
 * 备案完成后 nginx 在前、本模块作为兜底，两者共用同一份 dist 目录）。
 * dist 由 deda-dashboard 仓库流水线 scp 到 ECS /opt/deda/dashboard/{staging,prod}/，
 * 经 compose 只读挂载进容器；目录不存在时跳过注册，不影响 API 启动。
 */
const dashboardDistPath = resolve(
  process.env.DASHBOARD_DIST_PATH || "/opt/deda/dashboard/staging",
);

const staticImports = existsSync(dashboardDistPath)
  ? [
      ServeStaticModule.forRoot({
        rootPath: dashboardDistPath,
        serveRoot: "/dashboard",
      }),
    ]
  : [];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig],
      envFilePath: [".env"],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL || "info",
        transport:
          process.env.NODE_ENV === "development"
            ? { target: "pino-pretty", options: { singleLine: true } }
            : undefined,
      },
    }),
    PrismaModule,
    RedisModule,
    MqttModule,
    DeviceStatusModule,
    DeviceLinkModule,
    ConversationModesModule,
    UsersModule,
    DevicesModule,
    ChildProfilesModule,
    DeviceConfigsModule,
    ConversationsModule,
    LearningStatsModule,
    WebhooksModule,
    ManufacturerModule,
    VendorModule,
    HealthModule,
    MusicModule,
    LlmModule,
    AdventureModule,
    FeedbacksModule,
    SleepConfigsModule,
    SleepSchedulerModule,
    PushNotificationsModule,
    LlmAdapterModule,
    ClientApiModule,
    AnalyticsModule,
    ...staticImports,
  ],
})
export class AppModule {}
