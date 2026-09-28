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
            message: {
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

  const mockBindings = [
    { device: { id: "device-uuid-001", deviceId: "dev-001" } },
    { device: { id: "device-uuid-002", deviceId: "dev-002" } },
  ];

  const makeMessage = (
    id: string,
    turnId: string,
    role: "user" | "assistant",
    content: string,
    spokeAt: Date,
    extra: Record<string, any> = {},
  ) => ({
    id,
    deviceId: "device-uuid-001",
    turnId,
    role,
    content,
    status: "completed",
    textbookId: "book-a",
    unitId: "unit-1",
    mode: "locked_unit",
    conversationModeKey: null,
    spokeAt,
    ...extra,
  });

  describe("list", () => {
    it("should map message rows directly to chat records with role mapping", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      // DB desc：每轮内 assistant 比 user 晚 1s,整体最新在前
      prisma.message.findMany.mockResolvedValue([
        makeMessage(
          "m2-d",
          "t2",
          "assistant",
          "reply 2",
          new Date("2026-01-02T00:00:01Z"),
          {
            deviceId: "device-uuid-002",
            mode: "free_chat",
            textbookId: null,
            unitId: null,
          },
        ),
        makeMessage(
          "m2-u",
          "t2",
          "user",
          "question 2",
          new Date("2026-01-02T00:00:00Z"),
          {
            deviceId: "device-uuid-002",
            mode: "free_chat",
            textbookId: null,
            unitId: null,
          },
        ),
        makeMessage(
          "m1-d",
          "t1",
          "assistant",
          "reply 1",
          new Date("2026-01-01T00:00:01Z"),
        ),
        makeMessage(
          "m1-u",
          "t1",
          "user",
          "question 1",
          new Date("2026-01-01T00:00:00Z"),
        ),
      ]);
      prisma.message.count.mockResolvedValue(4);

      const result = await service.list("user-001", {});

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deviceId: { in: ["device-uuid-001", "device-uuid-002"] } },
          orderBy: { spokeAt: "desc" },
          skip: 0,
          take: 20,
        }),
      );
      // 页内正序（顶老底新）,assistant 映射为 device 角色,id 裸用无后缀
      expect(result.items).toEqual([
        {
          id: "m1-u",
          role: "user",
          content: "question 1",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m1-d",
          role: "device",
          content: "reply 1",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "m2-u",
          role: "user",
          content: "question 2",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "m2-d",
          role: "device",
          content: "reply 2",
          createdAt: "2026-01-02T00:00:01.000Z",
        },
      ]);
      // total 语义 = 消息条数
      expect(result.total).toBe(4);
    });

    it("should filter by deviceId + textbookId + unitId", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        { device: { id: "device-uuid-001", deviceId: "dev-001" } },
      ]);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);

      await service.list("user-001", {
        deviceId: "dev-001",
        textbookId: "book-a",
        unitId: "unit-1",
      });

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            deviceId: { in: ["device-uuid-001"] },
            textbookId: "book-a",
            unitId: "unit-1",
          },
          orderBy: { spokeAt: "desc" },
        }),
      );
    });

    it("should filter by conversationModeKey", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([
        { device: { id: "device-uuid-001", deviceId: "dev-001" } },
      ]);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);

      await service.list("user-001", {
        deviceId: "dev-001",
        conversationModeKey: "free_chat_casual",
      });

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            deviceId: { in: ["device-uuid-001"] },
            conversationModeKey: "free_chat_casual",
          },
        }),
      );
    });

    it("should return empty when deviceId does not belong to user", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);

      const result = await service.list("user-001", { deviceId: "dev-999" });

      expect(prisma.message.findMany).not.toHaveBeenCalled();
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("should return empty when user has no bound devices in production", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      prisma.userDeviceBinding.findMany.mockResolvedValue([]);

      const result = await service.list("user-001", {});

      expect(prisma.message.findMany).not.toHaveBeenCalled();
      expect(result.items).toEqual([]);

      process.env.NODE_ENV = originalNodeEnv;
    });

    it("should return all messages in development when user has no bindings", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";

      prisma.userDeviceBinding.findMany.mockResolvedValue([]);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.count.mockResolvedValue(0);

      await service.list("user-001", {});

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {},
          orderBy: { spokeAt: "desc" },
        }),
      );

      process.env.NODE_ENV = originalNodeEnv;
    });
  });
});
