import { Test, TestingModule } from "@nestjs/testing";
import { ConversationsService } from "./conversations.service";
import { PrismaService } from "@/common/prisma/prisma.service";

describe("ConversationsService", () => {
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

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("list", () => {
    it("should return chat records for user-bound devices ordered by spokeAt asc", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        { device: { id: "device-uuid-001", deviceId: "dev-001" } },
      ]);
      prisma.conversation.findMany.mockResolvedValue([
        {
          id: "conv-001",
          deviceId: "device-uuid-001",
          asrText: "先说",
          aiReply: "先答",
          spokeAt: new Date("2026-01-01"),
        },
        {
          id: "conv-002",
          deviceId: "device-uuid-001",
          asrText: "后说",
          aiReply: "后答",
          spokeAt: new Date("2026-01-02"),
        },
      ]);
      prisma.conversation.count.mockResolvedValue(2);

      const result = await service.list("user-001", {});

      expect(prisma.userDeviceBinding.findMany).toHaveBeenCalledWith({
        where: { userId: "user-001" },
        include: { device: true },
      });
      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deviceId: { in: ["device-uuid-001"] }, deletedAt: null },
          orderBy: { spokeAt: "asc" },
          skip: 0,
          take: 20,
        }),
      );
      // 每条 conversation 拆成 user + device 两条消息
      expect(result.items).toHaveLength(4);
      expect(result.items[0].role).toBe("user");
      expect(result.items[0].content).toBe("先说");
      expect(result.items[1].role).toBe("device");
      expect(result.items[1].content).toBe("先答");
      expect(result.total).toBe(2);
    });

    it("should filter by deviceId when provided", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        { device: { id: "device-uuid-001", deviceId: "dev-001" } },
        { device: { id: "device-uuid-002", deviceId: "dev-002" } },
      ]);
      prisma.conversation.findMany.mockResolvedValue([]);
      prisma.conversation.count.mockResolvedValue(0);

      await service.list("user-001", { deviceId: "dev-001" });

      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deviceId: { in: ["device-uuid-001"] }, deletedAt: null },
        }),
      );
    });

    it("should return all conversations in development when user has no bindings", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      prisma.userDeviceBinding.findMany.mockResolvedValue([]);
      prisma.conversation.findMany.mockResolvedValue([]);
      prisma.conversation.count.mockResolvedValue(0);

      await service.list("user-001", {});

      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null },
        }),
      );

      process.env.NODE_ENV = originalNodeEnv;
    });

    it("should return all conversations in development when user bound DEV001 (workaround)", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      prisma.userDeviceBinding.findMany.mockResolvedValue([
        {
          device: {
            id: "device-uuid-001",
            deviceId: "dev-local-001",
            deviceCode: "DEV001",
          },
        },
      ]);
      prisma.conversation.findMany.mockResolvedValue([]);
      prisma.conversation.count.mockResolvedValue(0);

      await service.list("user-001", {});

      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null },
        }),
      );

      process.env.NODE_ENV = originalNodeEnv;
    });
  });
});
