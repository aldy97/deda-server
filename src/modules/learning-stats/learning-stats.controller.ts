import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LearningStatsService } from './learning-stats.service';

@ApiTags('学习统计')
@Controller('learning-stats')
export class LearningStatsController {
  constructor(private readonly learningStatsService: LearningStatsService) {}

  @Get('dashboard')
  async dashboard(@Query('deviceId') deviceId: string) {
    // TODO: 首页看板：设备状态、今日/累计统计
    return this.learningStatsService.dashboard(deviceId);
  }

  @Get('daily')
  async daily(@Query() query: any) {
    // TODO: 每日学习小结
    return this.learningStatsService.daily(query);
  }

  @Get('unit-progress/:deviceId')
  async unitProgress(@Param('deviceId') deviceId: string) {
    // TODO: 单元练习进度
    return this.learningStatsService.unitProgress(deviceId);
  }
}
