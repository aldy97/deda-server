import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmAnalyticsService } from "./llm-analytics.service";

/** createdAt 落在北京时间某天：构造当天 10:00 CST 的 UTC 时间 */
function at(dateKey: string): Date {
  return new Date(`${dateKey}T02:00:00.000Z`);
}

function logRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    scene: "chat_main",
    tier: "main",
    success: true,
    failureReason: null,
    latencyMs: 1000,
    firstTokenMs: 300,
    totalTokens: 100,
    createdAt: at("2026-11-07"),
    ...overrides,
  };
}

describe("LlmAnalyticsService", () => {
  let service: LlmAnalyticsService;
  let prisma: {
    llmUsageLog: { findMany: jest.Mock; count: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      llmUsageLog: {
        findMany: jest.fn((_args?: unknown) => Promise.resolve([])),
        count: jest.fn((_args?: unknown) => Promise.resolve(0)),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmAnalyticsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(LlmAnalyticsService);
  });

  describe("getSummary", () => {
    it("rejects invalid dates and inverted ranges with 400", async () => {
      await expect(
        service.getSummary({ startDate: "2026-13-01", endDate: "2026-11-01" }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.getSummary({ startDate: "2026-11-08", endDate: "2026-11-07" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("returns empty scenes when no rows", async () => {
      const result = await service.getSummary({
        startDate: "2026-11-07",
        endDate: "2026-11-07",
      });
      expect(result).toEqual({ scenes: [] });
    });

    it("aggregates per scene: rate, percentiles, tokens, failure breakdown", async () => {
      prisma.llmUsageLog.findMany.mockResolvedValue([
        logRow({ latencyMs: 1000, firstTokenMs: 300, totalTokens: 100 }),
        logRow({ latencyMs: 3000, firstTokenMs: 900, totalTokens: 200 }),
        logRow({
          success: false,
          failureReason: "timeout",
          latencyMs: 5000,
          firstTokenMs: null,
          totalTokens: null,
        }),
        logRow({
          scene: "safety_l2",
          tier: "small",
          success: false,
          failureReason: "upstream_error",
          latencyMs: null,
          firstTokenMs: null,
          totalTokens: null,
        }),
      ]);

      const result = await service.getSummary({
        startDate: "2026-11-07",
        endDate: "2026-11-07",
      });

      const chatMain = result.scenes.find((s) => s.scene === "chat_main");
      expect(chatMain).toMatchObject({
        tier: "main",
        calls: 3,
        successRate: 0.6667,
        totalTokens: 300,
        failureBreakdown: [{ reason: "timeout", count: 1 }],
      });
      // percentile_cont([1000,3000,5000], .5)=3000, .9=4600
      expect(chatMain?.p50LatencyMs).toBe(3000);
      expect(chatMain?.p90LatencyMs).toBeCloseTo(4600);
      // firstToken 只有两个有效值
      expect(chatMain?.p50FirstTokenMs).toBe(600);
      expect(chatMain?.p90FirstTokenMs).toBeCloseTo(840);

      const safety = result.scenes.find((s) => s.scene === "safety_l2");
      expect(safety).toMatchObject({
        tier: "small",
        calls: 1,
        successRate: 0,
        p50LatencyMs: null,
        p50FirstTokenMs: null,
        totalTokens: 0,
        failureBreakdown: [{ reason: "upstream_error", count: 1 }],
      });
    });

    it("queries rows within Asia/Shanghai day boundaries", async () => {
      await service.getSummary({
        startDate: "2026-11-07",
        endDate: "2026-11-08",
      });
      const where = prisma.llmUsageLog.findMany.mock.calls[0][0].where;
      expect(where.createdAt.gte.toISOString()).toBe(
        "2026-11-06T16:00:00.000Z",
      );
      expect(where.createdAt.lt.toISOString()).toBe("2026-11-08T16:00:00.000Z");
    });
  });

  describe("getTrend", () => {
    it("fills zero buckets for days without data", async () => {
      prisma.llmUsageLog.findMany.mockResolvedValue([
        logRow({ createdAt: at("2026-11-07") }),
        logRow({
          createdAt: at("2026-11-07"),
          success: false,
          failureReason: "timeout",
        }),
      ]);

      const result = await service.getTrend({
        startDate: "2026-11-07",
        endDate: "2026-11-09",
        granularity: "day",
      });

      expect(result.granularity).toBe("day");
      expect(result.series).toHaveLength(3);
      expect(result.series[0]).toMatchObject({
        date: "2026-11-07",
        calls: 2,
        successRate: 0.5,
        p50LatencyMs: 1000,
        avgFirstTokenMs: 300,
        totalTokens: 200,
      });
      expect(result.series[1]).toEqual({
        date: "2026-11-08",
        calls: 0,
        successRate: null,
        p50LatencyMs: null,
        avgFirstTokenMs: null,
        totalTokens: 0,
      });
      expect(result.series[2]).toMatchObject({ date: "2026-11-09", calls: 0 });
    });

    it("passes scene filter through to prisma", async () => {
      await service.getTrend({
        startDate: "2026-11-07",
        endDate: "2026-11-07",
        scene: "filler",
      });
      expect(prisma.llmUsageLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ scene: "filler" }),
        }),
      );
    });

    it("buckets by month when granularity=month", async () => {
      prisma.llmUsageLog.findMany.mockResolvedValue([
        logRow({ createdAt: at("2026-11-07") }),
        logRow({ createdAt: at("2026-11-20") }),
      ]);

      const result = await service.getTrend({
        startDate: "2026-11-01",
        endDate: "2026-11-30",
        granularity: "month",
      });

      expect(result.series).toEqual([
        {
          date: "2026-11",
          calls: 2,
          successRate: 1,
          p50LatencyMs: 1000,
          avgFirstTokenMs: 300,
          totalTokens: 200,
        },
      ]);
    });
  });

  describe("getRecentFailures", () => {
    it("returns failures ordered desc with business deviceId mapped", async () => {
      prisma.llmUsageLog.count.mockResolvedValue(2);
      prisma.llmUsageLog.findMany.mockResolvedValue([
        {
          id: "log-1",
          scene: "filler",
          tier: "small",
          model: "qwen-flash",
          failureReason: "timeout",
          latencyMs: 5000,
          turnId: "turn-f1",
          createdAt: at("2026-11-07"),
          device: { deviceId: "DEDA-0001" },
        },
        {
          id: "log-2",
          scene: "chat_main",
          tier: "main",
          model: "deepseek-flash",
          failureReason: "empty_response",
          latencyMs: 800,
          turnId: null,
          createdAt: at("2026-11-06"),
          device: null,
        },
      ]);

      const result = await service.getRecentFailures({ page: 1, pageSize: 20 });

      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        id: "log-1",
        failureReason: "timeout",
        deviceId: "DEDA-0001",
        turnId: "turn-f1",
      });
      expect(result.items[1].deviceId).toBeNull();
      expect(result.items[1].turnId).toBeNull();

      const findArgs = prisma.llmUsageLog.findMany.mock.calls[0][0];
      expect(findArgs.where).toEqual({ success: false });
      expect(findArgs.orderBy).toEqual({ createdAt: "desc" });
      expect(findArgs.skip).toBe(0);
      expect(findArgs.take).toBe(20);
    });

    it("applies scene filter and pagination", async () => {
      await service.getRecentFailures({
        page: 3,
        pageSize: 10,
        scene: "intent_classify",
      });
      const findArgs = prisma.llmUsageLog.findMany.mock.calls[0][0];
      expect(findArgs.where).toEqual({
        success: false,
        scene: "intent_classify",
      });
      expect(findArgs.skip).toBe(20);
      expect(findArgs.take).toBe(10);
      expect(prisma.llmUsageLog.count).toHaveBeenCalledWith({
        where: { success: false, scene: "intent_classify" },
      });
    });
  });

  describe("getByTurn", () => {
    it("returns the full call chain for a turn, ordered by createdAt asc", async () => {
      prisma.llmUsageLog.findMany.mockResolvedValue([
        {
          id: "log-1",
          scene: "safety_l2",
          model: "qwen-flash",
          tier: "small",
          success: true,
          failureReason: null,
          latencyMs: 320,
          firstTokenMs: null,
          promptTokens: 210,
          completionTokens: 2,
          totalTokens: 212,
          createdAt: new Date("2026-11-09T10:00:00.100Z"),
        },
        {
          id: "log-2",
          scene: "chat_main",
          model: "deepseek-flash",
          tier: "main",
          success: false,
          failureReason: "timeout",
          latencyMs: 30000,
          firstTokenMs: null,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          createdAt: new Date("2026-11-09T10:00:00.500Z"),
        },
      ]);

      const result = await service.getByTurn("turn-1");

      expect(result.turnId).toBe("turn-1");
      expect(result.calls).toHaveLength(2);
      expect(result.calls[0]).toEqual({
        id: "log-1",
        scene: "safety_l2",
        model: "qwen-flash",
        tier: "small",
        success: true,
        failureReason: null,
        latencyMs: 320,
        firstTokenMs: null,
        promptTokens: 210,
        completionTokens: 2,
        totalTokens: 212,
        createdAt: new Date("2026-11-09T10:00:00.100Z"),
      });
      expect(result.calls[1].failureReason).toBe("timeout");

      const findArgs = prisma.llmUsageLog.findMany.mock.calls[0][0];
      expect(findArgs.where).toEqual({ turnId: "turn-1" });
      expect(findArgs.orderBy).toEqual({ createdAt: "asc" });
    });

    it("returns an empty calls array for an unknown turnId", async () => {
      prisma.llmUsageLog.findMany.mockResolvedValue([]);

      const result = await service.getByTurn("turn-missing");

      expect(result).toEqual({ turnId: "turn-missing", calls: [] });
    });
  });
});
