import { Test, TestingModule } from "@nestjs/testing";
import { LearningStatsService } from "./learning-stats.service";
import { PrismaService } from "@/common/prisma/prisma.service";

describe("LearningStatsService", () => {
  let service: LearningStatsService;
  let prisma: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LearningStatsService,
        {
          provide: PrismaService,
          useValue: {
            userDeviceBinding: {
              findMany: jest.fn(),
            },
            deviceConfig: {
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

    service = module.get<LearningStatsService>(LearningStatsService);
    prisma = module.get(PrismaService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  const mockBindings = [
    {
      device: {
        id: "device-uuid-001",
        deviceId: "dev-001",
        name: "DEV001",
      },
    },
  ];

  describe("getDashboard", () => {
    it("should return dashboard metrics for bound devices", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
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
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",

          asrText: "Hello",
          aiReply: "Hi",
          spokeAt: new Date(),
        },
      ]);

      const result = await service.getDashboard("user-001");

      expect(result.boundDeviceCount).toBe(1);
      expect(result.totalSessions).toBe(1);
      expect(result.devices).toHaveLength(1);
      expect(result.devices[0].deviceId).toBe("dev-001");
    });

    it("should return empty dashboard when user has no bound devices in production", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      prisma.userDeviceBinding.findMany.mockResolvedValue([]);

      const result = await service.getDashboard("user-001");

      expect(result.boundDeviceCount).toBe(0);
      expect(result.devices).toEqual([]);

      process.env.NODE_ENV = originalNodeEnv;
    });
  });

  describe("getDailyTrend", () => {
    it("should return daily trend for last N days", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "free_chat",
          textbookId: null,
          unitId: null,
        },
      ]);
      prisma.conversation.findMany.mockResolvedValue([
        {
          id: "conv-001",
          deviceId: "device-uuid-001",
          mode: "free_chat",
          textbookId: null,
          unitId: null,

          asrText: "Hi",
          aiReply: "Hello",
          spokeAt: new Date(),
        },
      ]);

      const result = await service.getDailyTrend("user-001", undefined, 7);

      expect(result).toHaveLength(7);
      expect(result[6].sessionCount).toBe(1);
    });
  });

  describe("getTopicBreakdown", () => {
    it("should group conversations by mode/textbook/unit", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
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
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",

          asrText: "Hello",
          aiReply: "Hi",
          spokeAt: new Date(),
        },
        {
          id: "conv-002",
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",

          asrText: "How are you",
          aiReply: "Fine",
          spokeAt: new Date(),
        },
      ]);

      const result = await service.getTopicBreakdown("user-001");

      expect(result).toHaveLength(1);
      expect(result[0].count).toBe(2);
      expect(result[0].isActive).toBe(true);
    });
  });

  describe("getTimeline", () => {
    it("should return paginated timeline events", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "free_chat",
          textbookId: null,
          unitId: null,
        },
      ]);
      prisma.conversation.findMany.mockResolvedValue([
        {
          id: "conv-001",
          deviceId: "device-uuid-001",
          mode: "free_chat",
          textbookId: null,
          unitId: null,
          asrText: "Hello",
          aiReply: "Hi Lebron",
          spokeAt: new Date(),
        },
      ]);
      prisma.conversation.count.mockResolvedValue(1);

      const result = await service.getTimeline("user-001", undefined, 1, 10);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].userText).toBe("Hello");
      expect(result.items[0].aiText).toBe("Hi Lebron");
      expect(result.total).toBe(1);
    });
  });
});
