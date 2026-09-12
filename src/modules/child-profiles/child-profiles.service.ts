import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';

@Injectable()
export class ChildProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    // TODO: 查询当前用户的孩子档案
    return [];
  }

  async create(dto: any) {
    // TODO: 创建档案
    return null;
  }

  async detail(id: string) {
    // TODO: 查询单条档案
    return null;
  }

  async update(id: string, dto: any) {
    // TODO: 更新档案
    return null;
  }

  async remove(id: string) {
    // TODO: 删除档案
    return null;
  }
}
