import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  BillingSyncService,
  buildDedupeKey,
  isSettled,
  recentBillDates,
} from "./billing-sync.service";
import {
  AliyunBillClient,
  AliyunBillUnavailableError,
  type AliyunBillItem,
} from "./aliyun-bill.client";

/**
 * 账单同步单测：全程 mock，不出网。
 * 重点覆盖熊总要求的硬断言——同一批数据同步两次，落库行数与金额合计必须完全不变
 * （防 dedupeKey 失效导致 BSS 账单被重复计入）。
 */

function billRow(overrides: Partial<AliyunBillItem> = {}): AliyunBillItem {
  return {
    billDate: "2026-11-10",
    billingCycle: "2026-11",
    productCode: "bailian",
    productName: "大模型服务平台百炼",
    billingItem: "模型推理",
    billingItemCode: "bailian_infer",
    instanceId: "qwen-flash",
    model: "qwen-flash",
    itemKind: "PayAsYouGoBill",
    subscriptionType: "PayAsYouGo",
    usage: 1000,
    usageUnit: "Token",
    grossMicroCny: 200000,
    payableMicroCny: 100000,
    cashMicroCny: 50000,
    resourcePackMicroCny: 20000,
    couponMicroCny: 3000,
    currency: "CNY",
    ...overrides,
  };
}

interface UpsertArgs {
  where: { dedupeKey: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

/** Map 模拟 llm_cost_daily：dedupeKey 为唯一键，重复 upsert 覆盖而非追加 */
function createPrismaStub() {
  const table = new Map<string, Record<string, unknown>>();
  const upsert = jest.fn(async (args: UpsertArgs) => {
    const key = args.where.dedupeKey;
    const existing = table.get(key);
    const row = existing ? { ...existing, ...args.update } : { ...args.create };
    table.set(key, row);
    return row;
  });
  return {
    table,
    stub: { llmCostDaily: { upsert } },
    upsert,
    totalPayableMicro: () =>
      [...table.values()].reduce(
        (sum, row) => sum + Number(row.payableMicroCny ?? 0),
        0,
      ),
  };
}

async function buildService(
  env: Record<string, string>,
  rows: AliyunBillItem[] = [],
) {
  const prisma = createPrismaStub();
  const fetchBillingItems = jest.fn(async () => rows);
  const isConfigured = jest.fn(() => true);
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      BillingSyncService,
      { provide: PrismaService, useValue: prisma.stub },
      {
        provide: AliyunBillClient,
        useValue: { fetchBillingItems, isConfigured },
      },
      {
        provide: ConfigService,
        useValue: { get: jest.fn((key: string) => env[key]) },
      },
    ],
  }).compile();
  return {
    service: module.get(BillingSyncService),
    prisma,
    fetchBillingItems,
    isConfigured,
    module,
  };
}

describe("recentBillDates（北京时间 T-1..T-N）", () => {
  it("按自然日倒推，跨月与跨年正确", () => {
    expect(recentBillDates(new Date("2026-11-12T04:00:00Z"), 3)).toEqual([
      "2026-11-11",
      "2026-11-10",
      "2026-11-09",
    ]);
    // 北京时间 2026-11-01 10:00（UTC 02:00）→ T-1 落在上月
    expect(recentBillDates(new Date("2026-11-01T02:00:00Z"), 3)).toEqual([
      "2026-10-31",
      "2026-10-30",
      "2026-10-29",
    ]);
    // 北京时间 2027-01-01 09:00（UTC 01:00）→ 跨年
    expect(recentBillDates(new Date("2027-01-01T01:00:00Z"), 2)).toEqual([
      "2026-12-31",
      "2026-12-30",
    ]);
  });

  it("UTC 深夜仍按北京时间取日（容器无 TZ 也正确）", () => {
    // 2026-11-11T17:00Z = 北京时间 2026-11-12 01:00 → T-1 = 11-11
    expect(recentBillDates(new Date("2026-11-11T17:00:00Z"), 1)).toEqual([
      "2026-11-11",
    ]);
  });

  it("lookback 非法时回落默认 3 天", () => {
    expect(recentBillDates(new Date("2026-11-12T04:00:00Z"), 0)).toHaveLength(
      3,
    );
    expect(recentBillDates(new Date("2026-11-12T04:00:00Z"), -5)).toHaveLength(
      3,
    );
  });
});

