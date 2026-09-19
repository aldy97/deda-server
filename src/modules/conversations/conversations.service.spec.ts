import { Test, TestingModule } from '@nestjs/testing';
import { ConversationsService } from './conversations.service';
import { PrismaService } from '@/common/prisma/prisma.service';

describe('ConversationsService', () => {
  let service: ConversationsService;
  let prisma: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationsService,
        {
          provide: PrismaService,
          useValue: {
            userDeviceBinding: {
              findMany: jest.fn(),
            },
            conversation: {
              findMany: jest.fn(),
              count: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = module.get<ConversationsService>(ConversationsService);
    prisma = module.get(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('list', () => {
    it('should return conversations for user-bound devices ordered by spokeAt desc', async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        { device: { id: 'device-uuid-001', deviceId: 'dev-001' } },
      ]);
      prisma.conversation.findMany.mockResolvedValue([
        { id: 'conv-002', deviceId: 'device-uuid-001', asrText: '后说', spokeAt: new Date('2026-01-02') },
        { id: 'conv-001', deviceId: 'device-uuid-001', asrText: '先说', spokeAt: new Date('2026-01-01') },
      ]);
      prisma.conversation.count.mockResolvedValue(2);

      const result = await service.list('user-001', {});

      expect(prisma.userDeviceBinding.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-001' },
        include: { device: true },
      });
      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deviceId: { in: ['device-uuid-001'] }, deletedAt: null },
          orderBy: { spokeAt: 'desc' },
          skip: 0,
          take: 20,
        }),
      );
      expect(result.items).toHaveLength(2);
      expect(result.items[0].id).toBe('conv-002');
      expect(result.items[1].id).toBe('conv-001');
      expect(result.total).toBe(2);
    });

    it('should filter by deviceId when provided', async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        { device: { id: 'device-uuid-001', deviceId: 'dev-001' } },
        { device: { id: 'device-uuid-002', deviceId: 'dev-002' } },
      ]);
      prisma.conversation.findMany.mockResolvedValue([]);
      prisma.conversation.count.mockResolvedValue(0);

      await service.list('user-001', { deviceId: 'dev-001' });

      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deviceId: { in: ['device-uuid-001'] }, deletedAt: null },
        }),
      );
    });
  });
});
