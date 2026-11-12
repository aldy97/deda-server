import { BadRequestException } from "@nestjs/common";
import { PRICING_VERSION } from "../llm/llm-cost.util";
import { AliyunBillClient } from "./aliyun-bill.client";
import { LlmCostService } from "./llm-cost.service";

/**
 * 费用接口单测：全程 mock，不出网、不连库。
 *
 * 两条数据源在测试里分别喂：
 * - 主模型（估算）＝ $queryRaw 的日分组 / 模型分组结果（Prisma 对 bigint 返回 string，故夹具混用 string）；
 * - 小模型（真值）＝ llmCostDaily.groupBy 的账单分组结果。
 *
 * 覆盖熊总点名的硬约束：
 * 1) 无论前端传什么，series 里绝不出现今日/未来日期；
 * 2) 拿不到账单 ≠ ¥0（status=unconfigured/no_data，金额为 null，totals.partial=true）；
 * 3) 账单缺日留断点，不补 0；退款调账为负数，不取绝对值；
 * 4) 未计价行单独计数，不静默当成 ¥0。
 */

/** 北京 2026-11-12 13:00 → 昨日 = 2026-11-11 */
const NOW = new Date("2026-11-12T05:00:00Z");

interface DailyFixture {
  day: string;
  model: string;
  rows?: number;
  priced_rows?: number;
  upper_bound_rows?: number;
  cache_hit_rows?: number;
  cost_micro?: number | string;
  tokens?: number | string;
  priced_tokens?: number | string;
}

interface ModelFixture {
  model: string;
  rows?: number;
  priced_rows?: number;
  unpriced_rows?: number;
  no_token_rows?: number;
  cache_hit_rows?: number;
  upper_bound_rows?: number;
  tokens?: number | string;
  priced_tokens?: number | string;
  unpriced_tokens?: number | string;
  cost_micro?: number | string;
  devices?: number;
}

interface BillFixture {
  billDate: string;
  tier: string;
  model: string;
  settled: boolean;
  payable: number;
  gross?: number;
}

interface Fixtures {
  daily?: DailyFixture[];
  models?: ModelFixture[];
  bill?: BillFixture[];
  configured?: boolean;
  latestBillDate?: string | null;
  latestFetchedAt?: Date | null;
}

const DEFAULT_DAILY: DailyFixture[] = [
  {
    day: "2026-11-01",
    model: "deepseek-flash",
    rows: 10,
    priced_rows: 10,
    upper_bound_rows: 0,
    cache_hit_rows: 10,
    cost_micro: "1234567", // Prisma 对 bigint 返回 string
    tokens: "5000",
    priced_tokens: "5000",
  },
  {
    day: "2026-11-01",
    model: "qwen-flash",
    rows: 20,
    priced_rows: 20,
    upper_bound_rows: 20,
    cache_hit_rows: 0,
    cost_micro: 300_000,
    tokens: 20_000,
    priced_tokens: 20_000,
  },
  {
    day: "2026-11-02",
    model: "deepseek-flash",
    rows: 4,
    priced_rows: 4,
    upper_bound_rows: 4,
    cache_hit_rows: 0,
    cost_micro: 400_000,
    tokens: 2_000,
    priced_tokens: 2_000,
  },
];

const DEFAULT_MODELS: ModelFixture[] = [
  {
    model: "deepseek-flash",
    rows: 14,
    priced_rows: 14,
    unpriced_rows: 0,
    no_token_rows: 0,
    cache_hit_rows: 10,
    upper_bound_rows: 4,
    tokens: 7_000,
    priced_tokens: 7_000,
    unpriced_tokens: 0,
    cost_micro: "1634567",
    devices: 5,
  },
  {
    model: "qwen-flash",
    rows: 20,
    priced_rows: 20,
    unpriced_rows: 0,
    no_token_rows: 0,
    cache_hit_rows: 0,
    upper_bound_rows: 20,
    tokens: 20_000,
    priced_tokens: 20_000,
    unpriced_tokens: 0,
    cost_micro: 300_000,
    devices: 5,
  },
];

const DEFAULT_BILL: BillFixture[] = [
  {
    billDate: "2026-11-01",
    tier: "small",
    model: "qwen-flash",
    settled: false,
    payable: 1_500_000,
    gross: 1_500_000,
  },
  // 退款/调账为负数，不取绝对值
  {
    billDate: "2026-11-02",
    tier: "small",
    model: "qwen-flash",
    settled: false,
    payable: -200_000,
    gross: 0,
  },
];

