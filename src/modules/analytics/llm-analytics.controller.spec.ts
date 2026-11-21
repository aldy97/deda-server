import { plainToInstance } from "class-transformer";
import {
  LlmAnalyticsController,
  LlmTrendQueryDto,
} from "./llm-analytics.controller";

describe("LlmAnalyticsController", () => {
  const llmAnalytics = {
    getSummary: jest.fn(),
    getTrend: jest.fn(),
    getRecentFailures: jest.fn(),
    getByTurn: jest.fn(),
    getTurnHandoff: jest.fn(),
    getSlowCalls: jest.fn(),
  };
  const llmCost = { getCostDaily: jest.fn() };
  const billingSync = { syncRecent: jest.fn() };
  const controller = new LlmAnalyticsController(
    llmAnalytics as never,
    llmCost as never,
    billingSync as never,
  );

  it("透传 8 个端点的查询给对应 service", () => {
    const range = { startDate: "2026-11-01", endDate: "2026-11-05" };
    controller.getSummary(range);
    expect(llmAnalytics.getSummary).toHaveBeenCalledWith(range);
    controller.getTrend(range);
    expect(llmAnalytics.getTrend).toHaveBeenCalledWith(range);
    controller.getRecentFailures({ page: 1, pageSize: 20 });
    expect(llmAnalytics.getRecentFailures).toHaveBeenCalled();
    controller.getByTurn({ turnId: "t1" });
    expect(llmAnalytics.getByTurn).toHaveBeenCalledWith("t1");
    controller.getTurnHandoff(range);
    expect(llmAnalytics.getTurnHandoff).toHaveBeenCalledWith(range);
    controller.getCostDaily(range);
    expect(llmCost.getCostDaily).toHaveBeenCalledWith(range);
    controller.syncCost();
    expect(billingSync.syncRecent).toHaveBeenCalled();
    controller.getSlowCalls(range);
    expect(llmAnalytics.getSlowCalls).toHaveBeenCalledWith(range);
  });

  it("emptyToUndefined：scene 空串 → undefined，非空串原样保留", () => {
    expect(
      plainToInstance(LlmTrendQueryDto, { scene: "" }).scene,
    ).toBeUndefined();
    expect(
      plainToInstance(LlmTrendQueryDto, { scene: "chat_main" }).scene,
    ).toBe("chat_main");
  });
});
