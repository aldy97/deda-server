import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TextbooksService } from './textbooks.service';

@ApiTags('教材单元')
@Controller('textbooks')
export class TextbooksController {
  constructor(private readonly textbooksService: TextbooksService) {}

  @Get()
  @ApiOperation({ summary: '获取教材列表' })
  async list() {
    return this.textbooksService.list();
  }

  @Get(':id')
  @ApiOperation({ summary: '获取教材详情' })
  async detail(@Param('id') id: string) {
    return this.textbooksService.detail(id);
  }

  @Get(':id/units')
  @ApiOperation({ summary: '获取教材下单元列表' })
  async units(@Param('id') id: string) {
    return this.textbooksService.units(id);
  }
}
