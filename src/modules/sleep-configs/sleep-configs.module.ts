import { Module } from "@nestjs/common";
import { SleepConfigsController } from "./sleep-configs.controller";
import { SleepConfigsService } from "./sleep-configs.service";
import { SleepSchedulerService } from "./sleep-scheduler.service";
import { VendorModule } from "@/modules/vendor/vendor.module";
import { LlmModule } from "@/modules/llm/llm.module";

@Module({
  imports: [VendorModule, LlmModule],
  controllers: [SleepConfigsController],
  providers: [SleepConfigsService, SleepSchedulerService],
  exports: [SleepConfigsService],
})
export class SleepConfigsModule {}
