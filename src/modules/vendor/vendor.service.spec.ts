import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { VendorService } from './vendor.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RagService } from '@/modules/rag/rag.service';
import { LlmService } from '@/modules/llm/llm.service';
import { VendorTextInDto } from './dto/vendor-text-in.dto';
import { VendorStatusDto } from './dto/vendor-status.dto';
import { VendorBindDto } from './dto/vendor-bind.dto';
import { VendorConversationDto } from './dto/vendor-conversation.dto';

describe('VendorService', () => {
  let service: VendorService;
  let prisma: any;
  let ragService: jest.Mocked<RagService>;
  let llmService: jest.Mocked<LlmService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorService,
        {
          provide: PrismaService,
          useValue: {
            device: {
              findUnique: jest.fn(),
              create: jest.fn(),
            },
            deviceConfig: {
              findFirst: jest.fn(),
            },
            conversation: {
              findMany: jest.fn(),
              create: jest.fn(),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const map: Record<string, string> = {
                DEFAULT_TEXTBOOK_ID: 'sample-textbook',
                DEFAULT_UNIT_ID: 'unit-1',
              };
              return map[key];
            }),
          },
        },
        {
          provide: RagService,
          useValue: {
            retrieve: jest.fn(),
            truncateContent: jest.fn((content: string) => content),
          },
        },
        {
          provide: LlmService,
          useValue: {
            buildEnglishTutorPrompt: jest.fn(),
            complete: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<VendorService>(VendorService);
    prisma = module.get(PrismaService);
    ragService = module.get(RagService);
    llmService = module.get(LlmService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('handleTextIn', () => {
    it('should call RAG and LLM, ensure device exists, and persist conversation', async () => {
      const dto: VendorTextInDto = {
        deviceId: 'dev-001',
        asrText: '你好',
      };

      prisma.device.findUnique.mockResolvedValue(null);
      prisma.device.create.mockResolvedValue({ id: 'uuid-001', deviceId: 'dev-001' } as any);
      prisma.conversation.findMany.mockResolvedValue([]);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-001' } as any);
      ragService.retrieve.mockResolvedValue({
        textbookId: 'sample-textbook',
        unitId: 'unit-1',
        unitName: 'Greetings',
        content: 'Hello! How are you?',
        found: true,
      });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: 'system', content: 'prompt' },
        { role: 'user', content: '你好' },
      ] as any);
      llmService.complete.mockResolvedValue({
        text: "Hello! I'm fine, thank you.",
        usage: { totalTokens: 50 },
      });

      const result = await service.handleTextIn(dto);

      expect(prisma.device.findUnique).toHaveBeenCalledWith({ where: { deviceId: 'dev-001' } });
      expect(prisma.device.create).toHaveBeenCalledWith({ data: { deviceId: 'dev-001' } });
      expect(ragService.retrieve).toHaveBeenCalledWith(
        'sample-textbook',
        'unit-1',
        '你好',
      );
      expect(llmService.complete).toHaveBeenCalled();
      expect(prisma.conversation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deviceId: 'uuid-001',
            asrText: '你好',
            aiReply: "Hello! I'm fine, thank you.",
            textbookId: 'sample-textbook',
            unitId: 'unit-1',
          }),
        }),
      );
      expect(result).toEqual({
        deviceId: 'dev-001',
        responseText: "Hello! I'm fine, thank you.",
        context: {
          textbookId: 'sample-textbook',
          unitId: 'unit-1',
          unitName: 'Greetings',
          ragFound: true,
        },
        ttsOptions: {},
      });
    });

    it('should use payload textbookId/unitId when provided', async () => {
      const dto: VendorTextInDto = {
        deviceId: 'dev-002',
        asrText: 'What color is it?',
        textbookId: 'custom-book',
        unitId: 'unit-colors',
      };

      prisma.device.findUnique.mockResolvedValue({ id: 'uuid-002', deviceId: 'dev-002' } as any);
      prisma.conversation.findMany.mockResolvedValue([]);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-002' } as any);
      ragService.retrieve.mockResolvedValue({
        textbookId: 'custom-book',
        unitId: 'unit-colors',
        unitName: 'Colors',
        content: 'Red, blue, green.',
        found: true,
      });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: 'system', content: 'prompt' },
        { role: 'user', content: 'What color is it?' },
      ] as any);
      llmService.complete.mockResolvedValue({ text: "It's red." });

      const result = await service.handleTextIn(dto);

      expect(ragService.retrieve).toHaveBeenCalledWith(
        'custom-book',
        'unit-colors',
        'What color is it?',
      );
      expect(result.context).toEqual({
        textbookId: 'custom-book',
        unitId: 'unit-colors',
        unitName: 'Colors',
        ragFound: true,
      });
    });

    it('should return fallback reply when LLM fails', async () => {
      const dto: VendorTextInDto = {
        deviceId: 'dev-003',
        asrText: 'Hello',
      };

      prisma.device.findUnique.mockResolvedValue({ id: 'uuid-003', deviceId: 'dev-003' } as any);
      prisma.conversation.findMany.mockResolvedValue([]);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-003' } as any);
      ragService.retrieve.mockResolvedValue({
        textbookId: 'sample-textbook',
        unitId: 'unit-1',
        unitName: 'Greetings',
        content: 'Hello!',
        found: true,
      });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: 'system', content: 'prompt' },
        { role: 'user', content: 'Hello' },
      ] as any);
      llmService.complete.mockRejectedValue(new Error('LLM timeout'));

      const result = await service.handleTextIn(dto);

      expect(result.responseText).toBe(
        "Sorry, I didn't catch that. Could you say it again?",
      );
      expect(result.context).toEqual({
        textbookId: 'sample-textbook',
        unitId: 'unit-1',
        unitName: 'Greetings',
        ragFound: true,
      });
    });

    it('should preserve deviceId in the response', async () => {
      const dto: VendorTextInDto = {
        deviceId: 'dev-abc-123',
        asrText: 'Hello',
        confidence: 0.95,
        firmwareVersion: '1.0.0',
        metadata: { lang: 'en' },
      };

      prisma.device.findUnique.mockResolvedValue({ id: 'uuid-abc', deviceId: 'dev-abc-123' } as any);
      prisma.conversation.findMany.mockResolvedValue([]);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-002' } as any);
      ragService.retrieve.mockResolvedValue({
        textbookId: 'sample-textbook',
        unitId: 'unit-1',
        unitName: 'Greetings',
        content: 'Hello!',
        found: true,
      });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: 'system', content: 'prompt' },
        { role: 'user', content: 'Hello' },
      ] as any);
      llmService.complete.mockResolvedValue({ text: 'Hi there!' });

      const result = await service.handleTextIn(dto);

      expect(prisma.device.create).not.toHaveBeenCalled();
      expect(result.deviceId).toBe('dev-abc-123');
      expect(result.responseText).toBe('Hi there!');
    });
  });

  describe('handleStatusReport', () => {
    it('should return success with deviceId', async () => {
      const dto: VendorStatusDto = {
        deviceId: 'dev-001',
        online: true,
        batteryPercent: 80,
        charging: false,
        signalStrength: -50,
      };

      const result = await service.handleStatusReport(dto);

      expect(result).toEqual({
        success: true,
        deviceId: 'dev-001',
      });
    });
  });

  describe('handleBindCallback', () => {
    it('should return success with bound status', async () => {
      const dto: VendorBindDto = {
        deviceId: 'dev-001',
        serialNumber: 'SN123456',
        bound: true,
        userOpenid: 'openid-xxx',
      };

      const result = await service.handleBindCallback(dto);

      expect(result).toEqual({
        success: true,
        deviceId: 'dev-001',
        bound: true,
      });
    });

    it('should default bound to true when omitted', async () => {
      const dto: VendorBindDto = {
        deviceId: 'dev-002',
      };

      const result = await service.handleBindCallback(dto);

      expect(result.bound).toBe(true);
    });
  });

  describe('handleConversationBackup', () => {
    it('should return success with idempotency key', async () => {
      const dto: VendorConversationDto = {
        deviceId: 'dev-001',
        userText: '你好',
        aiText: '你好呀',
        startedAt: Date.now(),
        endedAt: Date.now(),
      };

      const result = await service.handleConversationBackup(dto, 'key-001');

      expect(result).toEqual({
        success: true,
        idempotencyKey: 'key-001',
      });
    });

    it('should handle missing idempotency key', async () => {
      const dto: VendorConversationDto = {
        deviceId: 'dev-001',
        userText: '你好',
        aiText: '你好呀',
      };

      const result = await service.handleConversationBackup(dto);

      expect(result).toEqual({
        success: true,
        idempotencyKey: null,
      });
    });
  });

  describe('getHealth', () => {
    it('should return up status and timestamp', () => {
      const before = Date.now();
      const result = service.getHealth();
      const after = Date.now();

      expect(result.status).toBe('up');
      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(after);
      expect(result.expectedRecovery).toBeNull();
    });
  });
});