describe("isSettled（终账：账期次月 3 日 12:00 北京时间后）", () => {
  it("当月账单未终账", () => {
    expect(isSettled("2026-11-10", new Date("2026-11-20T00:00:00Z"))).toBe(
      false,
    );
  });

  it("次月 3 日 12:00（北京）之前仍未终账", () => {
    // 北京 2026-12-03 11:59 = UTC 03:59
    expect(isSettled("2026-11-10", new Date("2026-12-03T03:59:00Z"))).toBe(
      false,
    );
  });

  it("次月 3 日 12:00（北京）之后为终账", () => {
    expect(isSettled("2026-11-10", new Date("2026-12-03T04:00:00Z"))).toBe(
      true,
    );
    expect(isSettled("2026-11-10", new Date("2027-01-01T00:00:00Z"))).toBe(
      true,
    );
  });

  it("跨年账期正确", () => {
    expect(isSettled("2026-12-31", new Date("2027-01-03T03:59:00Z"))).toBe(
      false,
    );
    expect(isSettled("2026-12-31", new Date("2027-02-03T04:00:00Z"))).toBe(
      true,
    );
  });
});

describe("buildDedupeKey（幂等键）", () => {
  it("同一行两次构造结果一致", () => {
    const row = billRow();
    expect(buildDedupeKey(row)).toBe(buildDedupeKey(row));
  });

  it("不同 model 的行 key 不同（防同一天同计费项互相覆盖）", () => {
    expect(buildDedupeKey(billRow({ model: "qwen-flash" }))).not.toBe(
      buildDedupeKey(billRow({ model: "qwen-plus" })),
    );
  });

  it("退款/调账与正常账单 key 不同（负数行不被覆盖）", () => {
    expect(buildDedupeKey(billRow({ itemKind: "PayAsYouGoBill" }))).not.toBe(
      buildDedupeKey(billRow({ itemKind: "Refund" })),
    );
  });

  it("日期、实例、计费项代码、订阅类型都参与区分", () => {
    const base = buildDedupeKey(billRow());
    expect(buildDedupeKey(billRow({ billDate: "2026-11-09" }))).not.toBe(base);
    expect(buildDedupeKey(billRow({ instanceId: "other" }))).not.toBe(base);
    expect(buildDedupeKey(billRow({ billingItemCode: "other" }))).not.toBe(
      base,
    );
    expect(
      buildDedupeKey(billRow({ subscriptionType: "Subscription" })),
    ).not.toBe(base);
  });

  it("值里含分隔符也不会碰撞", () => {
    expect(
      buildDedupeKey(billRow({ billingItem: 'a"|b', model: "c" })),
    ).not.toBe(buildDedupeKey(billRow({ billingItem: "a", model: 'b"|c' })));
  });
});

