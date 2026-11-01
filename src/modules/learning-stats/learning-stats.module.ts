import { Module } from "@nestjs/common";
import { LearningStatsController } from "./learning-stats.controller";
import { LearningStatsService } from "./learning-stats.service";
import { ParentReportGeneratorService } from "./parent-report-generator.service";
import { LlmModule } from "@/modules/llm/llm.module";

@Module({
  imports: [LlmModule],
  controllers: [LearningStatsController],
  providers: [LearningStatsService, ParentReportGeneratorService],
  exports: [LearningStatsService],
})
export class LearningStatsModule {}
