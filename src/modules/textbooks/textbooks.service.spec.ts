import { Test, TestingModule } from '@nestjs/testing';
import { TextbooksService } from './textbooks.service';
import { PrismaService } from '@/common/prisma/prisma.service';

describe('TextbooksService', () => {
  let service: TextbooksService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      textbook: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        upsert: jest.fn(),
      },
      unit: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        upsert: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TextbooksService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<TextbooksService>(TextbooksService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('list', () => {
    it('should return a list of textbooks', async () => {
      prisma.textbook.findMany.mockResolvedValue([
        { id: '1', textbookId: 'tb1', name: 'Book 1', description: 'Desc 1' },
      ]);

      const result = await service.list();
      expect(result).toHaveLength(1);
      expect(result[0].textbookId).toBe('tb1');
    });
  });

  describe('detail', () => {
    it('should return textbook detail', async () => {
      prisma.textbook.findUnique.mockResolvedValue({
        id: '1',
        textbookId: 'tb1',
        name: 'Book 1',
        promptTemplate: 'prompt',
      });

      const result = await service.detail('tb1');
      expect(result.textbookId).toBe('tb1');
      expect(result.promptTemplate).toBe('prompt');
    });

    it('should throw when textbook not found', async () => {
      prisma.textbook.findUnique.mockResolvedValue(null);
      await expect(service.detail('missing')).rejects.toThrow(
        'Textbook not found: missing',
      );
    });
  });

  describe('units', () => {
    it('should return units for a textbook', async () => {
      prisma.textbook.findUnique.mockResolvedValue({ id: '1' });
      prisma.unit.findMany.mockResolvedValue([
        {
          id: 'u1',
          unitId: 'unit-1',
          name: 'Unit 1',
          description: 'Desc',
          cefrLevel: 'A1',
          difficulty: 1,
          sortOrder: 1,
        },
      ]);

      const result = await service.units('tb1');
      expect(result).toHaveLength(1);
      expect(result[0].unitId).toBe('unit-1');
    });
  });

  describe('create', () => {
    it('should create a textbook', async () => {
      prisma.textbook.create.mockResolvedValue({ id: '1', textbookId: 'tb1' });

      const result = await service.create({
        textbookId: 'tb1',
        name: 'Book 1',
      } as any);

      expect(result.textbookId).toBe('tb1');
    });
  });

  describe('createUnit', () => {
    it('should create a unit under a textbook', async () => {
      prisma.textbook.findUnique.mockResolvedValue({ id: '1' });
      prisma.unit.create.mockResolvedValue({ id: 'u1', unitId: 'unit-1' });

      const result = await service.createUnit('tb1', {
        unitId: 'unit-1',
        name: 'Unit 1',
        content: 'Content',
      } as any);

      expect(result.unitId).toBe('unit-1');
    });
  });
});
