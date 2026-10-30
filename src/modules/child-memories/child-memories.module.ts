import { Module } from "@nestjs/common";
import { LlmModule } from "@/modules/llm/llm.module";
import { ChildMemoriesService } from "./child-memories.service";

@Module({
  imports: [LlmModule],
  providers: [ChildMemoriesService],
  exports: [ChildMemoriesService],
})
export class ChildMemoriesModule {}
