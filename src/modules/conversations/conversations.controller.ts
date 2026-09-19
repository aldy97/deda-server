import { Controller, Get, Delete, Param, Query, Headers } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConversationsService } from './conversations.service';

@ApiTags('对话记录')
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get()
  async list(
    @Headers('x-user-id') userId: string,
    @Query() query: any,
  ) {
    return this.conversationsService.list(userId, query);
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Headers('x-user-id') userId: string,
  ) {
    return this.conversationsService.remove(userId, id);
  }

  @Delete('date/:date')
  async clearByDate(
    @Param('date') date: string,
    @Query('deviceId') deviceId: string,
    @Headers('x-user-id') userId: string,
  ) {
    return this.conversationsService.clearByDate(userId, deviceId, date);
  }
}
