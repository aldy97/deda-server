import { Test, TestingModule } from '@nestjs/testing';
import { VendorService } from './vendor.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { VendorTextInDto } from './dto/vendor-text-in.dto';
import { VendorStatusDto } from './dto/vendor-status.dto';
import { VendorBindDto } from './dto/vendor-bind.dto';
import { VendorConversationDto } from './dto/vendor-conversation.dto';

describe('VendorService', () => {
  let service: VendorService;
  let prisma: any;

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
            conversation: {
              create: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<VendorService>(VendorService);
    prisma = module.get(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('handleTextIn', () => {
    it('should echo back a structured text response, ensure device exists, and persist conversation', async () => {
      const dto: VendorTextInDto = {
        deviceId: 'dev-001',
        asrText: '你好',
      };

      prisma.device.findUnique.mockResolvedValue(null);
      prisma.device.create.mockResolvedValue({ id: 'uuid-001', deviceId: 'dev-001' } as any);
      prisma.conversation.create.mockResolvedValue({ id: 'conv-001' } as any);

      const result = await service.handleTextIn(dto);

      expect(prisma.device.findUnique).toHaveBeenCalledWith({ where: { deviceId: 'dev-001' } });
      expect(prisma.device.create).toHaveBeenCalledWith({ data: { deviceId: 'dev-001' } });
      expect(prisma.conversation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deviceId: 'uuid-001',
            asrText: '你好',
            aiReply: '收到：你好',
          }),
        }),
      );
      expect(result).toEqual({
        deviceId: 'dev-001',
        responseText: '收到：你好',
        context: {},
        ttsOptions: {},
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
      prisma.conversation.create.mockResolvedValue({ id: 'conv-002' } as any);

      const result = await service.handleTextIn(dto);

      expect(prisma.device.create).not.toHaveBeenCalled();
      expect(result.deviceId).toBe('dev-abc-123');
      expect(result.responseText).toBe('收到：Hello');
      expect(result.context).toEqual({});
      expect(result.ttsOptions).toEqual({});
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