function buildService(fixtures: Fixtures = {}) {
  const daily = fixtures.daily ?? DEFAULT_DAILY;
  const models = fixtures.models ?? DEFAULT_MODELS;
  const bill = fixtures.bill ?? DEFAULT_BILL;
  const queryRaw = jest.fn((strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    // 日分组查询带 "AS day"，模型分组查询不带（两者都是只读聚合）
    return sql.includes("AS day")
      ? Promise.resolve(daily)
      : Promise.resolve(models);
  });
  const groupBy = jest.fn().mockResolvedValue(
    bill.map((row) => ({
      billDate: row.billDate,
      tier: row.tier,
      model: row.model,
      settled: row.settled,
      _sum: {
        payableMicroCny: row.payable,
        grossMicroCny: row.gross ?? row.payable,
      },
    })),
  );
  const aggregate = jest.fn().mockResolvedValue({
    _max: {
      billDate:
        fixtures.latestBillDate === undefined
          ? "2026-11-10"
          : fixtures.latestBillDate,
      fetchedAt:
        fixtures.latestFetchedAt === undefined
          ? new Date("2026-11-11T22:00:00Z")
          : fixtures.latestFetchedAt,
    },
  });
  const prisma = { $queryRaw: queryRaw, llmCostDaily: { groupBy, aggregate } };
  const billClient = {
    isConfigured: jest.fn().mockReturnValue(fixtures.configured ?? true),
  };
  const service = new LlmCostService(
    prisma as never,
    billClient as unknown as AliyunBillClient,
  );
  return { service, queryRaw, groupBy, aggregate };
}

async function getCostDaily(
  fixtures: Fixtures = {},
  startDate = "2026-11-01",
  endDate = "2026-11-03",
) {
  const built = buildService(fixtures);
  const result = await built.service.getCostDaily({ startDate, endDate }, NOW);
  return { ...built, result };
}

