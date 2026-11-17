import { Global, Module } from "@nestjs/common";
import { PromptRegistryService } from "./prompt-registry.service";

/**
 * PrismaService 由全局 PrismaModule 提供，故此处无需 imports。
 *
 * 声明为 @Global：消费方横跨 llm / llm-adapter / vendor / child-memories /
 * sleep-configs / analytics 六个模块，逐个 imports 只会增加遗漏面。
 * 与仓库既有的 PrismaModule 同构。
 */
@Global()
@Module({
  providers: [PromptRegistryService],
  exports: [PromptRegistryService],
})
export class PromptRegistryModule {}
