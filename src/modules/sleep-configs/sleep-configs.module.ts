import { Module } from "@nestjs/common";
import { SleepConfigsController } from "./sleep-configs.controller";
import { SleepConfigsService } from "./sleep-configs.service";
import { SleepVoiceConfigService } from "./sleep-voice-config.service";
import { SleepModeService } from "./sleep-mode.service";
import { SleepStoryContextService } from "./sleep-story-context.service";
import { LlmModule } from "@/modules/llm/llm.module";
import { DeviceLinkModule } from "@/modules/device-link/device-link.module";
import { BaiduAgentModule } from "@/modules/baidu-agent/baidu-agent.module";

@Module({
  imports: [LlmModule, DeviceLinkModule, BaiduAgentModule],
  controllers: [SleepConfigsController],
  providers: [
    SleepConfigsService,
    SleepVoiceConfigService,
    SleepModeService,
    SleepStoryContextService,
  ],
  exports: [
    SleepConfigsService,
    SleepVoiceConfigService,
    SleepModeService,
    SleepStoryContextService,
  ],
})
export class SleepConfigsModule {}
