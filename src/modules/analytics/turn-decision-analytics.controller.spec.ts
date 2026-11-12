import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  DecisionTrendQueryDto,
  ReviewQueueQueryDto,
  TurnDecisionAnalyticsController,
} from "./turn-decision-analytics.controller";
import { TurnDecisionAnalyticsService } from "./turn-decision-analytics.service";

/**
 * 判定质量监控接口单测：透传 + DTO 校验（成功路径 / 校验失败），
 * 鉴权由 AnalyticsAuthGuard 统一覆盖（见 analytics-auth.controller.spec.ts），此处不重复。
 */
describe("TurnDecisionAnalyticsController", () => {
  const RANGE = { startDate: "2026-11-01", endDate: "2026-11-07" };

  function makeController() {
    const service = {
      getSafetySummary: jest.fn().mockResolvedValue({ total: 0 }),
      getSafetyTrend: jest.fn().mockResolvedValue({ series: [] }),
      getIntentSummary: jest.fn().mockResolvedValue({ total: 0 }),
      getIntentTrend: jest.fn().mockResolvedValue({ series: [] }),
      getReviewQueue: jest.fn().mockResolvedValue({ total: 0, items: [] }),
    } as unknown as TurnDecisionAnalyticsService;
    return {
      controller: new TurnDecisionAnalyticsController(service),
      service,
    };
  }

  it("五个端点原样透传给 service", async () => {
    const { controller, service } = makeController();
    const range = plainToInstance(DecisionTrendQueryDto, RANGE);
    const queue = plainToInstance(ReviewQueueQueryDto, RANGE);

    await controller.getSafetySummary(range);
    expect(service.getSafetySummary).toHaveBeenCalledWith(range);

    await controller.getSafetyTrend(range);
    expect(service.getSafetyTrend).toHaveBeenCalledWith(range);

    await controller.getIntentSummary(range);
    expect(service.getIntentSummary).toHaveBeenCalledWith(range);

    await controller.getIntentTrend(range);
    expect(service.getIntentTrend).toHaveBeenCalledWith(range);

    await controller.getReviewQueue(queue);
    expect(service.getReviewQueue).toHaveBeenCalledWith(queue);
  });

  describe("DTO 校验", () => {
    it("trend：缺省 granularity 合法，非法粒度 400，空串视为未提供", async () => {
      expect(
        await validate(plainToInstance(DecisionTrendQueryDto, RANGE)),
      ).toHaveLength(0);
      expect(
        await validate(
          plainToInstance(DecisionTrendQueryDto, {
            ...RANGE,
            granularity: "week",
          }),
        ),
      ).toHaveLength(0);

      const bad = plainToInstance(DecisionTrendQueryDto, {
        ...RANGE,
        granularity: "hour",
      });
      expect(await validate(bad)).toHaveLength(1);

      const empty = plainToInstance(DecisionTrendQueryDto, {
        ...RANGE,
        granularity: "",
      });
      expect(await validate(empty)).toHaveLength(0);
      expect(empty.granularity).toBeUndefined();
    });

    it("日期区间格式非法被拒（继承 AnalyticsDateRangeQueryDto）", async () => {
      const bad = plainToInstance(DecisionTrendQueryDto, {
        startDate: "2026-11-1",
        endDate: "2026-11-07",
      });
      expect(await validate(bad)).toHaveLength(1);
    });

    it("review-queue：缺省分页 1/20，越界被拒", async () => {
      const ok = plainToInstance(ReviewQueueQueryDto, RANGE);
      expect(await validate(ok)).toHaveLength(0);
      expect(ok.page).toBe(1);
      expect(ok.pageSize).toBe(20);

      for (const query of [{ page: "0" }, { pageSize: "101" }]) {
        const dto = plainToInstance(ReviewQueueQueryDto, {
          ...RANGE,
          ...query,
        });
        expect((await validate(dto)).length).toBeGreaterThan(0);
      }
    });

    it("review-queue：category 走白名单，拼错的类别 400 而不是静默返回空", async () => {
      const ok = plainToInstance(ReviewQueueQueryDto, {
        ...RANGE,
        category: "emotional_harm",
      });
      expect(await validate(ok)).toHaveLength(0);

      const typo = plainToInstance(ReviewQueueQueryDto, {
        ...RANGE,
        category: "self-harm",
      });
      expect(await validate(typo)).toHaveLength(1);

      const empty = plainToInstance(ReviewQueueQueryDto, {
        ...RANGE,
        category: "",
      });
      expect(await validate(empty)).toHaveLength(0);
      expect(empty.category).toBeUndefined();
    });

    it("review-queue：sort 白名单只允许 createdAt", async () => {
      for (const sort of ["createdAt_desc", "createdAt_asc"]) {
        const dto = plainToInstance(ReviewQueueQueryDto, { ...RANGE, sort });
        expect(await validate(dto)).toHaveLength(0);
      }
      const bad = plainToInstance(ReviewQueueQueryDto, {
        ...RANGE,
        sort: "asrText_asc",
      });
      expect(await validate(bad)).toHaveLength(1);
    });

    it("review-queue：deviceId 超 64 字被拒", async () => {
      const bad = plainToInstance(ReviewQueueQueryDto, {
        ...RANGE,
        deviceId: "d".repeat(65),
      });
      expect(await validate(bad)).toHaveLength(1);
    });
  });
});
