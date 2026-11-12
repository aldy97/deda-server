import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  reportDateInTimezone,
  shiftReportDate,
} from "../learning-stats/parent-report-date.util";
import { vendorOfModel } from "../llm/llm-cost.util";
import {
  AliyunBillClient,
  AliyunBillUnavailableError,
  type AliyunBillItem,
} from "./aliyun-bill.client";

/**
 * 阿里云 BSS 账单落库服务（小模型金额的真值来源）。
 *
 * 约定与 sleep-scheduler / parent-report-generator 一致：onModuleInit + setInterval + unref，
 * 不引 @nestjs/schedule；由 LLM_COST_SYNC_ENABLED 显式开关（默认关，灰度可开）。
 *
 * 幂等：每行按 dedupeKey upsert，同一批账单重复同步不会追加行、不会放大金额。
 * 补拉窗口 T-1..T-N（默认 3 天）：官方账单延迟 24h（实例信息 48h），当月还会退款/调账，
 * 因此近几天需要反复覆盖；更早的历史由 scripts/backfill-aliyun-bill.ts 一次性灌入。
 */

const DEFAULT_INTERVAL_MINUTES = 360;
const DEFAULT_LOOKBACK_DAYS = 3;
const MAX_LOOKBACK_DAYS = 62;

export type SyncDayStatus = "ok" | "empty" | "error" | "unconfigured";

export interface SyncDayResult {
  billDate: string;
  status: SyncDayStatus;
  upserted: number;
  message?: string | null;
}

export interface SyncResult {
  status: "ok" | "unconfigured" | "error";
  days: SyncDayResult[];
  latestBillDate: string | null;
  message?: string | null;
  syncedAt: string;
}

/** tier 按模型名判定，不用 llm_usage_logs.tier（SMALL_LLM_MODEL 缺省时该字段会整体退化） */
export function tierOfModel(model: string): string {
  const vendor = vendorOfModel(model);
  if (vendor === "dashscope") return "small";
  if (vendor === "deepseek") return "main";
  return "unknown";
}

/**
 * 幂等键：覆盖所有能区分账单行的维度。
 * 用 JSON 数组序列化而非分隔符拼接，避免字段值里含分隔符时碰撞；
 * 所有成分都是非空字符串——可空列参与唯一键时 PG 视 NULL 互不相等，upsert 会退化成每次插入。
 */
export function buildDedupeKey(row: {
  billDate: string;
  productCode: string;
  billingItemCode: string;
  billingItem: string;
  instanceId: string;
  model: string;
  itemKind: string;
  subscriptionType: string;
}): string {
  return JSON.stringify([
    "aliyun",
    row.billDate,
    row.productCode,
    row.billingItemCode,
    row.billingItem,
    row.instanceId,
    row.model,
    row.itemKind,
    row.subscriptionType,
  ]);
}

/**
 * 终账判定：官方口径为「当月最终账单在次月 3 日 12 点后可查」。
 * 未终账的账单日页面标「暂估」（会发生延迟出账、退款、调账、欠费核销）。
 */
export function isSettled(billDate: string, now: Date = new Date()): boolean {
  const matched = /^(\d{4})-(\d{2})-\d{2}$/.exec(billDate);
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  // Date.UTC 的月份是 0 基，传 1 基的 month 即「次月」；北京 12:00 = UTC 04:00（无夏令时）
  const settledAtMs = Date.UTC(year, month, 3, 4, 0, 0);
  return now.getTime() >= settledAtMs;
}

/** 需要补拉的账单日：北京时间 T-1 .. T-lookbackDays（升序无所谓，按倒推顺序返回） */
export function recentBillDates(now: Date, lookbackDays: number): string[] {
  const days =
    Number.isInteger(lookbackDays) && lookbackDays > 0
      ? Math.min(lookbackDays, MAX_LOOKBACK_DAYS)
      : DEFAULT_LOOKBACK_DAYS;
  const today = reportDateInTimezone(now, DEFAULT_REPORT_TIMEZONE);
  const dates: string[] = [];
  for (let offset = 1; offset <= days; offset += 1) {
    dates.push(shiftReportDate(today, -offset));
  }
  return dates;
}

