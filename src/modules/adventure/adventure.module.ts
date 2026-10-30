import { Module } from "@nestjs/common";
import { LlmModule } from "@/modules/llm/llm.module";
import { AdventureService } from "./adventure.service";

@Module({
  imports: [LlmModule],
  providers: [AdventureService],
  exports: [AdventureService],
})
export class AdventureModule {}
