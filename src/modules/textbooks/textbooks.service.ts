import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';

@Injectable()
export class TextbooksService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: any) {
    // TODO: 查询教材库
    return [];
  }

  async detail(id: string) {
    // TODO: 查询教材详情
    return null;
  }

  async units(id: string) {
    // TODO: 查询教材单元
    return [];
  }
}
