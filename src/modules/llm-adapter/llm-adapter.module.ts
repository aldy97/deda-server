import { Module } from "@nestjs/common";
import { LlmModule } from "@/modules/llm/llm.module";
import { ChildSafetyService } from "@/modules/vendor/child-safety.service";
import { LlmAdapterController } from "./llm-adapter.controller";
import { LlmAdapterService } from "./llm-adapter.service";

/**
 * 百度 RTC OpenAI 兼容回调适配模块。
 *
 * ChildSafetyService 未被 VendorModule 导出，这里直接作为 provider
 * 实例化（其唯一依赖 LlmService 由 LlmModule 导出提供），避免改动
 * vendor 老链路的模块边界。
 */
@Module({
  imports: [LlmModule],
  controllers: [LlmAdapterController],
  providers: [LlmAdapterService, ChildSafetyService],
})
export class LlmAdapterModule {}
