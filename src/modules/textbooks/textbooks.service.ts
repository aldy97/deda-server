import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
import { CreateTextbookDto } from './dto/create-textbook.dto';
import { UpdateTextbookDto } from './dto/update-textbook.dto';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';

@Injectable()
export class TextbooksService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.textbook.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        textbookId: true,
        name: true,
        description: true,
        cefrLevel: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async detail(textbookId: string) {
    const textbook = await this.prisma.textbook.findUnique({
      where: { textbookId },
      select: {
        id: true,
        textbookId: true,
        name: true,
        description: true,
        cefrLevel: true,
        promptTemplate: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!textbook) {
      throw new NotFoundException(`Textbook not found: ${textbookId}`);
    }

    return textbook;
  }

  async units(textbookId: string) {
    const textbook = await this.prisma.textbook.findUnique({
      where: { textbookId },
      select: { id: true },
    });

    if (!textbook) {
      throw new NotFoundException(`Textbook not found: ${textbookId}`);
    }

    return this.prisma.unit.findMany({
      where: { textbookId: textbook.id },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        unitId: true,
        textbookId: true,
        name: true,
        description: true,
        cefrLevel: true,
        difficulty: true,
        sortOrder: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async create(dto: CreateTextbookDto) {
    return this.prisma.textbook.create({
      data: {
        textbookId: dto.textbookId,
        name: dto.name,
        description: dto.description,
        cefrLevel: dto.cefrLevel,
        promptTemplate: dto.promptTemplate,
      },
    });
  }

  async update(textbookId: string, dto: UpdateTextbookDto) {
    return this.prisma.textbook.update({
      where: { textbookId },
      data: {
        name: dto.name,
        description: dto.description,
        cefrLevel: dto.cefrLevel,
        promptTemplate: dto.promptTemplate,
      },
    });
  }

  async remove(textbookId: string) {
    return this.prisma.textbook.delete({
      where: { textbookId },
    });
  }

  async createUnit(textbookId: string, dto: CreateUnitDto) {
    const textbook = await this.prisma.textbook.findUnique({
      where: { textbookId },
      select: { id: true },
    });

    if (!textbook) {
      throw new NotFoundException(`Textbook not found: ${textbookId}`);
    }

    return this.prisma.unit.create({
      data: {
        textbookId: textbook.id,
        unitId: dto.unitId,
        name: dto.name,
        description: dto.description,
        cefrLevel: dto.cefrLevel,
        difficulty: dto.difficulty,
        sortOrder: dto.sortOrder ?? 0,
        content: dto.content,
      },
    });
  }

  async updateUnit(textbookId: string, unitId: string, dto: UpdateUnitDto) {
    const textbook = await this.prisma.textbook.findUnique({
      where: { textbookId },
      select: { id: true },
    });

    if (!textbook) {
      throw new NotFoundException(`Textbook not found: ${textbookId}`);
    }

    return this.prisma.unit.update({
      where: {
        textbookId_unitId: {
          textbookId: textbook.id,
          unitId,
        },
      },
      data: {
        name: dto.name,
        description: dto.description,
        cefrLevel: dto.cefrLevel,
        difficulty: dto.difficulty,
        sortOrder: dto.sortOrder,
        content: dto.content,
      },
    });
  }

  async removeUnit(textbookId: string, unitId: string) {
    const textbook = await this.prisma.textbook.findUnique({
      where: { textbookId },
      select: { id: true },
    });

    if (!textbook) {
      throw new NotFoundException(`Textbook not found: ${textbookId}`);
    }

    return this.prisma.unit.delete({
      where: {
        textbookId_unitId: {
          textbookId: textbook.id,
          unitId,
        },
      },
    });
  }
}
