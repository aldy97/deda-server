import { Controller, Get, Delete, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConversationsService } from './conversations.service';

@ApiTags('对话记录')
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get()
  async list(@Query() query: any) {
    // TODO: 按设备、日期分页查询对话记录
    return this.conversationsService.list(query);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    // TODO: 删除单条对话记录
    return this.conversationsService.remove(id);
  }

  @Delete('date/:date')
  async clearByDate(@Param('date') date: string, @Query('deviceId') deviceId: string) {
    // TODO: 清空某日期全部对话记录
    return this.conversationsService.clearByDate(deviceId, date);
  }
}
