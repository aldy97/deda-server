import { Module } from "@nestjs/common";
import { SleepConfigsController } from "./sleep-configs.controller";
import { SleepConfigsService } from "./sleep-configs.service";
import { SleepVoiceConfigService } from "./sleep-voice-config.service";
import { LlmModule } from "@/modules/llm/llm.module";

@Module({
  imports: [LlmModule],
  controllers: [SleepConfigsController],
  providers: [SleepConfigsService, SleepVoiceConfigService],
  exports: [SleepConfigsService, SleepVoiceConfigService],
})
export class SleepConfigsModule {}
