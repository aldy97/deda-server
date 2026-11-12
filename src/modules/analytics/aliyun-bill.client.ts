import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import BssClient, {
  DescribeInstanceBillRequest,
} from "@alicloud/bssopenapi20171214";
import Credential, { Config as CredentialConfig } from "@alicloud/credentials";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import * as $dara from "@darabonba/typescript";
import { MICRO_PER_CNY } from "../llm/llm-cost.util";

/**
 * 阿里云 BSS（费用中心）账单客户端。
 *
 * 只读用途：DescribeInstanceBill 拉「计费项 × 日」账单，作为小模型（百炼 qwen-flash）金额的真值。
 * 官方约束（help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-describeinstancebill）：
 * - BillingCycle 必填；Granularity=DAILY 时 BillingDate 必填，且两者月份必须一致，
 *   否则「查询结果按 BillingCycle 返回」→ 会拿到整月数据，静默放大约 30 倍；
 * - 单用户限流 10 笔/秒；MaxResults 默认 20、最大 300，需 NextToken 分页；
 * - 账单相对实际消耗延迟 24h，实例信息延迟 48h；当月数据不作对账依据，终账次月 3 日 12 点后可查；
 * - DeductedByResourcePackage / Usage / ListPrice 是 string，需自行转数。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RESULTS = 300;
/** 单日账单最多翻 50 页（15000 行）；超出说明上游异常，报错而不是无限拉取触发限流 */
const MAX_PAGES = 50;
const DEFAULT_ENDPOINT = "business.aliyuncs.com";

/** 模型名识别：账单里模型名可能出现在实例 ID / 计费项 / 项目名中 */
const MODEL_PATTERN =
  /(qwen[a-z0-9]*(?:[-.][a-z0-9]+)*|deepseek[a-z0-9]*(?:[-.][a-z0-9]+)*|paraformer[a-z0-9]*(?:[-.][a-z0-9]+)*|text-embedding[a-z0-9]*(?:[-.][a-z0-9]+)*|wanx?[a-z0-9]*(?:[-.][a-z0-9]+)*)/i;

export class AliyunBillUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AliyunBillUnavailableError";
  }
}

/** BSS 计费项原始字段（SDK 模型为 camelCase，注意 instanceID / ownerID 的大小写） */
interface BillItemRaw {
  billingDate?: string;
  billingCycle?: string;
  productCode?: string;
  productName?: string;
  productDetail?: string;
  billingItem?: string;
  billingItemCode?: string;
  instanceID?: string;
  itemName?: string;
  item?: string;
  subscriptionType?: string;
  usage?: string;
  usageUnit?: string;
  pretaxGrossAmount?: number;
  pretaxAmount?: number;
  paymentAmount?: number;
  deductedByResourcePackage?: string;
  deductedByCashCoupons?: number;
  currency?: string;
}

/** 归一化后的账单行：金额一律 micro-CNY（与 llm_usage_logs.costMicroCny 同单位） */
export interface AliyunBillItem {
  billDate: string;
  billingCycle: string;
  productCode: string;
  productName: string | null;
  billingItem: string;
  billingItemCode: string;
  instanceId: string;
  model: string;
  itemKind: string;
  subscriptionType: string;
  usage: number | null;
  usageUnit: string | null;
  grossMicroCny: number;
  payableMicroCny: number;
  cashMicroCny: number;
  resourcePackMicroCny: number;
  couponMicroCny: number;
  currency: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 元 → micro-CNY；缺失或非法按 0（不产生 NaN 污染 SUM） */
function toMicroCny(value: unknown): number {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : NaN;
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * MICRO_PER_CNY);
}

/** 用量转数；官方语义是「周期内累加值」，只作展示，不当 token 真值 */
function toUsageCount(value: unknown): number | null {
  const num =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value.trim())
        : NaN;
  if (!Number.isFinite(num)) return null;
  return Math.round(num);
}

/**
 * 从账单行里认模型名；认不出返回 "unknown"（接口据此把口径降级为「百炼账号合计」）。
 * 真实账单的字段落位需 Step 0-B 实测确认，故三个字段依次尝试，且保留原始字段入库以便修正。
 */
export function parseModelName(item: {
  instanceID?: string | null;
  billingItem?: string | null;
  itemName?: string | null;
  productDetail?: string | null;
}): string {
  const candidates = [
    item.instanceID,
    item.billingItem,
    item.itemName,
    item.productDetail,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate === "") continue;
    const matched = MODEL_PATTERN.exec(candidate);
    if (matched) return matched[1].toLowerCase();
  }
  return "unknown";
}

@Injectable()
export class AliyunBillClient {
  private readonly logger = new Logger(AliyunBillClient.name);
  private client: BssClient | null = null;

  constructor(private readonly configService: ConfigService) {}

  /**
   * 是否具备调用条件。RAM 角色路径无法离线判定可用性（要连 IMDS 才知道），
   * 因此以显式开关 ALIYUN_BSS_USE_RAM_ROLE=true 表达意图；真实失败由调用方记为 error。
   */
  isConfigured(): boolean {
    const accessKeyId = text(
      this.configService.get<string>("ALIYUN_BSS_ACCESS_KEY_ID"),
    );
    const accessKeySecret = text(
      this.configService.get<string>("ALIYUN_BSS_ACCESS_KEY_SECRET"),
    );
    if (accessKeyId && accessKeySecret) return true;
    return this.configService.get<string>("ALIYUN_BSS_USE_RAM_ROLE") === "true";
  }

