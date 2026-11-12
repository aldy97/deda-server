import { BadRequestException } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { TurnDecisionAnalyticsService } from "./turn-decision-analytics.service";

/**
 * 判定质量看板读侧单测：全程 mock prisma，不出网不写库。
 *
 * 三条口径硬约束：
 * 1. 分母为 0 时比率必须是 null 而不是 0——「没数据」和「零拦截」是两件事；
 * 2. 安全分桶必须按 safetySource 而不是 safetyCategory，否则 safe 与 fail-open 又混成一桶；
 * 3. 复核队列恒定附加 asrText IS NOT NULL，不给调用方绕过的余地（儿童语料最小暴露面）。
 */

type GroupByArgs = { by: string[]; where?: unknown; orderBy?: unknown };

function setup() {
  const groupBy = jest.fn();
  const count = jest.fn().mockResolvedValue(0);
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    turnDecisionLog: { groupBy, count, findMany },
  } as unknown as PrismaService;
  const service = new TurnDecisionAnalyticsService(prisma);
  /** 按 by 字段组合分派 groupBy 结果，模拟多次不同维度的聚合 */
  const stubGroups = (table: Record<string, unknown[]>) => {
    groupBy.mockImplementation((args: GroupByArgs) =>
      Promise.resolve(table[args.by.join(",")] ?? []),
    );
  };
  return { service, groupBy, count, findMany, stubGroups };
}

const RANGE = { startDate: "2026-11-01", endDate: "2026-11-07" };
const all = (n: number) => ({ _count: { _all: n } });

