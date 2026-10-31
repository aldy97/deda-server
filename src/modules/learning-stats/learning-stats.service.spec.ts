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
            childProfile: {
              findMany: jest.fn().mockResolvedValue([]),
            },
            message: {
              findMany: jest.fn(),
              count: jest.fn(),
            },
            textbook: {
              findMany: jest.fn().mockResolvedValue([]),
            },
            unit: {
              findMany: jest.fn().mockResolvedValue([]),
            },
            conversationMode: {
              findMany: jest.fn().mockResolvedValue([]),
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

  const makeUserMessage = (
    id: string,
    turnId: string,
    content: string,
    extra: Record<string, any> = {},
  ) => ({
    id,
    deviceId: "device-uuid-001",
    turnId,
    role: "user",
    content,
    status: "completed",
    mode: "locked_unit",
    textbookId: "book-a",
    unitId: "unit-1",
    spokeAt: new Date(),
    ...extra,
  });

  describe("getDashboard", () => {
    it("should count turns by user messages for bound devices", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1-u", "t1", "Hello"),
      ]);

      const result = await service.getDashboard("user-001");

      // 统计口径：role='user' 的消息数 = 对话轮数
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ role: "user" }),
        }),
      );
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

    it("should include childName and childEnglishName from childProfile", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.childProfile.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          name: "二狗",
          englishName: "Lebron",
        },
      ]);
      prisma.message.findMany.mockResolvedValue([]);

      const result = await service.getDashboard("user-001");

      expect(result.devices[0].childName).toBe("二狗");
      expect(result.devices[0].childEnglishName).toBe("Lebron");
    });

    it("should expose maxContinuousDays across devices", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.message.findMany.mockResolvedValue([]);

      const result = await service.getDashboard("user-001");

      expect(result.maxContinuousDays).toBeGreaterThanOrEqual(0);
    });

    it("should scope dashboard to the requested deviceId", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1-u", "t1", "Hello"),
      ]);

      const result = await service.getDashboard("user-001", "dev-001");

      expect(result.boundDeviceCount).toBe(1);
      expect(result.totalSessions).toBe(1);
    });

    it("should return empty dashboard for an unbound deviceId", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);

      const result = await service.getDashboard("user-001", "dev-999");

      expect(result.boundDeviceCount).toBe(0);
      expect(result.devices).toEqual([]);
    });

    it("should scope metrics to today when range=today", async () => {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      // 第一次 findMany=基线统计（全量）,第二次=range 范围查询（mock 按 gte 过滤后的结果）
      prisma.message.findMany
        .mockResolvedValueOnce([
          makeUserMessage("m1-u", "t1", "today 1", { spokeAt: now }),
          makeUserMessage("m2-u", "t2", "today 2", { spokeAt: now }),
          makeUserMessage("m3-u", "t3", "old", { spokeAt: threeDaysAgo }),
        ])
        .mockResolvedValueOnce([
          makeUserMessage("m1-u", "t1", "today 1", { spokeAt: now }),
          makeUserMessage("m2-u", "t2", "today 2", { spokeAt: now }),
        ]);

      const result = await service.getDashboard("user-001", undefined, "today");

      // 范围统计不按 active config 过滤（回答「今天学了多少」）
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: "user",
            spokeAt: { gte: expect.any(Date) },
          }),
        }),
      );
      expect(result.practiceCount).toBe(2);
      expect(result.totalDurationMinutes).toBe(1); // 2 轮 × 0.5 分钟
      expect(result.topicCount).toBe(1);
    });

    it("should scope metrics to the last 7 days when range=week", async () => {
      const now = new Date();
      const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
      const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);

      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.message.findMany
        .mockResolvedValueOnce([
          makeUserMessage("m1-u", "t1", "today", { spokeAt: now }),
          makeUserMessage("m2-u", "t2", "3d ago unit-2", {
            spokeAt: threeDaysAgo,
            unitId: "unit-2",
          }),
          makeUserMessage("m3-u", "t3", "40d ago", { spokeAt: fortyDaysAgo }),
        ])
        .mockResolvedValueOnce([
          makeUserMessage("m1-u", "t1", "today", { spokeAt: now }),
          makeUserMessage("m2-u", "t2", "3d ago unit-2", {
            spokeAt: threeDaysAgo,
            unitId: "unit-2",
          }),
        ]);

      const result = await service.getDashboard("user-001", undefined, "week");

      expect(result.practiceCount).toBe(2);
      expect(result.topicCount).toBe(2); // unit-1 + unit-2
      expect(result.totalDurationMinutes).toBe(1);
    });

    it("should use calendar week (Monday) and calendar month boundaries", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([]);
      prisma.message.findMany.mockResolvedValue([]);

      const now = new Date();
      const monday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - ((now.getDay() + 6) % 7),
      );
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      await service.getDashboard("user-001", undefined, "week");
      let gte =
        prisma.message.findMany.mock.calls[
          prisma.message.findMany.mock.calls.length - 1
        ][0].where.spokeAt.gte;
      expect(gte.getTime()).toBe(monday.getTime());

      await service.getDashboard("user-001", undefined, "month");
      gte =
        prisma.message.findMany.mock.calls[
          prisma.message.findMany.mock.calls.length - 1
        ][0].where.spokeAt.gte;
      expect(gte.getTime()).toBe(monthStart.getTime());
    });

    it("should scope range metrics to an explicit textbookId", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([]);
      prisma.message.findMany.mockResolvedValue([]);

      await service.getDashboard("user-001", undefined, "week", {
        textbookId: "book-b",
      });

      const calls = prisma.message.findMany.mock.calls;
      const rangeCall = calls[calls.length - 1][0];
      expect(rangeCall.where).toEqual(
        expect.objectContaining({
          textbookId: "book-b",
          spokeAt: { gte: expect.any(Date) },
        }),
      );
    });

    it("should keep all-time semantics when range is omitted", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1-u", "t1", "Hello"),
      ]);

      const result = await service.getDashboard("user-001");

      // 兼容：不带 range 时无 practiceCount 字段语义,行为与现状一致
      expect(result.practiceCount ?? null).toBeNull();
      expect(result.totalSessions).toBe(1);
    });
  });

  describe("getUnitProgress", () => {
    it("should list progress for all practiced units, not only the active one", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1-u", "t1", "Hello"),
        makeUserMessage("m2-u", "t2", "Again"),
        makeUserMessage("m3-u", "t3", "unit2", { unitId: "unit-2" }),
        makeUserMessage("m4-u", "t4", "unit3", { unitId: "unit-3" }),
      ]);

      const result = await service.getUnitProgress("user-001", "dev-001");

      expect(result).toHaveLength(3);
      const byUnit = new Map(result.map((r) => [r.unitId, r]));
      expect(byUnit.get("unit-1")?.conversationCount).toBe(2);
      expect(byUnit.get("unit-2")?.conversationCount).toBe(1);
      expect(byUnit.get("unit-3")?.conversationCount).toBe(1);
    });

    it("should return empty when user has no bound devices", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue([]);

      const result = await service.getUnitProgress("user-001", "dev-001");

      expect(result).toEqual([]);
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
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1-u", "t1", "Hi", {
          mode: "free_chat",
          textbookId: null,
          unitId: null,
        }),
      ]);

      const result = await service.getDailyTrend("user-001", undefined, 7);

      expect(result).toHaveLength(7);
      expect(result[6].sessionCount).toBe(1);
    });

    it("should count all textbook units (any textbook) and exclude free_chat on a textbook-mode device", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1-u", "t1", "unit-1 turn"),
        makeUserMessage("m2-u", "t2", "unit-2 turn", { unitId: "unit-2" }),
        makeUserMessage("m3-u", "t3", "other textbook", {
          textbookId: "book-b",
          unitId: "unit-1",
        }),
        makeUserMessage("m4-u", "t4", "free chat turn", {
          mode: "free_chat",
          textbookId: null,
          unitId: null,
          conversationModeKey: "free_chat_casual",
        }),
      ]);

      const result = await service.getDailyTrend("user-001", undefined, 7);

      // 默认=当前配置模式族（教材族）:where 带 mode in [...],不按单元隔离
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: "user",
            mode: { in: ["locked_unit", "textbook_learning", "free_textbook"] },
          }),
        }),
      );
      // 3 轮教材（两单元两教材）计入,free_chat 排除:3×0.5=1.5→2 分钟
      expect(result[6].durationMinutes).toBe(2);
    });

    it("should scope daily to an explicit textbookId without touching device config", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.message.findMany.mockResolvedValue([]);

      await service.getDailyTrend("user-001", "dev-001", 7, {
        textbookId: "book-b",
      });

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            role: "user",
            textbookId: "book-b",
            mode: { in: ["locked_unit", "textbook_learning", "free_textbook"] },
          }),
        }),
      );
    });

    it("should scope daily to free_chat when mode is explicit", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([]);
      prisma.message.findMany.mockResolvedValue([]);

      await service.getDailyTrend("user-001", "dev-001", 7, {
        mode: "free_chat",
        conversationModeKey: "free_chat_casual",
      });

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            mode: "free_chat",
            conversationModeKey: "free_chat_casual",
          }),
        }),
      );
    });
  });

  describe("getTopicBreakdown", () => {
    it("should return all learned contexts, not only the active config", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1-u", "t1", "Hello"),
        makeUserMessage("m2-u", "t2", "How are you"),
        // unit-2 不在当前 active config,但属全量学习语境,应出现
        makeUserMessage("m3-u", "t3", "seasons", { unitId: "unit-2" }),
      ]);

      const result = await service.getTopicBreakdown("user-001");

      // 全量：不按 active config 过滤（无 OR 过滤条件）
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.not.objectContaining({ OR: expect.anything() }),
        }),
      );
      expect(result).toHaveLength(2);
      const u1 = result.find((t) => t.unitId === "unit-1");
      const u2 = result.find((t) => t.unitId === "unit-2");
      expect(u1).toEqual(expect.objectContaining({ count: 2, isActive: true }));
      expect(u2).toEqual(
        expect.objectContaining({ count: 1, isActive: false }),
      );
    });

    it("should attach a real heuristic score per topic", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1-u", "t1", "I want to play football today"),
        makeUserMessage("m2-u", "t2", "My mother cooks noodles every day"),
        makeUserMessage("m3-u", "t3", "我想说中文", { unitId: "unit-2" }),
      ]);

      const result = await service.getTopicBreakdown("user-001");

      const u1 = result.find((t) => t.unitId === "unit-1");
      const u2 = result.find((t) => t.unitId === "unit-2");
      expect(u1.avgScore).toBe(93); // 全英文,平均 6 词 → 70 + 6/8×30 ≈ 93
      expect(u2.avgScore).toBe(0); // 纯中文
    });

    it("should group free_chat by sub-mode with resolved names and no score", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "free_chat",
          textbookId: null,
          unitId: null,
          conversationModeKey: "free_chat_casual",
        },
      ]);
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1-u", "t1", "hello there my friend", {
          mode: "free_chat",
          textbookId: null,
          unitId: null,
          conversationModeKey: "free_chat_casual",
        }),
        makeUserMessage("m2-u", "t2", "once upon a time there was", {
          mode: "free_chat",
          textbookId: null,
          unitId: null,
          conversationModeKey: "free_chat_roleplay",
        }),
      ]);
      prisma.conversationMode.findMany.mockResolvedValue([
        { key: "free_chat_casual", name: "自由闲聊" },
        { key: "free_chat_roleplay", name: "角色扮演" },
      ]);

      const result = await service.getTopicBreakdown("user-001");

      expect(result).toHaveLength(2);
      const casual = result.find(
        (t) => t.conversationModeKey === "free_chat_casual",
      );
      const roleplay = result.find(
        (t) => t.conversationModeKey === "free_chat_roleplay",
      );
      expect(casual).toEqual(
        expect.objectContaining({
          conversationModeName: "自由闲聊",
          avgScore: null, // 自由对话不评分
          isActive: true,
        }),
      );
      expect(roleplay).toEqual(
        expect.objectContaining({
          conversationModeName: "角色扮演",
          avgScore: null,
          isActive: false,
        }),
      );
    });

    it("should resolve real textbook and unit names for textbook topics", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([]);
      prisma.textbook.findMany.mockResolvedValue([
        { id: "book-uuid", textbookId: "book-a", name: "Book A" },
      ]);
      prisma.unit.findMany.mockResolvedValue([
        { textbookId: "book-uuid", unitId: "unit-1", name: "Unit One" },
      ]);
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1-u", "t1", "hello"),
      ]);

      const result = await service.getTopicBreakdown("user-001");

      expect(result[0].textbookName).toBe("Book A");
      expect(result[0].unitName).toBe("Unit One");
    });
  });

  describe("getTimeline", () => {
    it("should assemble turns from user messages joined with assistant replies by turnId", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "free_chat",
          textbookId: null,
          unitId: null,
        },
      ]);
      // 第一次 findMany：role='user' 分页;第二次：按 turnId 取 assistant
      prisma.message.findMany
        .mockResolvedValueOnce([
          {
            ...makeUserMessage("m1-u", "t1", "Hello", {
              mode: "free_chat",
              textbookId: null,
              unitId: null,
            }),
            device: { deviceId: "dev-001", name: "DEV001" },
          },
        ])
        .mockResolvedValueOnce([
          {
            id: "m1-d",
            turnId: "t1",
            role: "assistant",
            content: "Hi Lebron",
            status: "completed",
            spokeAt: new Date(),
          },
        ]);
      prisma.message.count.mockResolvedValue(1);

      const result = await service.getTimeline("user-001", undefined, 1, 10);

      // 分页主查询只数 user 消息（轮数）
      expect(prisma.message.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ role: "user" }),
        }),
      );
      // assistant 按 turnId 关联
      expect(prisma.message.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: expect.objectContaining({
            role: "assistant",
            turnId: { in: ["t1"] },
          }),
        }),
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0].userText).toBe("Hello");
      expect(result.items[0].aiText).toBe("Hi Lebron");
      expect(result.total).toBe(1);
    });

    it("should leave aiText empty when the assistant reply failed or is missing", async () => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "free_chat",
          textbookId: null,
          unitId: null,
        },
      ]);
      prisma.message.findMany
        .mockResolvedValueOnce([
          {
            ...makeUserMessage("m1-u", "t1", "Hello", {
              mode: "free_chat",
              textbookId: null,
              unitId: null,
            }),
            device: { deviceId: "dev-001", name: "DEV001" },
          },
        ])
        .mockResolvedValueOnce([]); // 无 assistant 行
      prisma.message.count.mockResolvedValue(1);

      const result = await service.getTimeline("user-001", undefined, 1, 10);

      expect(result.items[0].userText).toBe("Hello");
      expect(result.items[0].aiText).toBe("");
    });
  });

  describe("getActivities", () => {
    const msg = (
      id: string,
      turnId: string,
      content: string,
      spokeAt: Date,
      extra: Record<string, any> = {},
    ) => ({
      id,
      deviceId: "device-uuid-001",
      turnId,
      role: "user",
      content,
      status: "completed",
      mode: "locked_unit",
      textbookId: "book-a",
      unitId: "unit-1",
      spokeAt,
      ...extra,
    });

    beforeEach(() => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([]);
      prisma.textbook.findMany.mockResolvedValue([
        { id: "book-uuid", textbookId: "book-a", name: "Book A" },
      ]);
      prisma.unit.findMany.mockResolvedValue([
        { textbookId: "book-uuid", unitId: "unit-1", name: "Unit One" },
        { textbookId: "book-uuid", unitId: "unit-2", name: "Unit Two" },
      ]);
    });

    it("should aggregate user messages into daily study cards with turn counts and names", async () => {
      prisma.message.findMany.mockResolvedValue([
        msg("m3", "t3", "third", new Date("2026-09-26T10:05:00")),
        msg("m2", "t2", "second", new Date("2026-09-26T10:00:00")),
        msg("m1", "t1", "first", new Date("2026-09-25T09:00:00")),
      ]);

      const result = await service.getActivities("user-001", "dev-001", {
        page: 1,
        pageSize: 10,
      });

      expect(result.total).toBe(2); // 两个活跃日
      expect(result.items[0].date).toBe("2026-09-26");
      const study = result.items[0].events.find((e: any) => e.type === "study");
      expect(study).toEqual(
        expect.objectContaining({
          type: "study",
          textbookId: "book-a",
          textbookName: "Book A",
          unitId: "unit-1",
          unitName: "Unit One",
          turnCount: 2,
        }),
      );
      expect(result.items[1].date).toBe("2026-09-25");
    });

    it("should emit an unlock card on the first practice day of a unit", async () => {
      prisma.message.findMany.mockResolvedValue([
        msg("m2", "t2", "u2 first", new Date("2026-09-20T10:00:00"), {
          unitId: "unit-2",
        }),
        msg("m1", "t1", "u1 again", new Date("2026-09-20T09:00:00")),
        msg("m0", "t0", "u1 first", new Date("2026-09-18T09:00:00")),
      ]);

      const result = await service.getActivities("user-001", "dev-001", {
        page: 1,
        pageSize: 10,
      });

      const day920 = result.items.find((d: any) => d.date === "2026-09-20");
      const unlock = day920.events.find((e: any) => e.type === "unlock");
      expect(unlock).toEqual(
        expect.objectContaining({
          type: "unlock",
          textbookId: "book-a",
          unitId: "unit-2",
          unitName: "Unit Two",
        }),
      );
      // unit-1 的首练在 9/18,unlock 卡应在那天
      const day918 = result.items.find((d: any) => d.date === "2026-09-18");
      expect(
        day918.events.some(
          (e: any) => e.type === "unlock" && e.unitId === "unit-1",
        ),
      ).toBe(true);
    });

    it("should emit a streak card on the last day of a consecutive run", async () => {
      prisma.message.findMany.mockResolvedValue([
        msg("m3", "t3", "d3", new Date("2026-09-20T10:00:00")),
        msg("m2", "t2", "d2", new Date("2026-09-19T10:00:00")),
        msg("m1", "t1", "d1", new Date("2026-09-18T10:00:00")),
      ]);

      const result = await service.getActivities("user-001", "dev-001", {
        page: 1,
        pageSize: 10,
      });

      const lastDay = result.items.find((d: any) => d.date === "2026-09-20");
      expect(lastDay.events).toContainEqual(
        expect.objectContaining({ type: "streak", streakDays: 3 }),
      );
      // 非连续日不产生 streak 卡
      expect(
        result.items
          .find((d: any) => d.date === "2026-09-18")
          .events.some((e: any) => e.type === "streak"),
      ).toBe(false);
    });

    it("should paginate by day in descending order", async () => {
      const rows = [];
      for (let day = 1; day <= 5; day++) {
        rows.push(
          msg(
            `m${day}`,
            `t${day}`,
            `d${day}`,
            new Date(`2026-09-0${day}T10:00:00`),
          ),
        );
      }
      prisma.message.findMany.mockResolvedValue(rows.reverse());

      const page1 = await service.getActivities("user-001", "dev-001", {
        page: 1,
        pageSize: 2,
      });
      const page2 = await service.getActivities("user-001", "dev-001", {
        page: 2,
        pageSize: 2,
      });

      expect(page1.total).toBe(5);
      expect(page1.items.map((d: any) => d.date)).toEqual([
        "2026-09-05",
        "2026-09-04",
      ]);
      expect(page2.items.map((d: any) => d.date)).toEqual([
        "2026-09-03",
        "2026-09-02",
      ]);
    });

    it("should return empty when no messages", async () => {
      prisma.message.findMany.mockResolvedValue([]);

      const result = await service.getActivities("user-001", "dev-001", {
        page: 1,
        pageSize: 10,
      });

      expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 10 });
    });

    it("should return empty for an unbound deviceId", async () => {
      const result = await service.getActivities("user-001", "dev-999", {
        page: 1,
        pageSize: 10,
      });

      expect(prisma.message.findMany).not.toHaveBeenCalled();
      expect(result.items).toEqual([]);
    });

    it("should filter days by range while computing streak/unlock on full history", async () => {
      const now = new Date();
      const monday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - ((now.getDay() + 6) % 7),
      );
      const inRange = new Date(monday.getTime() + 10 * 60 * 60 * 1000);
      const outRange = new Date(monday.getTime() - 24 * 60 * 60 * 1000); // 上周日

      prisma.message.findMany.mockResolvedValue([
        msg("m2", "t2", "this week", inRange),
        msg("m1", "t1", "last week", outRange),
      ]);

      const ranged = await service.getActivities("user-001", "dev-001", {
        page: 1,
        pageSize: 10,
        range: "week",
      });

      expect(ranged.total).toBe(1);
      expect(ranged.items).toHaveLength(1);
      expect(ranged.items[0].date).toBe(
        `${inRange.getFullYear()}-${String(inRange.getMonth() + 1).padStart(2, "0")}-${String(inRange.getDate()).padStart(2, "0")}`,
      );

      // 缺省 range = 全量（兼容）
      const all = await service.getActivities("user-001", "dev-001", {
        page: 1,
        pageSize: 10,
      });
      expect(all.total).toBe(2);
    });

    it("should scope activities to an explicit unit without touching device config", async () => {
      // mock 模拟 DB 侧过滤后的结果（where 断言证明过滤已下发）
      prisma.message.findMany.mockResolvedValue([
        msg("m2", "t2", "unit-2 turn", new Date("2026-09-20T10:00:00"), {
          unitId: "unit-2",
        }),
      ]);

      const result = await service.getActivities("user-001", "dev-001", {
        page: 1,
        pageSize: 10,
        unitId: "unit-2",
      });

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ role: "user", unitId: "unit-2" }),
        }),
      );
      expect(result.total).toBe(1);
      expect(result.items[0].date).toBe("2026-09-20");
    });
  });

  describe("getInsights", () => {
    beforeEach(() => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.textbook.findMany.mockResolvedValue([]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.conversationMode.findMany.mockResolvedValue([]);
    });

    it("should return insights based on dashboard and topics", async () => {
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1-u", "t1", "Hello"),
        makeUserMessage("m2-u", "t2", "World"),
      ]);

      const result = await service.getInsights("user-001", undefined, "week");

      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          type: expect.any(String),
          title: expect.any(String),
          content: expect.any(String),
        }),
      );
    });

    it("should limit insights to at most 3 items", async () => {
      // 连续 3 天 + 多主题 + 设备离线可产生超过 3 条,应截断
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1-u", "t1", "Hello", {
          spokeAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        }),
        makeUserMessage("m2-u", "t2", "World", {
          spokeAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        }),
        makeUserMessage("m3-u", "t3", "Today", {
          spokeAt: new Date(),
        }),
      ]);

      const result = await service.getInsights("user-001", undefined, "week");

      expect(result.length).toBeLessThanOrEqual(3);
    });
  });

  describe("getHealth", () => {
    beforeEach(() => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
      prisma.deviceConfig.findMany.mockResolvedValue([
        {
          deviceId: "device-uuid-001",
          mode: "locked_unit",
          textbookId: "book-a",
          unitId: "unit-1",
        },
      ]);
      prisma.textbook.findMany.mockResolvedValue([]);
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.conversationMode.findMany.mockResolvedValue([]);
    });

    it("should return health score with dimensions and suggestion", async () => {
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1-u", "t1", "Hello"),
      ]);

      const result = await service.getHealth("user-001", undefined, "week");

      expect(result).toEqual(
        expect.objectContaining({
          score: expect.any(Number),
          level: expect.any(String),
          dimensions: expect.objectContaining({
            activity: expect.any(Number),
            consistency: expect.any(Number),
            balance: expect.any(Number),
            engagement: expect.any(Number),
          }),
          suggestion: expect.any(String),
        }),
      );
    });

    it("should cap score when there is no learning today", async () => {
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1-u", "t1", "Hello", {
          spokeAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        }),
      ]);

      const result = await service.getHealth("user-001", undefined, "week");

      expect(result.score).toBeLessThanOrEqual(54);
      expect(result.suggestion).toContain("今天还没有学习记录");
    });
  });

  describe("parent reports", () => {
    beforeEach(() => {
      prisma.userDeviceBinding.findMany.mockResolvedValue(mockBindings);
    });

    it("should combine daily usage, mode distribution, stored summary and habit progress", async () => {
      prisma.device = {
        findUnique: jest.fn().mockResolvedValue({ timezone: "Asia/Shanghai" }),
      };
      prisma.learningStat = {
        findUnique: jest.fn().mockResolvedValue({ durationSeconds: 1200 }),
      };
      prisma.message.findMany.mockResolvedValue([
        makeUserMessage("m1", "t1", "讲个故事", { mode: "free_chat" }),
        makeUserMessage("m2", "t2", "继续聊", { mode: "free_chat" }),
        makeUserMessage("m3", "t3", "继续冒险", {
          mode: "adventure_story",
        }),
      ]);
      prisma.parentReport = {
        findUnique: jest.fn().mockResolvedValue({
          expressionObservation: "孩子主动发起了故事请求。",
          emotionObservation: null,
          thinkingObservation: null,
          suggestion: "明天继续接住孩子的故事想象。",
          feedback: "useful",
        }),
      };
      prisma.habitPlan = {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "habit-1",
            title: "睡前主动刷牙洗脸",
            targetDays: 21,
            dailyRecords: [
              { recordDate: "2026-10-29", completed: true },
              { recordDate: "2026-10-30", completed: true },
            ],
          },
        ]),
      };

      const result = await service.getParentReport(
        "user-001",
        "dev-001",
        "2026-10-30",
      );

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            spokeAt: {
              gte: new Date("2026-10-29T16:00:00Z"),
              lt: new Date("2026-10-30T16:00:00Z"),
            },
          }),
        }),
      );
      expect(result).toEqual({
        deviceId: "dev-001",
        reportDate: "2026-10-30",
        durationMinutes: 20,
        modeUsage: [
          { mode: "free_chat", count: 2 },
          { mode: "adventure_story", count: 1 },
        ],
        summary: {
          expressionObservation: "孩子主动发起了故事请求。",
          emotionObservation: null,
          thinkingObservation: null,
          suggestion: "明天继续接住孩子的故事想象。",
        },
        habits: [
          {
            planId: "habit-1",
            title: "睡前主动刷牙洗脸",
            targetDays: 21,
            completedDays: 2,
            todayCompleted: true,
          },
        ],
        feedback: "useful",
      });
    });

    it("should reject feedback when the device is not bound to the parent", async () => {
      await expect(
        service.submitParentReportFeedback(
          "user-001",
          "dev-999",
          "2026-10-30",
          true,
        ),
      ).rejects.toThrow("Device not bound");
    });

    it("should persist report feedback for the bound parent", async () => {
      prisma.parentReport = {
        findUnique: jest.fn().mockResolvedValue({ id: "report-1" }),
        update: jest.fn().mockResolvedValue({ feedback: "not_useful" }),
      };

      const result = await service.submitParentReportFeedback(
        "user-001",
        "dev-001",
        "2026-10-30",
        false,
      );

      expect(prisma.parentReport.update).toHaveBeenCalledWith({
        where: { id: "report-1" },
        data: {
          feedback: "not_useful",
          feedbackAt: expect.any(Date),
          feedbackUserId: "user-001",
        },
      });
      expect(result).toEqual({
        reportDate: "2026-10-30",
        feedback: "not_useful",
      });
    });
  });
});
