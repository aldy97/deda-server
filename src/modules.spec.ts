import "reflect-metadata";

// Root module
import { AppModule } from "./app.module";

// Common modules
import { MqttModule } from "./common/mqtt/mqtt.module";
import { PrismaModule } from "./common/prisma/prisma.module";
import { RedisModule } from "./common/redis/redis.module";
import { WechatModule } from "./common/wechat/wechat.module";

// Business modules
import { AnalyticsModule } from "./modules/analytics/analytics.module";
import { ChildMemoriesModule } from "./modules/child-memories/child-memories.module";
import { ChildProfilesModule } from "./modules/child-profiles/child-profiles.module";
import { ClientApiModule } from "./modules/client-api/client-api.module";
import { ConversationsModule } from "./modules/conversations/conversations.module";
import { DeviceConfigsModule } from "./modules/device-configs/device-configs.module";
import { DeviceLinkModule } from "./modules/device-link/device-link.module";
import { DeviceStatusModule } from "./modules/device-status/device-status.module";
import { DevicesModule } from "./modules/devices/devices.module";
import { HealthModule } from "./modules/health/health.module";
import { LearningStatsModule } from "./modules/learning-stats/learning-stats.module";
import { LlmAdapterModule } from "./modules/llm-adapter/llm-adapter.module";
import { ManufacturerModule } from "./modules/manufacturer/manufacturer.module";
import { MusicModule } from "./modules/music/music.module";
import { PromptRegistryModule } from "./modules/prompt-registry/prompt-registry.module";
import { PushNotificationsModule } from "./modules/push-notifications/push-notifications.module";
import { SleepConfigsModule } from "./modules/sleep-configs/sleep-configs.module";
import { SleepSchedulerModule } from "./modules/sleep-configs/sleep-scheduler.module";
import { TurnDecisionModule } from "./modules/turn-decision/turn-decision.module";
import { UsersModule } from "./modules/users/users.module";
import { VendorModule } from "./modules/vendor/vendor.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";

// DTOs
import { BotGetValueDto } from "./modules/client-api/dto/bot-getvalue.dto";
import { BotStartDto } from "./modules/client-api/dto/bot-start.dto";
import { BotStopDto } from "./modules/client-api/dto/bot-stop.dto";
import { LoginMacDto } from "./modules/client-api/dto/login-mac.dto";
import { DeviceConfigResponseDto } from "./modules/device-configs/dto/device-config-response.dto";
import { VoiceConfigResponseDto } from "./modules/device-configs/dto/voice-config-response.dto";
import { DeviceStatusDto } from "./modules/device-status/dto/device-status.dto";
import { MusicControlDto } from "./modules/music/dto/music-control.dto";
import { NeteaseBindDto } from "./modules/music/dto/netease-bind.dto";
import { ReportPushSubscriptionDto } from "./modules/push-notifications/dto/report-push-subscription.dto";
import { VendorTextOutDto } from "./modules/vendor/dto/vendor-text-out.dto";

describe("module registry（依赖图声明完整）", () => {
  const modules = [
    AppModule,
    MqttModule,
    PrismaModule,
    RedisModule,
    WechatModule,
    AnalyticsModule,
    ChildMemoriesModule,
    ChildProfilesModule,
    ClientApiModule,
    ConversationsModule,
    DeviceConfigsModule,
    DeviceLinkModule,
    DeviceStatusModule,
    DevicesModule,
    HealthModule,
    LearningStatsModule,
    LlmAdapterModule,
    ManufacturerModule,
    MusicModule,
    PromptRegistryModule,
    PushNotificationsModule,
    SleepConfigsModule,
    SleepSchedulerModule,
    TurnDecisionModule,
    UsersModule,
    VendorModule,
    WebhooksModule,
  ];

  it.each(modules.map((m) => [m]))("%p is defined", (mod) => {
    expect(mod).toBeDefined();
  });
});

describe("dto registry（字段装饰器已声明）", () => {
  const dtos = [
    BotGetValueDto,
    BotStartDto,
    BotStopDto,
    LoginMacDto,
    DeviceConfigResponseDto,
    VoiceConfigResponseDto,
    DeviceStatusDto,
    MusicControlDto,
    NeteaseBindDto,
    ReportPushSubscriptionDto,
    VendorTextOutDto,
  ];

  it.each(dtos.map((d) => [d]))("%p is defined", (dto) => {
    expect(dto).toBeDefined();
    expect(new dto()).toBeInstanceOf(dto);
  });
});
