import { Test, TestingModule } from '@nestjs/testing';
import { TextbookImportService } from './textbook-import.service';
import { PrismaService } from '@/common/prisma/prisma.service';

describe('TextbookImportService', () => {
  let service: TextbookImportService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      textbook: {
        upsert: jest.fn(),
      },
      unit: {
        upsert: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TextbookImportService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<TextbookImportService>(TextbookImportService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('parseMarkdown', () => {
    it('should parse markdown with explicit unit ids', () => {
      const md = `# My Book
## unit-1: Hello
Hello there, how are you doing today?

## unit-2: Colors
What color is it?
`;

      const result = service.parseMarkdown(md, {
        textbookId: 'my-book',
        cefrLevel: 'A1',
      });

      expect(result.textbookId).toBe('my-book');
      expect(result.name).toBe('My Book');
      expect(result.units).toHaveLength(2);
      expect(result.units[0].unitId).toBe('unit-1');
      expect(result.units[0].name).toBe('Hello');
      expect(result.units[0].cefrLevel).toBe('A1');
      expect(result.units[0].difficulty).toBeNull();
      expect(result.units[0].description).toContain('Hello there');
    });

    it('should generate description from first sentence', () => {
      const md = `# Book
## unit-1: Greetings
Good morning. How are you today?
`;

      const result = service.parseMarkdown(md, { textbookId: 'book' });
      expect(result.units[0].description).toBe('Good morning');
    });

    it('should infer cefrLevel from content, not sort order', () => {
      const md = `# Book
## u1
I am fine.
## u2
The quick brown fox jumps over the lazy dog while the sun shines brightly on the green meadow.
`;

      const result = service.parseMarkdown(md, { textbookId: 'book' });
      expect(result.units[0].cefrLevel).toBe('A1');
      expect(result.units[1].cefrLevel).toBe('B2');
    });
  });

  describe('parseMarkdownByUnits', () => {
    it('should split by UNLOCK YOUR KNOWLEDGE boundaries', () => {
      const md = `# My Book
## PREPARING TO LISTEN
Hello world.

## SEASONS
## UNLOCK YOUR KNOWLEDGE
What season is it?

## LIFESTYLE
## UNLOCK YOUR KNOWLEDGE
What lifestyle?
`;

      const result = service.parseMarkdownByUnits(md, { textbookId: 'my-book' });
      expect(result.units).toHaveLength(3);
      expect(result.units[0].unitId).toBe('unit-1');
      expect(result.units[0].name).toBe('Unit 1');
      expect(result.units[0].content).toContain('Hello world');
      expect(result.units[1].unitId).toBe('unit-2');
      expect(result.units[1].name).toBe('SEASONS');
      expect(result.units[2].unitId).toBe('unit-3');
      expect(result.units[2].name).toBe('LIFESTYLE');
    });

    it('should use explicit UNIT markers when present', () => {
      const md = `# Book
## UNIT 6
## UNLOCK YOUR KNOWLEDGE
Homes and buildings.
`;

      const result = service.parseMarkdownByUnits(md, { textbookId: 'book' });
      expect(result.units).toHaveLength(1);
      expect(result.units[0].unitId).toBe('unit-6');
      expect(result.units[0].name).toBe('Unit 6');
    });

    it('should not treat UNLOCK YOUR KNOWLEDGE inside explicit UNIT as a new unit', () => {
      const md = `# Book
## UNIT 6
## UNLOCK YOUR KNOWLEDGE
Main content.
## UNIT 7
## UNLOCK YOUR KNOWLEDGE
Food and culture.
`;

      const result = service.parseMarkdownByUnits(md, { textbookId: 'book' });
      expect(result.units).toHaveLength(2);
      expect(result.units[0].unitId).toBe('unit-6');
      expect(result.units[1].unitId).toBe('unit-7');
    });
  });

  describe('saveToDb', () => {
    it('should upsert textbook and units', async () => {
      prisma.textbook.upsert.mockResolvedValue({ id: 'tb-id', textbookId: 'tb1' });
      prisma.unit.upsert.mockResolvedValue({ id: 'u-id' });

      await (service as any).saveToDb({
        textbookId: 'tb1',
        name: 'Book',
        description: 'Desc',
        cefrLevel: 'A1',
        units: [
          {
            unitId: 'u1',
            name: 'Unit 1',
            description: 'Unit desc',
            cefrLevel: 'A1',
            difficulty: 1,
            sortOrder: 1,
            content: 'Content',
          },
        ],
      });

      expect(prisma.textbook.upsert).toHaveBeenCalled();
      expect(prisma.unit.upsert).toHaveBeenCalled();
    });
  });
});
