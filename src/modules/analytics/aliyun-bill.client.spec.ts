import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import {
  AliyunBillClient,
  AliyunBillUnavailableError,
  parseModelName,
} from "./aliyun-bill.client";

/**
 * 阿里云 BSS 账单客户端单测：全程 mock SDK，不出网（仓库铁律）。
 * 断言重点落在两处会静默算错钱的地方：
 * 1) billingCycle 必须由 billingDate 逐日推导（跨月错配时官方按 BillingCycle 返回整月数据）；
 * 2) billDate 必须取响应里的 item.billingDate，与请求不一致就报错而不是入库。
 */
const mockDescribeBill = jest.fn();
const mockCredentialCtor = jest.fn();
const mockBssCtor = jest.fn();

jest.mock("@alicloud/bssopenapi20171214", () => ({
  __esModule: true,
  default: function CtorStub(config: unknown) {
    mockBssCtor(config);
    return { describeInstanceBillWithOptions: mockDescribeBill };
  },
  DescribeInstanceBillRequest: class {
    constructor(map?: Record<string, unknown>) {
      Object.assign(this, map);
    }
  },
}));

jest.mock("@alicloud/credentials", () => ({
  __esModule: true,
  default: function CredentialStub(config?: unknown) {
    mockCredentialCtor(config);
    return { __stub: true };
  },
  Config: class {
    constructor(map?: Record<string, unknown>) {
      Object.assign(this, map);
    }
  },
}));

const RAM_ENV = { ALIYUN_BSS_USE_RAM_ROLE: "true" };
const AK_ENV = {
  ALIYUN_BSS_ACCESS_KEY_ID: "test-ak-id",
  ALIYUN_BSS_ACCESS_KEY_SECRET: "test-ak-secret",
};

/** 一天的计费项账单响应（字段名与 SDK 模型一致，camelCase） */
function billResponse(items: Record<string, unknown>[], nextToken?: string) {
  return {
    statusCode: 200,
    body: {
      code: "Success",
      success: true,
      message: "Successful!",
      requestId: "req-1",
      data: { items, nextToken, totalCount: items.length },
    },
  };
}

function billItem(overrides: Record<string, unknown> = {}) {
  return {
    billingDate: "2026-11-10",
    billingCycle: "2026-11",
    productCode: "bailian",
    productName: "大模型服务平台百炼",
    billingItem: "模型推理",
    billingItemCode: "bailian_infer",
    instanceID: "qwen-flash",
    item: "PayAsYouGoBill",
    subscriptionType: "PayAsYouGo",
    usage: "1000",
    usageUnit: "Token",
    pretaxGrossAmount: 0.123456,
    pretaxAmount: 0.1,
    paymentAmount: 0.05,
    deductedByResourcePackage: "0.02",
    deductedByCashCoupons: 0.003,
    currency: "CNY",
    ...overrides,
  };
}

async function buildClient(
  env: Record<string, string>,
): Promise<AliyunBillClient> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AliyunBillClient,
      {
        provide: ConfigService,
        useValue: { get: jest.fn((key: string) => env[key]) },
      },
    ],
  }).compile();
  return module.get(AliyunBillClient);
}

