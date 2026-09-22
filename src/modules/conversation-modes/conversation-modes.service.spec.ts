import { Test, TestingModule } from '@nestjs/testing';
import { ConversationModesService } from './conversation-modes.service';
import { PrismaService } from '@/common/prisma/prisma.service';

describe('ConversationModesService', () => {
  let service: ConversationModesService;
  let prisma: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationModesService,
        {
          provide: PrismaService,
          useValue: {
            conversationModeCategory: {
              findMany: jest.fn(),
              findUnique: jest.fn(),
              upsert: jest.fn(),
            },
            conversationMode: {
              findMany: jest.fn(),
              upsert: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<ConversationModesService>(ConversationModesService);
    prisma = module.get(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findCategories', () => {
    it('should return active categories ordered by sortOrder', async () => {
      prisma.conversationModeCategory.findMany.mockResolvedValue([
        { id: 'cat-1', key: 'free_chat', name: '自由对话', sortOrder: 0, isActive: true },
        { id: 'cat-2', key: 'textbook_learning', name: '教材学习', sortOrder: 1, isActive: true },
      ]);

      const result = await service.findCategories();

      expect(prisma.conversationModeCategory.findMany).toHaveBeenCalledWith({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
      });
      expect(result).toHaveLength(2);
      expect(result[0].key).toBe('free_chat');
    });
  });

  describe('findModes', () => {
    it('should return all active modes ordered by sortOrder when no categoryKey', async () => {
      prisma.conversationMode.findMany.mockResolvedValue([
        { id: 'mode-1', categoryId: 'cat-1', key: 'free_chat_casual', name: '自由闲聊', sortOrder: 0, isActive: true },
      ]);

      const result = await service.findModes();

      expect(prisma.conversationMode.findMany).toHaveBeenCalledWith({
        where: { isActive: true },
        orderBy: { sortOrder: 'asc' },
      });
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('free_chat_casual');
    });

    it('should filter modes by categoryKey', async () => {
      prisma.conversationModeCategory.findUnique.mockResolvedValue({ id: 'cat-1' });
      prisma.conversationMode.findMany.mockResolvedValue([
        { id: 'mode-1', categoryId: 'cat-1', key: 'free_chat_casual', name: '自由闲聊', sortOrder: 0, isActive: true },
      ]);

      const result = await service.findModes('free_chat');

      expect(prisma.conversationModeCategory.findUnique).toHaveBeenCalledWith({
        where: { key: 'free_chat' },
        select: { id: true },
      });
      expect(prisma.conversationMode.findMany).toHaveBeenCalledWith({
        where: { isActive: true, categoryId: 'cat-1' },
        orderBy: { sortOrder: 'asc' },
      });
      expect(result[0].key).toBe('free_chat_casual');
    });

    it('should return empty array when categoryKey not found', async () => {
      prisma.conversationModeCategory.findUnique.mockResolvedValue(null);

      const result = await service.findModes('unknown');

      expect(result).toEqual([]);
      expect(prisma.conversationMode.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findTree', () => {
    it('should return categories with nested modes', async () => {
      prisma.conversationModeCategory.findMany.mockResolvedValue([
        { id: 'cat-1', key: 'free_chat', name: '自由对话', description: null, sortOrder: 0, isActive: true },
        { id: 'cat-2', key: 'textbook_learning', name: '教材学习', description: null, sortOrder: 1, isActive: true },
      ]);
      prisma.conversationMode.findMany.mockResolvedValue([
        { id: 'mode-1', categoryId: 'cat-1', key: 'free_chat_casual', name: '自由闲聊', description: null, sortOrder: 0, isActive: true, configSchema: null, promptTemplate: null },
        { id: 'mode-2', categoryId: 'cat-2', key: 'textbook_follow', name: '课文跟读', description: null, sortOrder: 0, isActive: true, configSchema: null, promptTemplate: null },
      ]);

      const result = await service.findTree();

      expect(result).toHaveLength(2);
      expect(result[0].modes).toHaveLength(1);
      expect(result[0].modes[0].key).toBe('free_chat_casual');
      expect(result[1].modes[0].key).toBe('textbook_follow');
    });
  });

  describe('seedDefaults', () => {
    it('should upsert default categories and modes', async () => {
      prisma.conversationModeCategory.upsert
        .mockResolvedValueOnce({ id: 'cat-free-chat' })
        .mockResolvedValueOnce({ id: 'cat-textbook' });
      prisma.conversationModeCategory.findUnique
        .mockResolvedValueOnce({ id: 'cat-free-chat' })
        .mockResolvedValueOnce({ id: 'cat-textbook' })
        .mockResolvedValueOnce({ id: 'cat-free-chat' })
        .mockResolvedValueOnce({ id: 'cat-textbook' })
        .mockResolvedValueOnce({ id: 'cat-free-chat' })
        .mockResolvedValueOnce({ id: 'cat-textbook' });
      prisma.conversationMode.upsert.mockResolvedValue({ id: 'mode-1' });

      await service.seedDefaults();

      expect(prisma.conversationModeCategory.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.conversationMode.upsert).toHaveBeenCalledTimes(6);
    });
  });
});
