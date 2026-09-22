import { Test, TestingModule } from '@nestjs/testing';
import { ConversationModesController } from './conversation-modes.controller';
import { ConversationModesService } from './conversation-modes.service';

describe('ConversationModesController', () => {
  let controller: ConversationModesController;
  let service: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ConversationModesController],
      providers: [
        {
          provide: ConversationModesService,
          useValue: {
            findCategories: jest.fn(),
            findModes: jest.fn(),
            findTree: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ConversationModesController>(ConversationModesController);
    service = module.get(ConversationModesService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findCategories', () => {
    it('should return categories from service', async () => {
      const expected = [{ id: 'cat-1', key: 'free_chat', name: '自由对话', sortOrder: 0, isActive: true }];
      service.findCategories.mockResolvedValue(expected);

      const result = await controller.findCategories();

      expect(service.findCategories).toHaveBeenCalled();
      expect(result).toEqual(expected);
    });
  });

  describe('findModes', () => {
    it('should return modes from service', async () => {
      const expected = [{ id: 'mode-1', categoryId: 'cat-1', key: 'free_chat_casual', name: '自由闲聊', sortOrder: 0, isActive: true }];
      service.findModes.mockResolvedValue(expected);

      const result = await controller.findModes('free_chat');

      expect(service.findModes).toHaveBeenCalledWith('free_chat');
      expect(result).toEqual(expected);
    });
  });

  describe('findTree', () => {
    it('should return tree from service', async () => {
      const expected = [{ id: 'cat-1', key: 'free_chat', name: '自由对话', sortOrder: 0, isActive: true, modes: [] }];
      service.findTree.mockResolvedValue(expected);

      const result = await controller.findTree();

      expect(service.findTree).toHaveBeenCalled();
      expect(result).toEqual(expected);
    });
  });
});
