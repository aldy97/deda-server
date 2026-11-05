import { Module } from "@nestjs/common";
import { LlmModule } from "@/modules/llm/llm.module";
import { ChildMemoriesModule } from "@/modules/child-memories/child-memories.module";
import { SleepConfigsModule } from "@/modules/sleep-configs/sleep-configs.module";
import { AdventureModule } from "@/modules/adventure/adventure.module";
import { ChildSafetyService } from "@/modules/vendor/child-safety.service";
import { ConversationSessionService } from "@/modules/vendor/conversation-session.service";
import { LlmAdapterController } from "./llm-adapter.controller";
import { LlmAdapterService } from "./llm-adapter.service";

/**
 * 百度 RTC OpenAI 兼容回调适配模块。
 *
 * ChildSafetyService / ConversationSessionService 虽属 vendor 目录，
 * 但 VendorModule 带有 WS 网关与冒险超时监听等老链路副作用，这里按
 * ChildSafetyService 同款模式直接实例化（依赖仅 Prisma+Llm），
 * 避免把老链路拖进新模块边界。AdventureService 经 AdventureModule
 * 引入（与 vendor 共享单例；适配层只读使用，不注册超时监听）。
 * PrismaService 由全局 PrismaModule 提供。
 */
@Module({
  imports: [
    LlmModule,
    ChildMemoriesModule,
    SleepConfigsModule,
    AdventureModule,
  ],
  controllers: [LlmAdapterController],
  providers: [
    LlmAdapterService,
    ChildSafetyService,
    ConversationSessionService,
  ],
})
export class LlmAdapterModule {}