describe("TurnDecisionAnalyticsService", () => {
  describe("区间校验", () => {
    it.each([
      ["非法日期", { startDate: "2026-11-1", endDate: "2026-11-07" }],
      ["起始晚于结束", { startDate: "2026-11-08", endDate: "2026-11-07" }],
    ])("%s → BadRequestException", async (_name, query) => {
      const { service } = setup();
      await expect(service.getSafetySummary(query)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("按北京时区把日期区间翻译成 createdAt 边界", async () => {
      const { service, groupBy, count, stubGroups } = setup();
      stubGroups({});
      await service.getSafetySummary({
        startDate: "2026-11-12",
        endDate: "2026-11-12",
      });
      const where = (groupBy.mock.calls[0][0] as GroupByArgs).where as {
        createdAt: { gte: Date; lt: Date };
      };
      // Asia/Shanghai 的 11-12 全天 = UTC 11-11T16:00 至 11-12T16:00
      expect(where.createdAt.gte.toISOString()).toBe(
        "2026-11-11T16:00:00.000Z",
      );
      expect(where.createdAt.lt.toISOString()).toBe("2026-11-12T16:00:00.000Z");
      expect(count).toHaveBeenCalled();
    });
  });

  describe("getSafetySummary", () => {
    it("拦截率与各类分桶", async () => {
      const { service, stubGroups, count } = setup();
      stubGroups({
        "safetyCategory,safetyBlocked": [
          { safetyCategory: "safe", safetyBlocked: false, ...all(80) },
          { safetyCategory: "sexual", safetyBlocked: true, ...all(12) },
          { safetyCategory: "violence", safetyBlocked: true, ...all(5) },
          { safetyCategory: "emotional_harm", safetyBlocked: false, ...all(3) },
        ],
        safetyLayer: [
          { safetyLayer: "L1", ...all(4) },
          { safetyLayer: "L2", ...all(96) },
        ],
        safetySource: [
          { safetySource: "l2_model", ...all(90) },
          { safetySource: "l1_regex", ...all(4) },
          { safetySource: "l2_fail_open", ...all(3) },
          { safetySource: "l2_invalid_label", ...all(2) },
          { safetySource: "not_evaluated", ...all(1) },
        ],
      });
      count.mockResolvedValue(15);

      const result = await service.getSafetySummary(RANGE);

      expect(result.total).toBe(100);
      expect(result.blockedCount).toBe(17);
      expect(result.blockRate).toBe(0.17);
      expect(result.failOpenCount).toBe(3);
      expect(result.invalidLabelCount).toBe(2);
      expect(result.notEvaluatedCount).toBe(1);
      // emotional_harm 不拦截，但它是行为改变点，必须单独可见
      expect(result.emotionalHarmCount).toBe(3);
      expect(result.reviewableCount).toBe(15);
      expect(result.byCategory).toEqual([
        { category: "sexual", count: 12, blockedCount: 12 },
        { category: "violence", count: 5, blockedCount: 5 },
        { category: "emotional_harm", count: 3, blockedCount: 0 },
        { category: "safe", count: 80, blockedCount: 0 },
      ]);
      expect(result.byLayer).toEqual([
        { layer: "L1", count: 4 },
        { layer: "L2", count: 96 },
      ]);
      expect(result.bySource).toContainEqual({ source: "l2_model", count: 90 });
    });

    it("category 为 null 时如实保留 null，不折叠成 safe", async () => {
      const { service, stubGroups } = setup();
      stubGroups({
        "safetyCategory,safetyBlocked": [
          { safetyCategory: null, safetyBlocked: false, ...all(6) },
        ],
        safetyLayer: [],
        safetySource: [{ safetySource: "l2_fail_open", ...all(6) }],
      });

      const result = await service.getSafetySummary(RANGE);

      expect(result.byCategory).toEqual([
        { category: null, count: 6, blockedCount: 0 },
      ]);
      expect(result.total).toBe(6);
    });

    it("零数据时比率为 null 而非 0", async () => {
      const { service, stubGroups } = setup();
      stubGroups({});

      const result = await service.getSafetySummary(RANGE);

      expect(result.total).toBe(0);
      expect(result.blockRate).toBeNull();
      expect(result.byCategory).toEqual([]);
    });

    it("比率保留 4 位小数", async () => {
      const { service, stubGroups } = setup();
      stubGroups({
        "safetyCategory,safetyBlocked": [
          { safetyCategory: "safe", safetyBlocked: false, ...all(2) },
          { safetyCategory: "sexual", safetyBlocked: true, ...all(1) },
        ],
        safetyLayer: [],
        safetySource: [],
      });

      const result = await service.getSafetySummary(RANGE);
      expect(result.blockRate).toBe(0.3333);
    });

    it("契约外的类别/层级不丢数据，排在已知项之后并按计数倒序", async () => {
      const { service, stubGroups } = setup();
      stubGroups({
        "safetyCategory,safetyBlocked": [
          { safetyCategory: "safe", safetyBlocked: false, ...all(5) },
          // 将来新增但看板尚未收录的类别：必须仍可见，不能静默丢掉
          { safetyCategory: "gambling", safetyBlocked: true, ...all(9) },
          { safetyCategory: "profanity", safetyBlocked: false, ...all(2) },
        ],
        safetyLayer: [
          { safetyLayer: "L2", ...all(5) },
          { safetyLayer: "L9", ...all(8) },
          { safetyLayer: "L8", ...all(3) },
        ],
        safetySource: [],
      });

      const result = await service.getSafetySummary(RANGE);

      expect(result.byCategory.map((c) => c.category)).toEqual([
        "safe",
        "gambling",
        "profanity",
      ]);
      expect(result.byLayer.map((l) => l.layer)).toEqual(["L2", "L9", "L8"]);
      expect(result.total).toBe(16);
      expect(result.blockedCount).toBe(9);
    });
  });

  describe("getSafetyTrend", () => {
    it("无数据日期补零，比率为 null", async () => {
      const { service, findMany } = setup();
      findMany.mockResolvedValue([
        {
          createdAt: new Date("2026-11-02T02:00:00Z"),
          safetyBlocked: true,
          safetyCategory: "sexual",
          safetySource: "l2_model",
        },
      ]);

      const result = await service.getSafetyTrend({
        startDate: "2026-11-01",
        endDate: "2026-11-03",
      });

      expect(result.granularity).toBe("day");
      expect(result.series).toHaveLength(3);
      expect(result.series[0]).toMatchObject({
        date: "2026-11-01",
        total: 0,
        blockedCount: 0,
        blockRate: null,
      });
      expect(result.series[1]).toMatchObject({
        date: "2026-11-02",
        total: 1,
        blockedCount: 1,
        blockRate: 1,
      });
    });

    it("跨北京日界（23:59 / 00:01）归入正确的日期桶", async () => {
      const { service, findMany } = setup();
      findMany.mockResolvedValue([
        {
          // 北京 2026-11-12 23:59:59
          createdAt: new Date("2026-11-12T15:59:59Z"),
          safetyBlocked: false,
          safetyCategory: "safe",
          safetySource: "l2_model",
        },
        {
          // 北京 2026-11-13 00:00:01
          createdAt: new Date("2026-11-12T16:00:01Z"),
          safetyBlocked: false,
          safetyCategory: "safe",
          safetySource: "l2_model",
        },
      ]);

      const result = await service.getSafetyTrend({
        startDate: "2026-11-12",
        endDate: "2026-11-13",
      });

      expect(result.series.map((s) => s.date)).toEqual([
        "2026-11-12",
        "2026-11-13",
      ]);
      expect(result.series[0].total).toBe(1);
      expect(result.series[1].total).toBe(1);
    });

    it("静默降级按 source 分桶，不与 safe 混淆", async () => {
      const { service, findMany } = setup();
      findMany.mockResolvedValue([
        {
          createdAt: new Date("2026-11-01T02:00:00Z"),
          safetyBlocked: false,
          safetyCategory: null,
          safetySource: "l2_fail_open",
        },
        {
          createdAt: new Date("2026-11-01T03:00:00Z"),
          safetyBlocked: false,
          safetyCategory: null,
          safetySource: "l2_invalid_label",
        },
        {
          createdAt: new Date("2026-11-01T04:00:00Z"),
          safetyBlocked: false,
          safetyCategory: null,
          safetySource: "not_evaluated",
        },
        {
          createdAt: new Date("2026-11-01T05:00:00Z"),
          safetyBlocked: false,
          safetyCategory: "emotional_harm",
          safetySource: "l2_model",
        },
      ]);

      const result = await service.getSafetyTrend({
        startDate: "2026-11-01",
        endDate: "2026-11-01",
      });

      expect(result.series[0]).toMatchObject({
        total: 4,
        blockedCount: 0,
        failOpenCount: 1,
        invalidLabelCount: 1,
        notEvaluatedCount: 1,
        emotionalHarmCount: 1,
      });
    });

    it("支持 week 粒度且只查必要列", async () => {
      const { service, findMany } = setup();
      findMany.mockResolvedValue([
        {
          createdAt: new Date("2026-11-01T02:00:00Z"),
          safetyBlocked: false,
          safetyCategory: "safe",
          safetySource: "l2_model",
        },
      ]);

      const result = await service.getSafetyTrend({
        startDate: "2026-11-01",
        endDate: "2026-11-08",
        granularity: "week",
      });

      expect(result.granularity).toBe("week");
      // 11-01 是周日 → 归入 2026-10-26 那一周；11-02..11-08 归入 11-02 那一周
      expect(result.series.map((s) => s.date)).toEqual([
        "2026-10-26",
        "2026-11-02",
      ]);
      expect(result.series[0].total).toBe(1);
      const select = (
        findMany.mock.calls[0][0] as { select: Record<string, boolean> }
      ).select;
      expect(Object.keys(select).sort()).toEqual([
        "createdAt",
        "safetyBlocked",
        "safetyCategory",
        "safetySource",
      ]);
    });

    it("支持 month 粒度：桶 key 为 YYYY-MM 且跨月各一桶", async () => {
      const { service, findMany } = setup();
      findMany.mockResolvedValue([
        {
          createdAt: new Date("2026-10-31T15:00:00Z"),
          safetyBlocked: false,
          safetyCategory: "safe",
          safetySource: "l2_model",
        },
        {
          createdAt: new Date("2026-11-01T02:00:00Z"),
          safetyBlocked: true,
          safetyCategory: "violence",
          safetySource: "l2_model",
        },
      ]);

      const result = await service.getSafetyTrend({
        startDate: "2026-10-31",
        endDate: "2026-11-01",
        granularity: "month",
      });

      expect(result.granularity).toBe("month");
      expect(result.series.map((s) => s.date)).toEqual(["2026-10", "2026-11"]);
      expect(result.series[0].total).toBe(1);
      expect(result.series[1]).toMatchObject({ total: 1, blockedCount: 1 });
    });
  });

  describe("getIntentSummary", () => {
    it("矩阵、模型调用率与 fallback 率", async () => {
      const { service, stubGroups } = setup();
      stubGroups({
        "intent,intentSource": [
          { intent: "free_chat", intentSource: "model", ...all(40) },
          { intent: "english_story", intentSource: "model", ...all(20) },
          { intent: "free_chat", intentSource: "pre_filter_skip", ...all(20) },
          { intent: "sleep_story", intentSource: "session_sticky", ...all(10) },
          {
            intent: "english_story",
            intentSource: "fallback_invalid_label",
            ...all(6),
          },
          { intent: "free_chat", intentSource: "fallback_error", ...all(4) },
        ],
      });

      const result = await service.getIntentSummary(RANGE);

      expect(result.total).toBe(100);
      expect(result.modelInvokedCount).toBe(60);
      expect(result.modelInvokedRate).toBe(0.6);
      expect(result.fallbackCount).toBe(10);
      expect(result.fallbackRate).toBe(0.1);
      expect(result.byIntent).toEqual([
        { intent: "free_chat", count: 64 },
        { intent: "english_story", count: 26 },
        { intent: "sleep_story", count: 10 },
      ]);
      expect(result.bySource).toContainEqual({ source: "model", count: 60 });
      expect(result.matrix).toContainEqual({
        intent: "english_story",
        source: "fallback_invalid_label",
        count: 6,
      });
    });

    it("被拦截与冒险接管轮次单独成桶，不混进真实意图", async () => {
      const { service, stubGroups } = setup();
      stubGroups({
        "intent,intentSource": [
          { intent: null, intentSource: "not_routed", ...all(7) },
          { intent: null, intentSource: "adventure_takeover", ...all(30) },
          { intent: "free_chat", intentSource: "no_device", ...all(3) },
        ],
      });

      const result = await service.getIntentSummary(RANGE);

      expect(result.total).toBe(40);
      expect(result.notRoutedCount).toBe(7);
      expect(result.adventureTakeoverCount).toBe(30);
      expect(result.modelInvokedRate).toBe(0);
      expect(result.byIntent).toEqual([
        { intent: null, count: 37 },
        { intent: "free_chat", count: 3 },
      ]);
    });

    it("意图计数相同时按名称稳定排序（含矩阵）", async () => {
      const { service, stubGroups } = setup();
      stubGroups({
        "intent,intentSource": [
          { intent: "sleep_story", intentSource: "model", ...all(4) },
          { intent: "english_story", intentSource: "model", ...all(4) },
          { intent: "idiom_story", intentSource: "session_sticky", ...all(4) },
        ],
      });

      const result = await service.getIntentSummary(RANGE);

      expect(result.byIntent.map((i) => i.intent)).toEqual([
        "english_story",
        "idiom_story",
        "sleep_story",
      ]);
      expect(result.matrix.map((m) => m.intent)).toEqual([
        "english_story",
        "idiom_story",
        "sleep_story",
      ]);
      expect(result.bySource).toEqual([
        { source: "model", count: 8 },
        { source: "session_sticky", count: 4 },
      ]);
    });

    it("零数据时比率为 null", async () => {
      const { service, stubGroups } = setup();
      stubGroups({});

      const result = await service.getIntentSummary(RANGE);

      expect(result.total).toBe(0);
      expect(result.modelInvokedRate).toBeNull();
      expect(result.fallbackRate).toBeNull();
      expect(result.matrix).toEqual([]);
    });
  });

  describe("getIntentTrend", () => {
    it("逐日输出模型调用数、fallback 数与意图分布", async () => {
      const { service, findMany } = setup();
      findMany.mockResolvedValue([
        {
          createdAt: new Date("2026-11-01T02:00:00Z"),
          intent: "free_chat",
          intentSource: "model",
        },
        {
          createdAt: new Date("2026-11-01T03:00:00Z"),
          intent: "free_chat",
          intentSource: "fallback_error",
        },
        {
          createdAt: new Date("2026-11-02T03:00:00Z"),
          intent: null,
          intentSource: "not_routed",
        },
      ]);

      const result = await service.getIntentTrend({
        startDate: "2026-11-01",
        endDate: "2026-11-02",
      });

      expect(result.series[0]).toMatchObject({
        date: "2026-11-01",
        total: 2,
        modelInvoked: 1,
        fallbackCount: 1,
      });
      expect(result.series[0].byIntent).toEqual([
        { intent: "free_chat", count: 2 },
      ]);
      expect(result.series[1]).toMatchObject({
        date: "2026-11-02",
        total: 1,
        modelInvoked: 0,
        fallbackCount: 0,
      });
      expect(result.series[1].byIntent).toEqual([{ intent: null, count: 1 }]);
    });

    it("同一桶内意图计数相同时按名称稳定排序", async () => {
      const { service, findMany } = setup();
      findMany.mockResolvedValue([
        {
          createdAt: new Date("2026-11-01T02:00:00Z"),
          intent: "sleep_story",
          intentSource: "model",
        },
        {
          createdAt: new Date("2026-11-01T03:00:00Z"),
          intent: "english_story",
          intentSource: "model",
        },
        {
          createdAt: new Date("2026-11-01T04:00:00Z"),
          intent: null,
          intentSource: "not_routed",
        },
      ]);

      const result = await service.getIntentTrend({
        startDate: "2026-11-01",
        endDate: "2026-11-01",
      });

      // 三者计数都是 1 → 落到名称 tie-break；null 排在最前（String(null ?? "") = ""）
      expect(result.series[0].byIntent).toEqual([
        { intent: null, count: 1 },
        { intent: "english_story", count: 1 },
        { intent: "sleep_story", count: 1 },
      ]);
    });
  });

  describe("getReviewQueue", () => {
    it("恒定附加 asrText IS NOT NULL，即便调用方不传任何过滤", async () => {
      const { service, findMany, count } = setup();
      findMany.mockResolvedValue([]);

      await service.getReviewQueue(RANGE);

      const args = findMany.mock.calls[0][0] as {
        where: { asrText: { not: null } };
      };
      expect(args.where.asrText).toEqual({ not: null });
      const countArgs = count.mock.calls[0][0] as {
        where: { asrText: { not: null } };
      };
      expect(countArgs.where.asrText).toEqual({ not: null });
    });

    it("category 与 deviceId 过滤叠加在 asrText 条件之上", async () => {
      const { service, findMany } = setup();
      findMany.mockResolvedValue([]);

      await service.getReviewQueue({
        ...RANGE,
        category: "sexual",
        deviceId: "dev-uuid-1",
      });

      const where = (
        findMany.mock.calls[0][0] as { where: Record<string, unknown> }
      ).where;
      expect(where).toMatchObject({
        asrText: { not: null },
        safetyCategory: "sexual",
        deviceId: "dev-uuid-1",
      });
    });

    it("分页 offset 与总数", async () => {
      const { service, findMany, count } = setup();
      count.mockResolvedValue(95);
      findMany.mockResolvedValue([
        {
          turnId: "t1",
          deviceId: "d1",
          channel: "baidu-rtc",
          createdAt: new Date("2026-11-01T02:00:00Z"),
          safetyLayer: "L2",
          safetyCategory: "sexual",
          safetySource: "l2_model",
          safetyMatched: null,
          asrText: "假数据",
          intent: null,
          intentSource: "not_routed",
        },
      ]);

      const result = await service.getReviewQueue({
        ...RANGE,
        page: 3,
        pageSize: 10,
      });

      expect(result).toMatchObject({ total: 95, page: 3, pageSize: 10 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].turnId).toBe("t1");
      const args = findMany.mock.calls[0][0] as { skip: number; take: number };
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
    });

    it("缺省按 createdAt 倒序，sort=createdAt_asc 时升序", async () => {
      const { service, findMany } = setup();
      findMany.mockResolvedValue([]);

      await service.getReviewQueue(RANGE);
      expect(
        (findMany.mock.calls[0][0] as { orderBy: unknown }).orderBy,
      ).toEqual({ createdAt: "desc" });

      await service.getReviewQueue({ ...RANGE, sort: "createdAt_asc" });
      expect(
        (findMany.mock.calls[1][0] as { orderBy: unknown }).orderBy,
      ).toEqual({ createdAt: "asc" });
    });

    it("缺省分页 page=1 / pageSize=20", async () => {
      const { service, findMany } = setup();
      findMany.mockResolvedValue([]);

      const result = await service.getReviewQueue(RANGE);

      expect(result).toMatchObject({ page: 1, pageSize: 20 });
      expect((findMany.mock.calls[0][0] as { skip: number }).skip).toBe(0);
    });
  });
});
