import { Controller, Get, Post, Patch, Delete, Param, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ChildProfilesService } from './child-profiles.service';

@ApiTags('孩子档案')
@Controller('child-profiles')
export class ChildProfilesController {
  constructor(private readonly childProfilesService: ChildProfilesService) {}

  @Get()
  async list() {
    // TODO: 获取当前用户的孩子档案列表
    return this.childProfilesService.list();
  }

  @Post()
  async create(@Body() dto: any) {
    // TODO: 新增孩子档案
    return this.childProfilesService.create(dto);
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    // TODO: 获取单条档案
    return this.childProfilesService.detail(id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: any) {
    // TODO: 更新孩子档案
    return this.childProfilesService.update(id, dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    // TODO: 删除孩子档案
    return this.childProfilesService.remove(id);
  }
}