  /** 拉某一天的计费项账单（自动分页）。billingDate: YYYY-MM-DD（北京时间自然日） */
  async fetchBillingItems(billingDate: string): Promise<AliyunBillItem[]> {
    if (!DATE_RE.test(billingDate)) {
      throw new Error(`billingDate 需为 YYYY-MM-DD 格式，收到：${billingDate}`);
    }
    const client = this.ensureClient();
    const billingCycle = billingDate.slice(0, 7);
    const productCode = text(
      this.configService.get<string>("ALIYUN_BSS_PRODUCT_CODE"),
    );
    const runtime = new $dara.RuntimeOptions({
      autoretry: true,
      maxAttempts: 3,
      connectTimeout: 5000,
      readTimeout: 15000,
    });

    const rows: AliyunBillItem[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const request = new DescribeInstanceBillRequest({
        billingCycle,
        billingDate,
        granularity: "DAILY",
        isBillingItem: true,
        maxResults: MAX_RESULTS,
        ...(productCode ? { productCode } : {}),
        ...(nextToken ? { nextToken } : {}),
      });
      const response = await client.describeInstanceBillWithOptions(
        request,
        runtime,
      );
      const body = response?.body;
      if (
        !body ||
        body.success === false ||
        (body.code && body.code !== "Success")
      ) {
        throw new Error(
          `BSS DescribeInstanceBill 失败：code=${body?.code ?? "(none)"} ` +
            `message=${body?.message ?? "(none)"} requestId=${body?.requestId ?? "(none)"}`,
        );
      }
      const items = (body.data?.items ?? []) as BillItemRaw[];
      for (const item of items) {
        rows.push(this.toRow(item, billingDate));
      }
      nextToken = body.data?.nextToken || undefined;
      if (!nextToken) return rows;
    }
    throw new Error(
      `BSS 账单分页超过上限 ${MAX_PAGES} 页（billingDate=${billingDate}），已中止以免触发限流`,
    );
  }

  /** 探测某天出现的产品，用于确认百炼的 ProductCode（不硬编码） */
  async probeProducts(
    billingDate: string,
  ): Promise<Array<{ productCode: string; productName: string | null }>> {
    const rows = await this.fetchBillingItems(billingDate);
    const seen = new Map<
      string,
      { productCode: string; productName: string | null }
    >();
    for (const row of rows) {
      if (!seen.has(row.productCode)) {
        seen.set(row.productCode, {
          productCode: row.productCode,
          productName: row.productName,
        });
      }
    }
    return [...seen.values()];
  }

  private ensureClient(): BssClient {
    if (this.client) return this.client;
    const credential = this.buildCredential();
    const endpoint =
      text(this.configService.get<string>("ALIYUN_BSS_ENDPOINT")) ||
      DEFAULT_ENDPOINT;
    const config = new $OpenApiUtil.Config({
      credential,
      endpoint,
      connectTimeout: 5000,
      readTimeout: 15000,
    });
    this.client = new BssClient(config);
    this.logger.log(`Aliyun BSS 账单客户端已初始化（endpoint=${endpoint}）`);
    return this.client;
  }

  private buildCredential(): Credential {
    const accessKeyId = text(
      this.configService.get<string>("ALIYUN_BSS_ACCESS_KEY_ID"),
    );
    const accessKeySecret = text(
      this.configService.get<string>("ALIYUN_BSS_ACCESS_KEY_SECRET"),
    );
    if (accessKeyId && accessKeySecret) {
      // 显式 AK/SK：本地与 staging 用，建议只授 bssapi:DescribeInstanceBill 只读权限
      return new Credential(
        new CredentialConfig({
          type: "access_key",
          accessKeyId,
          accessKeySecret,
        }),
      );
    }
    if (this.configService.get<string>("ALIYUN_BSS_USE_RAM_ROLE") === "true") {
      // 默认凭证链：env → 配置文件 → ECS 实例 RAM 角色（IMDS，凭证自动轮转，密钥不落盘）
      return new Credential();
    }
    throw new AliyunBillUnavailableError(
      "未配置阿里云 BSS 凭证：需 ALIYUN_BSS_ACCESS_KEY_ID/SECRET，" +
        "或设 ALIYUN_BSS_USE_RAM_ROLE=true 走 ECS 实例 RAM 角色",
    );
  }

  private toRow(item: BillItemRaw, requestedDate: string): AliyunBillItem {
    const billDate = text(item.billingDate);
    if (!billDate) {
      throw new Error(
        `BSS 响应缺少 billingDate（请求 ${requestedDate}）：仅 Granularity=DAILY 才返回该字段`,
      );
    }
    if (billDate !== requestedDate) {
      // 官方：BillingDate 与 BillingCycle 月份不一致时按 BillingCycle 返回 → 会拿到整月数据
      throw new Error(
        `BSS 响应 billingDate=${billDate} 与请求 ${requestedDate} 不一致，` +
          `疑似 BillingCycle 错配返回整月数据，拒绝入库以免金额放大`,
      );
    }
    return {
      billDate,
      billingCycle: text(item.billingCycle) || billDate.slice(0, 7),
      productCode: text(item.productCode) || "unknown",
      productName: text(item.productName) || null,
      billingItem: text(item.billingItem),
      billingItemCode: text(item.billingItemCode),
      instanceId: text(item.instanceID),
      model: parseModelName(item),
      itemKind: text(item.item) || "PayAsYouGoBill",
      subscriptionType: text(item.subscriptionType) || "PayAsYouGo",
      usage: toUsageCount(item.usage),
      usageUnit: text(item.usageUnit) || null,
      grossMicroCny: toMicroCny(item.pretaxGrossAmount),
      payableMicroCny: toMicroCny(item.pretaxAmount),
      cashMicroCny: toMicroCny(item.paymentAmount),
      resourcePackMicroCny: toMicroCny(item.deductedByResourcePackage),
      couponMicroCny: toMicroCny(item.deductedByCashCoupons),
      currency: text(item.currency) || "CNY",
    };
  }
}
