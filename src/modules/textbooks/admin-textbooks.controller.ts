import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/users/guards/jwt-auth.guard';
import { TextbooksService } from './textbooks.service';
import { TextbookImportService } from './textbook-import.service';
import { CreateTextbookDto } from './dto/create-textbook.dto';
import { UpdateTextbookDto } from './dto/update-textbook.dto';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';
import { ImportTextbookFromFileDto } from './dto/import-textbook-from-file.dto';

@ApiTags('管理后台 - 教材单元')
@UseGuards(JwtAuthGuard)
@Controller('admin/textbooks')
export class AdminTextbooksController {
  constructor(
    private readonly textbooksService: TextbooksService,
    private readonly textbookImportService: TextbookImportService,
  ) {}

  @Post()
  @ApiOperation({ summary: '创建教材' })
  async create(@Body() dto: CreateTextbookDto) {
    return this.textbooksService.create(dto);
  }

  @Put(':textbookId')
  @ApiOperation({ summary: '更新教材' })
  async update(
    @Param('textbookId') textbookId: string,
    @Body() dto: UpdateTextbookDto,
  ) {
    return this.textbooksService.update(textbookId, dto);
  }

  @Delete(':textbookId')
  @ApiOperation({ summary: '删除教材' })
  async remove(@Param('textbookId') textbookId: string) {
    await this.textbooksService.remove(textbookId);
    return { success: true };
  }

  @Post(':textbookId/units')
  @ApiOperation({ summary: '创建单元' })
  async createUnit(
    @Param('textbookId') textbookId: string,
    @Body() dto: CreateUnitDto,
  ) {
    return this.textbooksService.createUnit(textbookId, dto);
  }

  @Put(':textbookId/units/:unitId')
  @ApiOperation({ summary: '更新单元' })
  async updateUnit(
    @Param('textbookId') textbookId: string,
    @Param('unitId') unitId: string,
    @Body() dto: UpdateUnitDto,
  ) {
    return this.textbooksService.updateUnit(textbookId, unitId, dto);
  }

  @Delete(':textbookId/units/:unitId')
  @ApiOperation({ summary: '删除单元' })
  async removeUnit(
    @Param('textbookId') textbookId: string,
    @Param('unitId') unitId: string,
  ) {
    await this.textbooksService.removeUnit(textbookId, unitId);
    return { success: true };
  }

  @Post('import-from-file')
  @ApiOperation({ summary: '从本地 Markdown 文件导入教材' })
  async importFromFile(@Body() dto: ImportTextbookFromFileDto) {
    return this.textbookImportService.importFromFile(dto.filePath, {
      textbookId: dto.textbookId,
      name: dto.name,
      description: dto.description,
      cefrLevel: dto.cefrLevel,
      promptTemplate: dto.promptTemplate,
      singleUnit: dto.singleUnit,
      unitMarkers: dto.unitMarkers,
      singleUnitName: dto.singleUnitName,
      singleUnitId: dto.singleUnitId,
    });
  }
}
