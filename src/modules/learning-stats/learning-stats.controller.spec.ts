import {
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import * as request from "supertest";
import { ResponseInterceptor } from "@/common/interceptors/response.interceptor";
import { HttpExceptionFilter } from "@/common/filters/http-exception.filter";
import { JwtAuthGuard } from "@/modules/users/guards/jwt-auth.guard";
import { LearningStatsController } from "./learning-stats.controller";
import { LearningStatsService } from "./learning-stats.service";

describe("LearningStatsController", () => {
  let controller: LearningStatsController;
  let service: any;
  let testingModule: TestingModule;
  let app: INestApplication | undefined;

  beforeEach(async () => {
    testingModule = await Test.createTestingModule({
      controllers: [LearningStatsController],
      providers: [
        {
          provide: LearningStatsService,
          useValue: {
            getDashboard: jest.fn(),
            getDailyTrend: jest.fn(),
            getTopicBreakdown: jest.fn(),
            getTimeline: jest.fn(),
            getInsights: jest.fn(),
            getHealth: jest.fn(),
            getModeUsage: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest();
          if (req.headers.authorization !== "Bearer valid-token") {
            throw new UnauthorizedException("Unauthorized");
          }
          req.user = { userId: "user-001", openid: "openid-001" };
          return true;
        },
      })
      .compile();

    controller = testingModule.get<LearningStatsController>(
      LearningStatsController,
    );
    service = testingModule.get(LearningStatsService);
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
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
          mode: undefined,
          conversationModeKey: undefined,
        },
      );
      expect(result).toBe(trend);
    });

    it("should pass scope=all through without changing legacy query fields", async () => {
      const req = { user: { userId: "user-001" } } as Parameters<
        typeof controller.daily
      >[0];
      service.getDailyTrend.mockResolvedValue([]);

      await controller.daily(req, {
        deviceId: "dev-001",
        days: "7",
        scope: "all",
      });

      expect(service.getDailyTrend).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
        7,
        {
          mode: undefined,
          conversationModeKey: undefined,
          scope: "all",
        },
      );
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

  describe("parent reports", () => {
    beforeEach(async () => {
      service.submitParentReportFeedback = jest.fn();
      app = testingModule.createNestApplication();
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          transform: true,
          forbidNonWhitelisted: true,
        }),
      );
      app.useGlobalInterceptors(new ResponseInterceptor());
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();
    });

    it("should return the requested daily parent report", async () => {
      const req = { user: { userId: "user-001" } } as any;
      const report = { deviceId: "dev-001", reportDate: "2026-10-30" };
      service.getParentReport = jest.fn().mockResolvedValue(report);

      const result = await controller.parentReport(req, {
        deviceId: "dev-001",
        date: "2026-10-30",
      });

      expect(service.getParentReport).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
        "2026-10-30",
      );
      expect(result).toBe(report);
    });

    it("should submit feedback with HTTP 200 and the exact response contract", async () => {
      service.submitParentReportFeedback.mockResolvedValue({
        reportDate: "2026-10-31",
        feedback: "useful",
      });

      const response = await request(app!.getHttpServer())
        .post("/learning-stats/parent-report/feedback")
        .set("Authorization", "Bearer valid-token")
        .send({
          deviceId: "dev-local-001",
          reportDate: "2026-10-31",
          useful: true,
        })
        .expect(200);

      expect(response.body).toEqual({
        code: 0,
        message: "success",
        data: { reportDate: "2026-10-31", feedback: "useful" },
      });
      expect(service.submitParentReportFeedback).toHaveBeenCalledWith(
        "user-001",
        "dev-local-001",
        "2026-10-31",
        true,
      );
    });

    it.each(["", "Bearer invalid-token"])(
      "should reject missing or invalid JWT",
      async (authorization) => {
        const req = request(app!.getHttpServer()).post(
          "/learning-stats/parent-report/feedback",
        );
        if (authorization) req.set("Authorization", authorization);
        await req
          .send({ deviceId: "dev-001", reportDate: "2026-10-31", useful: true })
          .expect(401);
        expect(service.submitParentReportFeedback).not.toHaveBeenCalled();
      },
    );

    it.each([
      { deviceId: "", reportDate: "2026-10-31", useful: true },
      { deviceId: "dev-001", reportDate: "10/31/2026", useful: true },
      { deviceId: "dev-001", reportDate: "2026-10-31", useful: "true" },
      { deviceId: "dev-001", reportDate: "2026-10-31", useful: "false" },
      { deviceId: "dev-001", reportDate: "2026-10-31", useful: 0 },
      { deviceId: "dev-001", reportDate: "2026-10-31", useful: 1 },
      { deviceId: "dev-001", reportDate: "2026-10-31", useful: null },
      {
        deviceId: "dev-001",
        reportDate: "2026-10-31",
        useful: true,
        userId: "forged-user",
      },
    ])("should reject invalid feedback input", async (body) => {
      await request(app!.getHttpServer())
        .post("/learning-stats/parent-report/feedback")
        .set("Authorization", "Bearer valid-token")
        .send(body)
        .expect(400);
      expect(service.submitParentReportFeedback).not.toHaveBeenCalled();
    });
  });

  describe("mode usage", () => {
    beforeEach(async () => {
      app = testingModule.createNestApplication();
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          transform: true,
          forbidNonWhitelisted: true,
        }),
      );
      app.useGlobalInterceptors(new ResponseInterceptor());
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();
    });

    it("should return mode usage with default days when only deviceId is given", async () => {
      const usage = {
        deviceId: "dev-001",
        startDate: "2026-10-26",
        endDate: "2026-11-01",
        actualDays: 7,
        totalCount: 21,
        modeUsage: [{ mode: "free_chat", count: 21 }],
      };
      service.getModeUsage.mockResolvedValue(usage);

      const response = await request(app!.getHttpServer())
        .get("/learning-stats/mode-usage?deviceId=dev-001")
        .set("Authorization", "Bearer valid-token")
        .expect(200);

      expect(response.body).toEqual({
        code: 0,
        message: "success",
        data: usage,
      });
      expect(service.getModeUsage).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
        7,
        undefined,
      );
    });

    it("should pass explicit days and endDate through to the service", async () => {
      service.getModeUsage.mockResolvedValue({});

      await request(app!.getHttpServer())
        .get(
          "/learning-stats/mode-usage?deviceId=dev-001&days=7&endDate=2026-11-01",
        )
        .set("Authorization", "Bearer valid-token")
        .expect(200);

      expect(service.getModeUsage).toHaveBeenCalledWith(
        "user-001",
        "dev-001",
        7,
        "2026-11-01",
      );
    });

    it("should reject requests without a valid JWT", async () => {
      await request(app!.getHttpServer())
        .get("/learning-stats/mode-usage?deviceId=dev-001")
        .expect(401);
      expect(service.getModeUsage).not.toHaveBeenCalled();
    });

    it.each([
      "",
      "?days=7",
      "?deviceId=",
      "?deviceId=dev-001&days=abc",
      "?deviceId=dev-001&days=1.5",
      "?deviceId=dev-001&endDate=10/31/2026",
      "?deviceId=dev-001&foo=bar",
    ])("should reject invalid query: %s", async (query) => {
      await request(app!.getHttpServer())
        .get(`/learning-stats/mode-usage${query}`)
        .set("Authorization", "Bearer valid-token")
        .expect(400);
      expect(service.getModeUsage).not.toHaveBeenCalled();
    });
  });
});