describe("BillingSyncService", () => {
  /** onModuleInit 的首轮同步是 fire-and-forget（不阻塞启动），测试需冲刷微任务 */
  const flush = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("未开启 LLM_COST_SYNC_ENABLED：不拉账单、不设定时器", async () => {
    const { service, fetchBillingItems } = await buildService({}, [billRow()]);
    const setIntervalSpy = jest.spyOn(global, "setInterval");
    await service.onModuleInit();
    await flush();
    expect(fetchBillingItems).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("开启后 onModuleInit 立即补拉 T-1..T-3 并设置可 unref 的定时器", async () => {
    const { service, fetchBillingItems } = await buildService(
      { LLM_COST_SYNC_ENABLED: "true" },
      [billRow()],
    );
    const unref = jest.fn();
    const setIntervalSpy = jest
      .spyOn(global, "setInterval")
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);
    jest.spyOn(global, "clearInterval");

    await service.onModuleInit();
    await flush();

    expect(fetchBillingItems).toHaveBeenCalledTimes(3);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(360 * 60 * 1000);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("间隔与回溯天数可由 env 覆盖", async () => {
    const { service, fetchBillingItems } = await buildService(
      {
        LLM_COST_SYNC_ENABLED: "true",
        LLM_COST_SYNC_INTERVAL_MINUTES: "60",
        LLM_COST_SYNC_LOOKBACK_DAYS: "1",
      },
      [billRow()],
    );
    const setIntervalSpy = jest
      .spyOn(global, "setInterval")
      .mockReturnValue({ unref: jest.fn() } as unknown as NodeJS.Timeout);

    await service.onModuleInit();
    await flush();

    expect(fetchBillingItems).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(60 * 60 * 1000);
  });

  it("onModuleDestroy 清定时器", async () => {
    const { service } = await buildService(
      { LLM_COST_SYNC_ENABLED: "true" },
      [],
    );
    const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
    jest.spyOn(global, "setInterval").mockReturnValue(timer);
    const clearIntervalSpy = jest.spyOn(global, "clearInterval");

    await service.onModuleInit();
    await flush();
    await service.onModuleDestroy();

    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });

  it("硬断言：同一批账单同步两次，行数与应付合计完全不变", async () => {
    const rows = [
      billRow(),
      billRow({
        model: "qwen-plus",
        instanceId: "qwen-plus",
        payableMicroCny: 700000,
      }),
      billRow({
        itemKind: "Refund",
        payableMicroCny: -100000,
        grossMicroCny: -100000,
      }),
    ];
    const { service, prisma } = await buildService({}, rows);

    const first = await service.syncDay("2026-11-10");
    const rowsAfterFirst = prisma.table.size;
    const totalAfterFirst = prisma.totalPayableMicro();

    const second = await service.syncDay("2026-11-10");

    expect(first.upserted).toBe(3);
    expect(second.upserted).toBe(3);
    expect(prisma.table.size).toBe(rowsAfterFirst);
    expect(prisma.totalPayableMicro()).toBe(totalAfterFirst);
    expect(prisma.totalPayableMicro()).toBe(700000); // 100000 + 700000 - 100000
  });

  it("upsert 以 dedupeKey 为唯一条件（可空列不参与，ON CONFLICT 才生效）", async () => {
    const { service, prisma } = await buildService({}, [billRow()]);
    await service.syncDay("2026-11-10");
    const args = prisma.upsert.mock.calls[0][0] as UpsertArgs;
    expect(Object.keys(args.where)).toEqual(["dedupeKey"]);
    expect(args.create.model).toBe("qwen-flash");
    expect(args.create.tier).toBe("small");
    expect(args.create.settled).toBe(false);
  });

  it("tier 按 model 名映射：qwen→small，deepseek→main，认不出→unknown", async () => {
    const { service, prisma } = await buildService({}, [
      billRow({ model: "qwen-flash", instanceId: "qwen-flash" }),
      billRow({ model: "deepseek-flash", instanceId: "deepseek-flash" }),
      billRow({ model: "unknown", instanceId: "i-abc" }),
    ]);
    await service.syncDay("2026-11-10");
    expect([...prisma.table.values()].map((row) => row.tier).sort()).toEqual([
      "main",
      "small",
      "unknown",
    ]);
  });

  it("凭证不可用：状态 unconfigured，不写库，不抛（页面显示「未接入」而不是 ¥0）", async () => {
    const { service, prisma } = await buildService({}, [billRow()]);
    (service as unknown as { billClient: AliyunBillClient }).billClient = {
      fetchBillingItems: jest.fn(async () => {
        throw new AliyunBillUnavailableError("未配置凭证");
      }),
      isConfigured: () => false,
    } as unknown as AliyunBillClient;

    const result = await service.syncRecent(new Date("2026-11-12T04:00:00Z"));

    expect(result.status).toBe("unconfigured");
    expect(prisma.table.size).toBe(0);
  });

  it("单天失败不影响其他天，整体状态为 error 且带可诊断信息", async () => {
    const { service, prisma, fetchBillingItems } = await buildService({}, [
      billRow(),
    ]);
    fetchBillingItems
      .mockRejectedValueOnce(new Error("Throttling.User requestId=req-1"))
      .mockResolvedValueOnce([billRow({ billDate: "2026-11-10" })])
      .mockResolvedValueOnce([billRow({ billDate: "2026-11-09" })]);

    const result = await service.syncRecent(new Date("2026-11-12T04:00:00Z"));

    expect(result.status).toBe("error");
    expect(result.days).toHaveLength(3);
    expect(result.days[0]).toEqual(
      expect.objectContaining({ billDate: "2026-11-11", status: "error" }),
    );
    expect(result.days[1]).toEqual(
      expect.objectContaining({
        billDate: "2026-11-10",
        status: "ok",
        upserted: 1,
      }),
    );
    expect(prisma.table.size).toBe(2);
  });

  it("全部成功时状态 ok，并记录最新账单日", async () => {
    const { service } = await buildService({}, [billRow()]);
    const result = await service.syncRecent(new Date("2026-11-12T04:00:00Z"));
    expect(result.status).toBe("ok");
    expect(result.latestBillDate).toBe("2026-11-11");
  });

  it("空账单日（当日账单未出）记为空，不补 0", async () => {
    const { service, prisma } = await buildService({}, []);
    const result = await service.syncDay("2026-11-11");
    expect(result).toEqual(
      expect.objectContaining({
        billDate: "2026-11-11",
        status: "empty",
        upserted: 0,
      }),
    );
    expect(prisma.table.size).toBe(0);
  });

  it("已过终账时点的账单日标记 settled=true", async () => {
    const { service, prisma } = await buildService({}, [
      billRow({ billDate: "2026-10-10" }),
    ]);
    await service.syncDay("2026-10-10", new Date("2026-12-01T00:00:00Z"));
    expect([...prisma.table.values()][0].settled).toBe(true);
  });
});
