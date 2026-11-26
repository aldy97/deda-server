import { plainToInstance } from "class-transformer";
import {
  LlmAnalyticsController,
  LlmRecentFailuresQueryDto,
  LlmSlowCallsQueryDto,
  LlmTrendQueryDto,
  LlmTurnHandoffQueryDto,
} from "./llm-analytics.controller";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { SuperAdminGuard } from "./guards/super-admin.guard";

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

  it("整组挂在 SuperAdminGuard 之下（含费用同步 POST）", () => {
    const guards = Reflect.getMetadata(
      "__guards__",
      LlmAnalyticsController,
    ) as unknown[];

    expect(guards).toContain(SuperAdminGuard);
    // 基础闸由 SuperAdminGuard 继承，不需要重复挂
    expect(guards).not.toContain(AnalyticsAuthGuard);
  });

  it("emptyToUndefined：scene 空串 → undefined，非空串原样保留", () => {
    expect(
      plainToInstance(LlmTrendQueryDto, { scene: "" }).scene,
    ).toBeUndefined();
    expect(
      plainToInstance(LlmTrendQueryDto, { scene: "chat_main" }).scene,
    ).toBe("chat_main");
    expect(
      plainToInstance(LlmRecentFailuresQueryDto, { scene: "" }).scene,
    ).toBeUndefined();
    expect(
      plainToInstance(LlmSlowCallsQueryDto, { scene: "" }).scene,
    ).toBeUndefined();
  });

  it("数字 query 转成 number（page / pageSize / gapThresholdMs / limit）", () => {
    const failures = plainToInstance(LlmRecentFailuresQueryDto, {
      page: "2",
      pageSize: "30",
    });
    expect(failures.page).toBe(2);
    expect(failures.pageSize).toBe(30);

    const handoff = plainToInstance(LlmTurnHandoffQueryDto, {
      gapThresholdMs: "1500",
    });
    expect(handoff.gapThresholdMs).toBe(1500);

    const slow = plainToInstance(LlmSlowCallsQueryDto, { limit: "10" });
    expect(slow.limit).toBe(10);
  });

  it("缺省分页：page=1 / pageSize=20", () => {
    const dto = plainToInstance(LlmRecentFailuresQueryDto, {});
    expect(dto.page).toBe(1);
    expect(dto.pageSize).toBe(20);
  });
});
