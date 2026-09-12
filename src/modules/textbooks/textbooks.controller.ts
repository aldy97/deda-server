import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TextbooksService } from './textbooks.service';

@ApiTags('教材单元')
@Controller('textbooks')
export class TextbooksController {
  constructor(private readonly textbooksService: TextbooksService) {}

  @Get()
  async list(@Query() query: any) {
    // TODO: 获取教材列表
    return this.textbooksService.list(query);
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    // TODO: 获取教材详情
    return this.textbooksService.detail(id);
  }

  @Get(':id/units')
  async units(@Param('id') id: string) {
    // TODO: 获取教材下单元列表
    return this.textbooksService.units(id);
  }
}
