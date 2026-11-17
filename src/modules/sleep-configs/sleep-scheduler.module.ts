import { Module } from "@nestjs/common";
import { SleepSchedulerService } from "./sleep-scheduler.service";
import { VendorModule } from "@/modules/vendor/vendor.module";
import { LlmModule } from "@/modules/llm/llm.module";
import { PushNotificationsModule } from "@/modules/push-notifications/push-notifications.module";

/**
 * 定时哄睡调度单独成模块：它依赖 VendorModule（WS 下行），
 * 而 VendorModule 依赖 SleepConfigsModule（语音改配置），
 * 拆开避免模块循环依赖。
 */
@Module({
  imports: [VendorModule, LlmModule, PushNotificationsModule],
  providers: [SleepSchedulerService],
})
export class SleepSchedulerModule {}