@Injectable()
export class BillingSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingSyncService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billClient: AliyunBillClient,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.configService.get<string>("LLM_COST_SYNC_ENABLED") !== "true") {
      this.logger.log("LLM_COST_SYNC_ENABLED 未开启，跳过阿里云账单同步");
      return;
    }
    // fire-and-forget：首轮同步不阻塞应用启动（BSS 慢时最多拖 15s×天数）
    void this.syncRecent();
    const intervalMs = this.intervalMinutes() * 60 * 1000;
    this.timer = setInterval(() => {
      void this.syncRecent();
    }, intervalMs);
    this.timer.unref();
    this.logger.log(
      `阿里云账单同步已启动：每 ${this.intervalMinutes()} 分钟补拉 T-1..T-${this.lookbackDays()}`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 补拉最近 N 天账单。单天失败不影响其他天；整体状态取最差。 */
  async syncRecent(
    now: Date = new Date(),
    lookbackDays?: number,
  ): Promise<SyncResult> {
    const syncedAt = now.toISOString();
    if (!this.billClient.isConfigured()) {
      const message =
        "未配置阿里云 BSS 凭证（ALIYUN_BSS_ACCESS_KEY_ID/SECRET 或 ALIYUN_BSS_USE_RAM_ROLE）";
      this.logger.warn(message);
      return {
        status: "unconfigured",
        days: [],
        latestBillDate: null,
        message,
        syncedAt,
      };
    }
    const dates = recentBillDates(now, lookbackDays ?? this.lookbackDays());
    const days: SyncDayResult[] = [];
    for (const billDate of dates) {
      days.push(await this.syncDay(billDate, now));
    }
    const latestBillDate =
      days
        .filter((day) => day.status === "ok" || day.status === "empty")
        .map((day) => day.billDate)
        .sort()
        .pop() ?? null;
    const firstError = days.find(
      (day) => day.status === "error" || day.status === "unconfigured",
    );
    const status: SyncResult["status"] = days.some(
      (day) => day.status === "error",
    )
      ? "error"
      : days.every((day) => day.status === "unconfigured")
        ? "unconfigured"
        : "ok";
    return {
      status,
      days,
      latestBillDate,
      message: firstError?.message ?? null,
      syncedAt,
    };
  }

  /** 拉取并落库某一天的计费项账单（幂等） */
  async syncDay(
    billDate: string,
    now: Date = new Date(),
  ): Promise<SyncDayResult> {
    let rows: AliyunBillItem[];
    try {
      rows = await this.billClient.fetchBillingItems(billDate);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AliyunBillUnavailableError) {
        this.logger.warn(`阿里云账单未接入（${billDate}）：${message}`);
        return { billDate, status: "unconfigured", upserted: 0, message };
      }
      this.logger.error(`拉取 ${billDate} 账单失败：${message}`);
      return { billDate, status: "error", upserted: 0, message };
    }

    if (rows.length === 0) {
      // 账单延迟 24h 出账，昨日为空属正常：不写库、不补 0，页面按缺日断点显示
      this.logger.log(`${billDate} 无账单行（可能尚未出账）`);
      return { billDate, status: "empty", upserted: 0 };
    }

    const settled = isSettled(billDate, now);
    let upserted = 0;
    for (const row of rows) {
      const dedupeKey = buildDedupeKey(row);
      const data = {
        billDate: row.billDate,
        billingCycle: row.billingCycle,
        provider: "aliyun",
        productCode: row.productCode,
        productName: row.productName,
        billingItem: row.billingItem,
        billingItemCode: row.billingItemCode,
        instanceId: row.instanceId,
        model: row.model,
        tier: tierOfModel(row.model),
        itemKind: row.itemKind,
        subscriptionType: row.subscriptionType,
        usage: row.usage,
        usageUnit: row.usageUnit,
        grossMicroCny: row.grossMicroCny,
        payableMicroCny: row.payableMicroCny,
        cashMicroCny: row.cashMicroCny,
        resourcePackMicroCny: row.resourcePackMicroCny,
        couponMicroCny: row.couponMicroCny,
        currency: row.currency,
        settled,
        fetchedAt: now,
      };
      await this.prisma.llmCostDaily.upsert({
        where: { dedupeKey },
        create: { ...data, dedupeKey },
        update: data,
      });
      upserted += 1;
    }
    this.logger.log(
      `${billDate} 账单落库 ${upserted} 行（settled=${settled}）`,
    );
    return { billDate, status: "ok", upserted };
  }

  private intervalMinutes(): number {
    const parsed = Number(
      this.configService.get<string>("LLM_COST_SYNC_INTERVAL_MINUTES"),
    );
    return Number.isFinite(parsed) && parsed >= 1
      ? Math.min(parsed, 24 * 60)
      : DEFAULT_INTERVAL_MINUTES;
  }

  private lookbackDays(): number {
    const parsed = Number(
      this.configService.get<string>("LLM_COST_SYNC_LOOKBACK_DAYS"),
    );
    return Number.isInteger(parsed) && parsed >= 1
      ? Math.min(parsed, MAX_LOOKBACK_DAYS)
      : DEFAULT_LOOKBACK_DAYS;
  }
}
