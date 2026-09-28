import { Test, TestingModule } from "@nestjs/testing";
import { LearningStatsController } from "./learning-stats.controller";
import { LearningStatsService } from "./learning-stats.service";

describe("LearningStatsController", () => {
  let controller: LearningStatsController;
  let service: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LearningStatsController],
      providers: [
        {
          provide: LearningStatsService,
          useValue: {
            getDashboard: jest.fn(),
            getDailyTrend: jest.fn(),
            getTopicBreakdown: jest.fn(),
            getTimeline: jest.fn(),
            getUnitProgress: jest.fn(),
            getInsights: jest.fn(),
            getHealth: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<LearningStatsController>(LearningStatsController);
    service = module.get(LearningStatsService);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("dashboard", () => {
    it("should call service.getDashboard with userId and deviceId", async () => {
      const req = { user: { userId: "user-001" } } as any;
      const dashboard = { totalSessions: 5, devices: [] } as any;
      service.getDashboard.mockResolvedValue(dashboard);

      const result = await controller.dashboard(req, { deviceId: "dev-001" });

      expect(service.getDashboard).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
        undefined,
        {
          textbookId: undefined,
          unitId: undefined,
          mode: undefined,
          conversationModeKey: undefined,
        },
      );
      expect(result).toBe(dashboard);
    });

    it("should pass range through to service.getDashboard", async () => {
      const req = { user: { userId: "user-001" } } as any;
      service.getDashboard.mockResolvedValue({} as any);

      await controller.dashboard(req, { deviceId: "dev-001", range: "week" });

      expect(service.getDashboard).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
        "week",
        {
          textbookId: undefined,
          unitId: undefined,
          mode: undefined,
          conversationModeKey: undefined,
        },
      );
    });
  });

  describe("daily", () => {
    it("should call service.getDailyTrend with userId, deviceId and days", async () => {
      const req = { user: { userId: "user-001" } } as any;
      const trend = [
        { date: "2026-09-25", durationMinutes: 10, sessionCount: 1 },
      ];
      service.getDailyTrend.mockResolvedValue(trend);

      const result = await controller.daily(req, {
        deviceId: "dev-001",
        days: "14",
      });

      expect(service.getDailyTrend).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
        14,
        {
          textbookId: undefined,
          unitId: undefined,
          mode: undefined,
          conversationModeKey: undefined,
        },
      );
      expect(result).toBe(trend);
    });
  });

  describe("topics", () => {
    it("should call service.getTopicBreakdown with userId and deviceId", async () => {
      const req = { user: { userId: "user-001" } } as any;
      const topics = [{ count: 3 }] as any;
      service.getTopicBreakdown.mockResolvedValue(topics);

      const result = await controller.topics(req, "dev-001");

      expect(service.getTopicBreakdown).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
      );
      expect(result).toBe(topics);
    });
  });

  describe("timeline", () => {
    it("should call service.getTimeline with pagination params", async () => {
      const req = { user: { userId: "user-001" } } as any;
      const timeline = { items: [], total: 0, page: 1, pageSize: 10 } as any;
      service.getTimeline.mockResolvedValue(timeline);

      const result = await controller.timeline(req, {
        deviceId: "dev-001",
        page: "1",
        pageSize: "10",
      });

      expect(service.getTimeline).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
        1,
        10,
      );
      expect(result).toBe(timeline);
    });
  });

  describe("activities", () => {
    it("should call service.getActivities with pagination and range", async () => {
      const req = { user: { userId: "user-001" } } as any;
      const page = { items: [], total: 0, page: 1, pageSize: 10 } as any;
      service.getActivities = jest.fn().mockResolvedValue(page);

      const result = await controller.activities(req, {
        deviceId: "dev-001",
        page: "1",
        pageSize: "10",
        range: "week",
      });

      expect(service.getActivities).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
        {
          page: 1,
          pageSize: 10,
          range: "week",
          textbookId: undefined,
          unitId: undefined,
          mode: undefined,
          conversationModeKey: undefined,
        },
      );
      expect(result).toBe(page);
    });
  });

  describe("insights", () => {
    it("should call service.getInsights with userId, deviceId and range", async () => {
      const req = { user: { userId: "user-001" } } as any;
      const insights = [{ id: "i1", type: "strength", title: "学习活跃" }];
      service.getInsights.mockResolvedValue(insights);

      const result = await controller.insights(req, {
        deviceId: "dev-001",
        range: "week",
      });

      expect(service.getInsights).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
        "week",
      );
      expect(result).toBe(insights);
    });
  });

  describe("health", () => {
    it("should call service.getHealth with userId, deviceId and range", async () => {
      const req = { user: { userId: "user-001" } } as any;
      const health = { score: 75, level: "good" };
      service.getHealth.mockResolvedValue(health);

      const result = await controller.health(req, {
        deviceId: "dev-001",
        range: "week",
      });

      expect(service.getHealth).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
        "week",
      );
      expect(result).toBe(health);
    });
  });
});
