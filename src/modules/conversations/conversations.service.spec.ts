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
              findFirst: jest.fn(),
            },
            deviceConfig: {
              findMany: jest.fn(),
            },
            conversation: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              updateMany: jest.fn(),
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

  const mockBindings = [
    { device: { id: "device-uuid-001", deviceId: "dev-001" } },
    { device: { id: "device-uuid-002", deviceId: "dev-002" } },
  ];

  describe("list", () => {
    it("should return only conversations from bound devices matching active config", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
        {
          deviceId: "device-uuid-002",
          mode: "free_chat",
          textbookId: null,
          unitId: null,
        },
      ]);
      prisma.conversation.findMany.mockResolvedValue([
        {
          id: "conv-001",
          deviceId: "device-uuid-001",
          asrText: "unit 1 user",
          aiReply: "unit 1 ai",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
          spokeAt: new Date("2026-01-01"),
        },
        {
          id: "conv-002",
          deviceId: "device-uuid-002",
          asrText: "free chat user",
          aiReply: "free chat ai",
          mode: "free_chat",
          textbookId: null,
          unitId: null,
          spokeAt: new Date("2026-01-02"),
        },
      ]);
      prisma.conversation.count.mockResolvedValue(2);

      const result = await service.list("user-001", {});

      expect(prisma.userDeviceBinding.findMany).toHaveBeenCalledWith({
        where: { userId: "user-001" },
        include: { device: true },
      });
      expect(prisma.deviceConfig.findMany).toHaveBeenCalledWith({
        where: {
          deviceId: { in: ["device-uuid-001", "device-uuid-002"] },
          isActive: true,
        },
      });
      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            deletedAt: null,
            deviceId: { in: ["device-uuid-001", "device-uuid-002"] },
            OR: [
              {
                deviceId: "device-uuid-001",
                mode: "locked_unit",
                textbookId: "book-a",
                unitId: "unit-1",
              },
              {
                deviceId: "device-uuid-002",
                mode: "free_chat",
              },
            ],
          },
          orderBy: { spokeAt: "asc" },
          skip: 0,
          take: 20,
        }),
      );
      expect(result.items).toHaveLength(4);
      expect(result.total).toBe(2);
    });

    it("should exclude conversations from different mode/unit than active config", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        { device: { id: "device-uuid-001", deviceId: "dev-001" } },
      ]);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.conversation.findMany.mockResolvedValue([
        {
          id: "conv-001",
          deviceId: "device-uuid-001",
          asrText: "unit 1",
          aiReply: "reply 1",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
          spokeAt: new Date("2026-01-01"),
        },
      ]);
      prisma.conversation.count.mockResolvedValue(1);

      const result = await service.list("user-001", {});

      // The service should build a filter that excludes unit-2 conversations.
      // We assert the OR filter only contains the active config match.
      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            deletedAt: null,
            deviceId: { in: ["device-uuid-001"] },
            OR: [
              {
                deviceId: "device-uuid-001",
                mode: "locked_unit",
                textbookId: "book-a",
                unitId: "unit-1",
              },
            ],
          },
        }),
      );
      expect(result.items).toHaveLength(2);
    });

    it("should filter by deviceId when provided and bound", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.conversation.findMany.mockResolvedValue([]);
      prisma.conversation.count.mockResolvedValue(0);

      await service.list("user-001", { deviceId: "dev-001" });

      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            deletedAt: null,
            deviceId: { in: ["device-uuid-001"] },
            OR: [
              {
                deviceId: "device-uuid-001",
                mode: "locked_unit",
                textbookId: "book-a",
                unitId: "unit-1",
              },
            ],
          },
        }),
      );
    });

    it("should return empty when deviceId does not belong to user", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);

      const result = await service.list("user-001", { deviceId: "dev-999" });

      expect(prisma.conversation.findMany).not.toHaveBeenCalled();
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("should return empty when user has no bound devices in production", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      prisma.userDeviceBinding.findMany.mockResolvedValue([]);

      const result = await service.list("user-001", {});

      expect(prisma.conversation.findMany).not.toHaveBeenCalled();
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);

      process.env.NODE_ENV = originalNodeEnv;
    });

    it("should return all conversations in development when user has no bindings", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      prisma.userDeviceBinding.findMany.mockResolvedValue([]);
      prisma.deviceConfig.findMany.mockResolvedValue([]);
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

    it("should only return DEV001 device conversations in development workaround", async () => {
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
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.conversation.findMany.mockResolvedValue([]);
      prisma.conversation.count.mockResolvedValue(0);

      await service.list("user-001", {});

      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            deletedAt: null,
            deviceId: { in: ["device-uuid-001"] },
            OR: [
              {
                deviceId: "device-uuid-001",
                mode: "locked_unit",
                textbookId: "book-a",
                unitId: "unit-1",
              },
            ],
          },
        }),
      );

      process.env.NODE_ENV = originalNodeEnv;
    });
  });

  describe("remove", () => {
    it("should soft-delete conversation when it belongs to user and matches active config", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        { device: { id: "device-uuid-001", deviceId: "dev-001" } },
      ]);
      prisma.userDeviceBinding.findFirst.mockResolvedValue({
        id: "binding-001",
        userId: "user-001",
        deviceId: "device-uuid-001",
      });
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.conversation.findUnique.mockResolvedValue({
        id: "conv-001",
        deviceId: "device-uuid-001",
        mode: "locked_unit",
        textbookId: "book-a",
        unitId: "unit-1",
        deletedAt: null,
      });
      prisma.conversation.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.remove("user-001", "conv-001");

      expect(prisma.conversation.findUnique).toHaveBeenCalledWith({
        where: { id: "conv-001" },
      });
      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: {
          id: "conv-001",
          deviceId: "device-uuid-001",
          deletedAt: null,
        },
        data: { deletedAt: expect.any(Date) },
      });
      expect(result).toEqual({ success: true });
    });

    it("should reject removal when conversation does not match active config", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        { device: { id: "device-uuid-001", deviceId: "dev-001" } },
      ]);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.conversation.findUnique.mockResolvedValue({
        id: "conv-002",
        deviceId: "device-uuid-001",
        mode: "locked_unit",
        textbookId: "book-a",
        unitId: "unit-2",
        deletedAt: null,
      });

      const result = await service.remove("user-001", "conv-002");

      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("should reject removal when conversation belongs to unbound device", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        { device: { id: "device-uuid-001", deviceId: "dev-001" } },
      ]);
      prisma.deviceConfig.findMany.mockResolvedValue([]);
      prisma.conversation.findUnique.mockResolvedValue({
        id: "conv-003",
        deviceId: "device-uuid-999",
        mode: "locked_unit",
        textbookId: "book-a",
        unitId: "unit-1",
        deletedAt: null,
      });

      const result = await service.remove("user-001", "conv-003");

      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  describe("clearByDate", () => {
    it("should clear conversations for bound device matching active config and date", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        { device: { id: "device-uuid-001", deviceId: "dev-001" } },
      ]);
      prisma.userDeviceBinding.findFirst.mockResolvedValue({
        id: "binding-001",
        userId: "user-001",
        deviceId: "device-uuid-001",
        device: { id: "device-uuid-001", deviceId: "dev-001" },
      });
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.conversation.updateMany.mockResolvedValue({ count: 3 });

      const result = await service.clearByDate("user-001", "dev-001", "2026-01-01");

      expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
        where: {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
          deletedAt: null,
          spokeAt: {
            gte: new Date("2026-01-01T00:00:00.000Z"),
            lt: new Date("2026-01-01T23:59:59.999Z"),
          },
        },
        data: { deletedAt: expect.any(Date) },
      });
      expect(result).toEqual({ success: true, cleared: 3 });
    });

    it("should reject clear when device does not belong to user", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        { device: { id: "device-uuid-001", deviceId: "dev-001" } },
      ]);

      const result = await service.clearByDate("user-001", "dev-999", "2026-01-01");

      expect(prisma.conversation.updateMany).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });
});
