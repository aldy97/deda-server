import { Module } from "@nestjs/common";
import { SleepSchedulerService } from "./sleep-scheduler.service";
import { SleepConfigsModule } from "./sleep-configs.module";
import { VendorModule } from "@/modules/vendor/vendor.module";
import { LlmModule } from "@/modules/llm/llm.module";
import { PushNotificationsModule } from "@/modules/push-notifications/push-notifications.module";

/**
 * 定时哄睡调度单独成模块：它依赖 VendorModule（WS 下行），
 * 而 VendorModule 依赖 SleepConfigsModule（语音改配置），
 * 拆开避免模块循环依赖。这里再直接引入 SleepConfigsModule
 * 以注入 SleepModeService（音速/音量编排）。
 */
@Module({
  imports: [
    VendorModule,
    LlmModule,
    PushNotificationsModule,
    SleepConfigsModule,
  ],
  providers: [SleepSchedulerService],
})
export class SleepSchedulerModule {}