describe("AliyunBillClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("凭证解析", () => {
    it("既无 AK/SK 也未开启 RAM 角色 → isConfigured()=false，且不构造 SDK 客户端", async () => {
      const client = await buildClient({});
      expect(client.isConfigured()).toBe(false);
      await expect(
        client.fetchBillingItems("2026-11-10"),
      ).rejects.toBeInstanceOf(AliyunBillUnavailableError);
      expect(mockBssCtor).not.toHaveBeenCalled();
      expect(mockDescribeBill).not.toHaveBeenCalled();
    });

    it("显式 AK/SK → 用 access_key 类型凭证（可只授只读 BSS 权限）", async () => {
      const client = await buildClient(AK_ENV);
      mockDescribeBill.mockResolvedValueOnce(billResponse([billItem()]));
      expect(client.isConfigured()).toBe(true);
      await client.fetchBillingItems("2026-11-10");
      expect(mockCredentialCtor).toHaveBeenCalledWith({
        type: "access_key",
        accessKeyId: "test-ak-id",
        accessKeySecret: "test-ak-secret",
      });
    });

    it("未配 AK/SK 但开启 RAM 角色 → 走默认凭证链（ECS 实例角色，凭证自动轮转）", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill.mockResolvedValueOnce(billResponse([billItem()]));
      expect(client.isConfigured()).toBe(true);
      await client.fetchBillingItems("2026-11-10");
      expect(mockCredentialCtor).toHaveBeenCalledWith(undefined);
    });

    it("endpoint 可覆盖，默认 business.aliyuncs.com", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill.mockResolvedValueOnce(billResponse([billItem()]));
      await client.fetchBillingItems("2026-11-10");
      expect(mockBssCtor).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: "business.aliyuncs.com" }),
      );
    });
  });

  describe("请求参数", () => {
    it("billingCycle 由 billingDate 推导，DAILY + 计费项维度 + 分页上限 300", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill.mockResolvedValueOnce(billResponse([billItem()]));
      await client.fetchBillingItems("2026-11-10");
      expect(mockDescribeBill).toHaveBeenCalledWith(
        expect.objectContaining({
          billingCycle: "2026-11",
          billingDate: "2026-11-10",
          granularity: "DAILY",
          isBillingItem: true,
          maxResults: 300,
        }),
        expect.objectContaining({ autoretry: true, maxAttempts: 3 }),
      );
    });

    it("跨月日期各自推导账期（10-31 → 2026-10）", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill.mockResolvedValueOnce(
        billResponse([
          billItem({ billingDate: "2026-10-31", billingCycle: "2026-10" }),
        ]),
      );
      await client.fetchBillingItems("2026-10-31");
      expect(mockDescribeBill).toHaveBeenCalledWith(
        expect.objectContaining({
          billingCycle: "2026-10",
          billingDate: "2026-10-31",
        }),
        expect.anything(),
      );
    });

    it("配了 ALIYUN_BSS_PRODUCT_CODE 才下推过滤，否则拉全量由上层识别", async () => {
      const client = await buildClient({
        ...RAM_ENV,
        ALIYUN_BSS_PRODUCT_CODE: "bailian",
      });
      mockDescribeBill.mockResolvedValueOnce(billResponse([billItem()]));
      await client.fetchBillingItems("2026-11-10");
      expect(mockDescribeBill).toHaveBeenCalledWith(
        expect.objectContaining({ productCode: "bailian" }),
        expect.anything(),
      );
    });

    it("非法日期格式直接 400 式报错，不发请求", async () => {
      const client = await buildClient(RAM_ENV);
      await expect(client.fetchBillingItems("2026-11")).rejects.toThrow(
        /YYYY-MM-DD/,
      );
      expect(mockDescribeBill).not.toHaveBeenCalled();
    });
  });

  describe("分页", () => {
    it("nextToken 非空则续拉并合并，第二页带上 nextToken", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill
        .mockResolvedValueOnce(
          billResponse([billItem({ instanceID: "qwen-flash" })], "page-2"),
        )
        .mockResolvedValueOnce(
          billResponse([billItem({ instanceID: "qwen-plus" })]),
        );
      const rows = await client.fetchBillingItems("2026-11-10");
      expect(rows).toHaveLength(2);
      expect(mockDescribeBill).toHaveBeenCalledTimes(2);
      expect(mockDescribeBill.mock.calls[1][0]).toEqual(
        expect.objectContaining({ nextToken: "page-2" }),
      );
    });

    it("分页超过上限时中止并报错，避免限流下无限拉取", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill.mockResolvedValue(
        billResponse([billItem()], "always-more"),
      );
      await expect(client.fetchBillingItems("2026-11-10")).rejects.toThrow(
        /分页/,
      );
    });
  });

  describe("金额换算（元 → micro-CNY）", () => {
    it("原价/应付/现金按 1e6 放大，资源包 string 也解析，代金券四舍五入", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill.mockResolvedValueOnce(billResponse([billItem()]));
      const [row] = await client.fetchBillingItems("2026-11-10");
      expect(row.grossMicroCny).toBe(123456);
      expect(row.payableMicroCny).toBe(100000);
      expect(row.cashMicroCny).toBe(50000);
      expect(row.resourcePackMicroCny).toBe(20000); // "0.02" 是 string
      expect(row.couponMicroCny).toBe(3000);
      expect(row.currency).toBe("CNY");
      expect(row.usage).toBe(1000); // usage 是 string，转数
      expect(row.usageUnit).toBe("Token");
    });

    it("退款/调账为负数时保留符号，不取绝对值", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill.mockResolvedValueOnce(
        billResponse([
          billItem({
            item: "Refund",
            pretaxGrossAmount: -0.5,
            pretaxAmount: -0.5,
            paymentAmount: -0.5,
          }),
        ]),
      );
      const [row] = await client.fetchBillingItems("2026-11-10");
      expect(row.itemKind).toBe("Refund");
      expect(row.grossMicroCny).toBe(-500000);
      expect(row.payableMicroCny).toBe(-500000);
      expect(row.cashMicroCny).toBe(-500000);
    });

    it("金额字段缺失或非法时按 0 处理，不产生 NaN", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill.mockResolvedValueOnce(
        billResponse([
          billItem({
            pretaxGrossAmount: null,
            pretaxAmount: undefined,
            usage: "-",
          }),
        ]),
      );
      const [row] = await client.fetchBillingItems("2026-11-10");
      expect(row.grossMicroCny).toBe(0);
      expect(row.payableMicroCny).toBe(0);
      expect(row.usage).toBeNull();
    });
  });

  describe("日期一致性护栏", () => {
    it("billDate 取响应值", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill.mockResolvedValueOnce(billResponse([billItem()]));
      const [row] = await client.fetchBillingItems("2026-11-10");
      expect(row.billDate).toBe("2026-11-10");
      expect(row.billingCycle).toBe("2026-11");
    });

    it("响应 billingDate 与请求不一致 → 抛错（防止整月数据被当单日入账）", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill.mockResolvedValueOnce(
        billResponse([billItem({ billingDate: "2026-11-01" })]),
      );
      await expect(client.fetchBillingItems("2026-11-10")).rejects.toThrow(
        /billingDate/i,
      );
    });

    it("响应缺 billingDate（非 DAILY 语义）→ 抛错", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill.mockResolvedValueOnce(
        billResponse([billItem({ billingDate: undefined })]),
      );
      await expect(client.fetchBillingItems("2026-11-10")).rejects.toThrow(
        /billingDate/i,
      );
    });
  });

  describe("上游错误", () => {
    it("success=false 或 code!=Success 时抛错并带 requestId", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill.mockResolvedValueOnce({
        statusCode: 200,
        body: {
          code: "Throttling.User",
          success: false,
          message: "限流",
          requestId: "req-9",
        },
      });
      await expect(client.fetchBillingItems("2026-11-10")).rejects.toThrow(
        /req-9/,
      );
    });

    it("SDK 抛错时原样上抛，由 sync 服务记为 error 而不是当成 ¥0", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill.mockRejectedValueOnce(
        new Error("InvalidAccessKeyId.NotFound"),
      );
      await expect(client.fetchBillingItems("2026-11-10")).rejects.toThrow(
        /InvalidAccessKeyId/,
      );
    });
  });

  describe("probeProducts", () => {
    it("返回去重的 productCode/productName，用于确认百炼 ProductCode", async () => {
      const client = await buildClient(RAM_ENV);
      mockDescribeBill.mockResolvedValueOnce(
        billResponse([
          billItem({
            productCode: "bailian",
            productName: "大模型服务平台百炼",
          }),
          billItem({
            productCode: "bailian",
            productName: "大模型服务平台百炼",
          }),
          billItem({ productCode: "ecs", productName: "云服务器 ECS" }),
        ]),
      );
      const products = await client.probeProducts("2026-11-10");
      expect(products).toEqual([
        { productCode: "bailian", productName: "大模型服务平台百炼" },
        { productCode: "ecs", productName: "云服务器 ECS" },
      ]);
    });
  });

  describe("parseModelName", () => {
    it.each([
      [{ instanceID: "qwen-flash" }, "qwen-flash"],
      [{ billingItem: "qwen-flash-输入" }, "qwen-flash"],
      [{ itemName: "deepseek-chat 调用" }, "deepseek-chat"],
      [{ billingItem: "QWEN-PLUS 推理" }, "qwen-plus"],
      [{ billingItem: "模型推理", instanceID: "i-abc123" }, "unknown"],
      [{}, "unknown"],
    ])("%j → %s", (item, expected) => {
      expect(parseModelName(item)).toBe(expected);
    });
  });
});
