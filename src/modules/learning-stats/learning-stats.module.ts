import { Module } from '@nestjs/common';
import { LearningStatsController } from './learning-stats.controller';
import { LearningStatsService } from './learning-stats.service';

@Module({
  controllers: [LearningStatsController],
  providers: [LearningStatsService],
  exports: [LearningStatsService],
})
export class LearningStatsModule {}
