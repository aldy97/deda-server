import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RagService } from './rag.service';
import * as fs from 'fs';
import * as path from 'path';

describe('RagService', () => {
  let service: RagService;
  let tempDir: string;

  beforeEach(async () => {
    // 创建临时教材目录
    tempDir = fs.mkdtempSync('/tmp/deda-rag-test-');
    const textbook = {
      textbookId: 'test-book',
      name: 'Test Book',
      units: [
        {
          unitId: 'u1',
          name: 'Hello',
          sortOrder: 1,
          content: 'Hello! How are you? I am fine, thank you.',
        },
        {
          unitId: 'u2',
          name: 'Colors',
          sortOrder: 2,
          content: 'What color is it? It is red.',
        },
      ],
    };
    fs.writeFileSync(
      path.join(tempDir, 'test-book.json'),
      JSON.stringify(textbook),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RagService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(tempDir),
          },
        },
      ],
    }).compile();

    service = module.get<RagService>(RagService);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('loadTextbook', () => {
    it('should load a textbook by id', () => {
      const book = service.loadTextbook('test-book');
      expect(book).not.toBeNull();
      expect(book?.textbookId).toBe('test-book');
      expect(book?.units).toHaveLength(2);
    });

    it('should return null for missing textbook', () => {
      const book = service.loadTextbook('missing-book');
      expect(book).toBeNull();
    });

    it('should prefer markdown over json when both exist', () => {
      const mdContent = `# Markdown Book
## u1: Unit One
Content from markdown.
`;
      fs.writeFileSync(path.join(tempDir, 'test-book.md'), mdContent);

      const book = service.loadTextbook('test-book');
      expect(book).not.toBeNull();
      expect(book?.name).toBe('Markdown Book');
      expect(book?.units).toHaveLength(1);
      expect(book?.units[0].unitId).toBe('u1');
      expect(book?.units[0].content).toContain('Content from markdown');

      fs.rmSync(path.join(tempDir, 'test-book.md'));
    });
  });

  describe('loadMarkdownTextbook', () => {
    it('should parse markdown with h1 title and h2 units', () => {
      const mdContent = `# My Textbook
## unit-a: Hello
Hello content.

More hello.
## unit-b: Goodbye
Goodbye content.
`;
      fs.writeFileSync(path.join(tempDir, 'md-book.md'), mdContent);

      const book = service.loadTextbook('md-book');
      expect(book).not.toBeNull();
      expect(book?.name).toBe('My Textbook');
      expect(book?.units).toHaveLength(2);
      expect(book?.units[0]).toEqual({
        unitId: 'unit-a',
        name: 'Hello',
        sortOrder: 1,
        content: 'Hello content.\n\nMore hello.',
      });
      expect(book?.units[1]).toEqual({
        unitId: 'unit-b',
        name: 'Goodbye',
        sortOrder: 2,
        content: 'Goodbye content.',
      });

      fs.rmSync(path.join(tempDir, 'md-book.md'));
    });
  });

  describe('retrieve', () => {
    it('should retrieve content for existing textbook and unit', () => {
      const result = service.retrieve('test-book', 'u1');
      expect(result.found).toBe(true);
      expect(result.textbookId).toBe('test-book');
      expect(result.unitId).toBe('u1');
      expect(result.unitName).toBe('Hello');
      expect(result.content).toContain('How are you?');
    });

    it('should return found=false for missing unit', () => {
      const result = service.retrieve('test-book', 'u99');
      expect(result.found).toBe(false);
      expect(result.content).toBe('');
    });

    it('should return found=false for missing textbook', () => {
      const result = service.retrieve('missing-book', 'u1');
      expect(result.found).toBe(false);
    });

    it('should accept query parameter without changing result', () => {
      const result = service.retrieve('test-book', 'u2', 'red color');
      expect(result.found).toBe(true);
      expect(result.content).toContain('red');
    });
  });

  describe('truncateContent', () => {
    it('should not truncate content within token limit', () => {
      const content = 'Hello world.';
      const result = service.truncateContent(content, 100);
      expect(result).toBe(content);
    });

    it('should truncate content exceeding token limit', () => {
      const longContent = 'A'.repeat(10000);
      const result = service.truncateContent(longContent, 100);
      expect(service.estimateTokens(result)).toBeLessThanOrEqual(120);
    });
  });
});