describe("LlmCostService.getCostDaily — 区间钳制", () => {
  it("endDate 传今日被钳到昨日，回显请求区间与 clamped", async () => {
    const { result } = await getCostDaily({}, "2026-11-01", "2026-11-12");
    expect(result.range).toEqual({
      startDate: "2026-11-01",
      endDate: "2026-11-11",
      requestedStartDate: "2026-11-01",
      requestedEndDate: "2026-11-12",
      clamped: true,
      days: 11,
    });
    expect(result.series).toHaveLength(11);
    expect(result.series[result.series.length - 1].date).toBe("2026-11-11");
  });

  it("startDate=endDate=今日 → 整段钳到昨日，不报 400", async () => {
    const { result } = await getCostDaily({}, "2026-11-12", "2026-11-12");
    expect(result.range.startDate).toBe("2026-11-11");
    expect(result.range.endDate).toBe("2026-11-11");
    expect(result.range.days).toBe(1);
    expect(result.range.clamped).toBe(true);
  });

  it("硬断言：series 里绝不出现今日或未来日期", async () => {
    const { result } = await getCostDaily({}, "2026-11-01", "2026-12-31");
    for (const item of result.series) {
      expect(item.date <= "2026-11-11").toBe(true);
    }
  });

  it("未钳制时 clamped=false", async () => {
    const { result } = await getCostDaily({}, "2026-11-01", "2026-11-03");
    expect(result.range.clamped).toBe(false);
    expect(result.range.days).toBe(3);
  });

  it("非法日期格式 → 400", async () => {
    const { service } = buildService();
    await expect(
      service.getCostDaily(
        { startDate: "2026-11-1", endDate: "2026-11-03" },
        NOW,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("startDate 晚于 endDate → 400", async () => {
    const { service } = buildService();
    await expect(
      service.getCostDaily(
        { startDate: "2026-11-05", endDate: "2026-11-01" },
        NOW,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("区间超过 366 天 → 400（防止逐日枚举失控）", async () => {
    const { service } = buildService();
    await expect(
      service.getCostDaily(
        { startDate: "2024-01-01", endDate: "2026-11-01" },
        NOW,
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe("LlmCostService.getCostDaily — 双源合并", () => {
  it("小模型取账单真值、主模型取快照估算，金额由 micro-CNY 精确换算", async () => {
    const { result } = await getCostDaily();
    const day1 = result.series[0];
    expect(day1).toMatchObject({
      date: "2026-11-01",
      smallCny: 1.5,
      mainCny: 1.234567,
      otherCny: 0,
      totalCny: 2.734567,
      smallTokens: 20_000,
      mainTokens: 5_000,
      smallSource: "bill",
      mainSource: "estimated",
      mainAccuracy: "exact",
      settled: false,
    });
    // 每百万 token 有效单价：账单口径用全部 token，估算口径用已计价 token
    expect(day1.smallCnyPerMillionTokens).toBe(75);
    expect(day1.mainCnyPerMillionTokens).toBe(246.9134);
  });

  it("缓存命中全缺 → mainAccuracy=upper_bound；部分缺 → mixed", async () => {
    const { result } = await getCostDaily();
    expect(result.series[1].mainAccuracy).toBe("upper_bound");
    const mixed = await getCostDaily({
      daily: [
        {
          day: "2026-11-01",
          model: "deepseek-flash",
          rows: 3,
          priced_rows: 3,
          upper_bound_rows: 1,
          cache_hit_rows: 2,
          cost_micro: 300,
          tokens: 300,
          priced_tokens: 300,
        },
      ],
      bill: [],
    });
    expect(mixed.result.series[0].mainAccuracy).toBe("mixed");
  });

  it("账单缺日 → smallCny=null（不补 0），无调用日 → mainCny=null，series 仍补齐每一天", async () => {
    const { result } = await getCostDaily();
    expect(result.series).toHaveLength(3);
    const day3 = result.series[2];
    expect(day3).toMatchObject({
      date: "2026-11-03",
      smallCny: null,
      mainCny: null,
      otherCny: null,
      totalCny: null,
      smallTokens: 0,
      mainTokens: 0,
      smallCnyPerMillionTokens: null,
      mainCnyPerMillionTokens: null,
      smallSource: "none",
      mainSource: "none",
      mainAccuracy: null,
      settled: null,
    });
  });

  it("退款为负数：当日与合计都保留负值", async () => {
    const { result } = await getCostDaily();
    expect(result.series[1].smallCny).toBe(-0.2);
    expect(result.series[1].totalCny).toBe(0.2);
    expect(result.totals.smallCny).toBe(1.3);
    expect(result.totals.mainCny).toBe(1.634567);
    expect(result.totals.otherCny).toBe(0);
    expect(result.totals.totalCny).toBe(2.934567);
    expect(result.totals.days).toBe(3);
  });

  it("主模型当天有调用但全部未计价 → mainCny=null，并在 totals 里单独计数", async () => {
    const { result } = await getCostDaily({
      daily: [
        {
          day: "2026-11-01",
          model: "deepseek-flash",
          rows: 2,
          priced_rows: 0,
          upper_bound_rows: 0,
          cache_hit_rows: 0,
          cost_micro: 0,
          tokens: 900,
          priced_tokens: 0,
        },
      ],
      models: [
        {
          model: "deepseek-flash",
          rows: 2,
          priced_rows: 0,
          unpriced_rows: 1,
          no_token_rows: 1,
          tokens: 900,
          priced_tokens: 0,
          unpriced_tokens: 900,
          cost_micro: 0,
          devices: 1,
        },
      ],
      bill: [],
    });
    expect(result.series[0].mainCny).toBeNull();
    expect(result.series[0].mainAccuracy).toBeNull();
    expect(result.series[0].mainSource).toBe("estimated");
    expect(result.totals.unpricedRows).toBe(1);
    expect(result.totals.noTokenRows).toBe(1);
    expect(result.totals.unpricedTokens).toBe(900);
    expect(result.totals.mainCny).toBeNull();
  });

  it("账单能拆出模型（modelSplit=true）时，非小/主模型的行计入 otherCny 并进入合计", async () => {
    const { result } = await getCostDaily({
      daily: [],
      models: [],
      bill: [
        {
          billDate: "2026-11-01",
          tier: "small",
          model: "qwen-flash",
          settled: true,
          payable: 1_000_000,
        },
        {
          billDate: "2026-11-01",
          tier: "unknown",
          model: "unknown",
          settled: true,
          payable: 250_000,
        },
      ],
    });
    const day1 = result.series[0];
    expect(day1.smallCny).toBe(1);
    expect(day1.otherCny).toBe(0.25);
    expect(day1.totalCny).toBe(1.25);
    expect(result.sources.aliyun.modelSplit).toBe(true);
    expect(result.sources.aliyun.message).toBeNull();
  });

  it("账单拆不出模型（全是 unknown）→ 降级为账号合计并如实标注", async () => {
    const { result } = await getCostDaily({
      daily: [],
      models: [],
      bill: [
        {
          billDate: "2026-11-01",
          tier: "unknown",
          model: "unknown",
          settled: true,
          payable: 800_000,
        },
      ],
    });
    expect(result.sources.aliyun.modelSplit).toBe(false);
    expect(result.sources.aliyun.message).toMatch(/无法按模型拆分/);
    expect(result.series[0].smallCny).toBe(0.8);
    expect(result.series[0].otherCny).toBe(0);
  });
});

describe("LlmCostService.getCostDaily — 数据源状态", () => {
  it("未配置凭证且库里无账单：status=unconfigured、金额 null、合计标 partial，绝不显示 ¥0", async () => {
    const { result, groupBy } = await getCostDaily({
      configured: false,
      bill: [],
      latestBillDate: null,
    });
    expect(result.sources.aliyun.status).toBe("unconfigured");
    expect(result.sources.aliyun.message).toMatch(/未配置/);
    expect(result.series[0].smallCny).toBeNull();
    expect(result.series[0].smallSource).toBe("none");
    expect(result.series[0].totalCny).toBe(1.234567);
    expect(result.totals.smallCny).toBeNull();
    expect(result.totals.otherCny).toBeNull();
    expect(result.totals.partial).toBe(true);
    // 查询只读库、不调 BSS：凭证不在册也照常查账单表（历史数据可能已落库）
    expect(groupBy).toHaveBeenCalled();
  });

  it("凭证已撤但库里留有历史账单 → 照常按账单出数，不因凭证状态清零金额", async () => {
    const { result } = await getCostDaily({ configured: false });
    expect(result.sources.aliyun.status).toBe("ok");
    expect(result.series[0].smallCny).toBe(1.5);
    expect(result.totals.smallCny).toBe(1.3);
    expect(result.totals.partial).toBe(false);
  });

  it("已配置但区间内无账单行：status=no_data（区别于「真的是 0 元」）", async () => {
    const { result } = await getCostDaily({ bill: [], latestBillDate: null });
    expect(result.sources.aliyun.status).toBe("no_data");
    expect(result.sources.aliyun.latestBillDate).toBeNull();
    expect(result.series[0].smallCny).toBeNull();
    expect(result.totals.partial).toBe(true);
  });

  it("有账单：status=ok，并回显最新账单日与抓取时间", async () => {
    const { result } = await getCostDaily();
    expect(result.sources.aliyun).toMatchObject({
      status: "ok",
      kind: "bill",
      latestBillDate: "2026-11-10",
      modelSplit: true,
      daysWithData: 2,
    });
    expect(result.sources.aliyun.latestFetchedAt).toBe(
      "2026-11-11T22:00:00.000Z",
    );
    expect(result.totals.partial).toBe(false);
  });

  it("主模型源回显定价版本与缓存命中覆盖情况", async () => {
    const { result } = await getCostDaily();
    expect(result.sources.deepseek).toEqual({
      status: "ok",
      kind: "estimated",
      pricingVersion: PRICING_VERSION,
      rows: 14,
      pricedRows: 14,
      cacheHitRows: 10,
      upperBoundRows: 4,
      cacheTokenAvailable: true,
    });
    expect(result.pricing.version).toBe(PRICING_VERSION);
    expect(result.pricing.lines.length).toBeGreaterThan(0);
    expect(result.currency).toBe("CNY");
  });

  it("历史行全无缓存字段时 cacheTokenAvailable=false（前端据此打「上界」Tag）", async () => {
    const { result } = await getCostDaily({
      models: [
        {
          model: "deepseek-flash",
          rows: 3,
          priced_rows: 3,
          unpriced_rows: 0,
          no_token_rows: 0,
          cache_hit_rows: 0,
          upper_bound_rows: 3,
          tokens: 300,
          priced_tokens: 300,
          unpriced_tokens: 0,
          cost_micro: 300,
          devices: 1,
        },
      ],
      daily: [],
      bill: [],
    });
    expect(result.sources.deepseek.cacheTokenAvailable).toBe(false);
  });
});

describe("LlmCostService.getCostDaily — 本月与预测", () => {
  it("本月已发生覆盖整个月至今（即使请求区间只有 3 天），预测按有数据天数外推", async () => {
    const { result } = await getCostDaily();
    expect(result.month.cycle).toBe("2026-11");
    expect(result.month.daysInCycle).toBe(30);
    // 11-01/11-02 有数据，11-03 起无 → daysWithData=2
    expect(result.month.daysWithData).toBe(2);
    expect(result.month.toDateCny).toBe(2.934567);
    expect(result.month.toDateSmallCny).toBe(1.3);
    expect(result.month.toDateMainCny).toBe(1.634567);
    // 2.934567 / 2 × 30
    expect(result.month.projectedEndCny).toBe(44.018505);
  });

  it("上月同期无数据时 prevSamePeriodCny 为 null（不是 0），deltaPct 同为 null", async () => {
    const { result } = await getCostDaily();
    expect(result.month.prevSamePeriodCny).toBeNull();
    expect(result.month.deltaPct).toBeNull();
  });

  it("上月同期有数据时给出环比百分比", async () => {
    const { result } = await getCostDaily({
      daily: [
        ...DEFAULT_DAILY,
        {
          day: "2026-10-01",
          model: "deepseek-flash",
          rows: 1,
          priced_rows: 1,
          upper_bound_rows: 0,
          cache_hit_rows: 1,
          cost_micro: 500_000,
          tokens: 100,
          priced_tokens: 100,
        },
      ],
      bill: [
        ...DEFAULT_BILL,
        {
          billDate: "2026-10-01",
          tier: "small",
          model: "qwen-flash",
          settled: true,
          payable: 1_000_000,
        },
      ],
    });
    expect(result.month.prevSamePeriodCny).toBe(1.5);
    expect(result.month.deltaPct).toBe(95.6378);
  });

  it("整月无数据时 month 各金额一律 null，绝不给 0（拿不到数据 ≠ ¥0）", async () => {
    const { result } = await getCostDaily({ daily: [], models: [], bill: [] });
    expect(result.month.daysWithData).toBe(0);
    expect(result.month.projectedEndCny).toBeNull();
    expect(result.month.toDateCny).toBeNull();
    expect(result.month.toDateSmallCny).toBeNull();
    expect(result.month.toDateMainCny).toBeNull();
    expect(result.month.prevSamePeriodCny).toBeNull();
    expect(result.month.partial).toBe(true);
  });

  it("账期内有账单行但金额为 0（全额抵扣）时仍是 0，不得当成缺数据", async () => {
    const { result } = await getCostDaily({
      daily: [],
      models: [],
      bill: [
        {
          billDate: "2026-11-01",
          tier: "small",
          model: "qwen-flash",
          settled: true,
          payable: 0,
        },
      ],
    });
    expect(result.month.daysWithData).toBe(1);
    // 有账单行 → 小模型是真实的 0；主模型无埋点 → 未知，null
    expect(result.month.toDateSmallCny).toBe(0);
    expect(result.month.toDateCny).toBe(0);
    expect(result.month.toDateMainCny).toBeNull();
    expect(result.month.partial).toBe(true);
  });

  it("账期内账单与主模型埋点齐备时 partial=false", async () => {
    const { result } = await getCostDaily();
    expect(result.month.daysWithData).toBe(2);
    expect(result.month.partial).toBe(false);
  });

  it("只有主模型埋点、没有账单时 partial=true 且小模型为 null（不静默按 0 合计）", async () => {
    const { result } = await getCostDaily({ bill: [] });
    expect(result.month.toDateMainCny).not.toBeNull();
    expect(result.month.toDateSmallCny).toBeNull();
    expect(result.month.partial).toBe(true);
  });
});

describe("LlmCostService.getCostDaily — 单位经济性", () => {
  it("小模型金额以账单为真值（source=bill），主模型以快照估算（source=estimated）", async () => {
    const { result } = await getCostDaily();
    const byModel = Object.fromEntries(
      result.unitEconomics.map((row: { model: string }) => [row.model, row]),
    );
    expect(byModel["qwen-flash"]).toMatchObject({
      tier: "small",
      source: "bill",
      cny: 1.3,
      tokens: 20_000,
      cnyPerMillionTokens: 65,
      tokenActiveDevices: 5,
      daysWithData: 1,
      cnyPerDevicePerDay: 0.26,
    });
    expect(byModel["deepseek-flash"]).toMatchObject({
      tier: "main",
      source: "estimated",
      cny: 1.634567,
      tokens: 7_000,
      cnyPerMillionTokens: 233.5096,
      tokenActiveDevices: 5,
      daysWithData: 2,
      cnyPerDevicePerDay: 0.163457,
    });
  });

  it("无账单时小模型退回估算口径", async () => {
    const { result } = await getCostDaily({ bill: [] });
    const qwen = result.unitEconomics.find(
      (row: { model: string }) => row.model === "qwen-flash",
    );
    expect(qwen).toMatchObject({ source: "estimated", cny: 0.3 });
    expect(qwen?.cnyPerMillionTokens).toBe(15);
  });

  it("token 为 0 时单价为 null（不出 Infinity/NaN）", async () => {
    const { result } = await getCostDaily({
      daily: [],
      bill: [],
      models: [
        {
          model: "deepseek-flash",
          rows: 1,
          priced_rows: 0,
          unpriced_rows: 1,
          no_token_rows: 1,
          tokens: 0,
          priced_tokens: 0,
          unpriced_tokens: 0,
          cost_micro: 0,
          devices: 0,
        },
      ],
    });
    expect(result.unitEconomics[0]).toMatchObject({
      cnyPerMillionTokens: null,
      cnyPerDevicePerDay: null,
      tokenActiveDevices: 0,
    });
  });
});

describe("LlmCostService.getCostDaily — 对账", () => {
  it("只比已终账的账单日：token 估算 vs 账单真值给出偏差百分比", async () => {
    const { result } = await getCostDaily(
      {
        daily: [
          {
            day: "2026-06-01",
            model: "qwen-flash",
            rows: 5,
            priced_rows: 5,
            upper_bound_rows: 5,
            cache_hit_rows: 0,
            cost_micro: 1_200_000,
            tokens: 5_000,
            priced_tokens: 5_000,
          },
          {
            day: "2026-06-02",
            model: "qwen-flash",
            rows: 5,
            priced_rows: 5,
            upper_bound_rows: 5,
            cache_hit_rows: 0,
            cost_micro: 900_000,
            tokens: 5_000,
            priced_tokens: 5_000,
          },
        ],
        models: [],
        bill: [
          {
            billDate: "2026-06-01",
            tier: "small",
            model: "qwen-flash",
            settled: true,
            payable: 1_000_000,
          },
          {
            billDate: "2026-06-02",
            tier: "small",
            model: "qwen-flash",
            settled: false, // 未终账 → 排除
            payable: 700_000,
          },
        ],
      },
      "2026-06-01",
      "2026-06-02",
    );
    expect(result.reconciliation).toEqual({
      status: "ok",
      days: 1,
      smallEstimatedCny: 1.2,
      smallBilledCny: 1,
      deltaPct: 20,
    });
  });

  it("没有已终账的账单日 → status=insufficient，deltaPct 为 null", async () => {
    const { result } = await getCostDaily();
    expect(result.reconciliation).toEqual({
      status: "insufficient",
      days: 0,
      smallEstimatedCny: 0,
      smallBilledCny: 0,
      deltaPct: null,
    });
  });

  it("账单真值为 0 时不除零", async () => {
    const { result } = await getCostDaily({
      daily: [],
      models: [],
      bill: [
        {
          billDate: "2026-11-01",
          tier: "small",
          model: "qwen-flash",
          settled: true,
          payable: 0,
        },
      ],
    });
    expect(result.reconciliation.status).toBe("ok");
    expect(result.reconciliation.deltaPct).toBeNull();
  });
});

describe("LlmCostService.getCostDaily — 查询范围", () => {
  it("埋点日分组的查询窗口覆盖上月同期至今日（本月/环比复用同一次查询）", async () => {
    const { queryRaw } = await getCostDaily({}, "2026-11-05", "2026-11-08");
    const dailyCall = queryRaw.mock.calls.find((call) =>
      (call[0] as TemplateStringsArray).join("?").includes("AS day"),
    );
    expect(dailyCall).toBeDefined();
    // 参数：窗口起（上月 1 日）、窗口止（昨日 +1 天的开区间上界）
    const params = (dailyCall as unknown[]).slice(1);
    expect(params[0]).toEqual(new Date("2026-10-01T00:00:00+08:00"));
    expect(params[1]).toEqual(new Date("2026-11-12T00:00:00+08:00"));
  });

  it("账单按 billDate 字符串区间过滤，走 @@index([billDate])", async () => {
    const { groupBy } = await getCostDaily({}, "2026-11-05", "2026-11-08");
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["billDate", "tier", "model", "settled"],
        where: expect.objectContaining({
          billDate: { gte: "2026-10-01", lte: "2026-11-11" },
        }),
      }),
    );
  });
});
