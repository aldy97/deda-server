/**
 * LLM 成本计价口径（主模型 DeepSeek 估算、小模型 qwen-flash 对账用）。
 *
 * 定价常量刻意写在代码而非 env：口径必须可追溯，调价即升 PRICING_VERSION 并发版；
 * 已落库的 llm_usage_logs.costMicroCny 不随之变化（历史金额按当时定价冻结）。
 *
 * 价格来源（取值日 2026-11-12）：
 * - DeepSeek 中文定价页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *   高峰＝北京时间周一至周五（不含法定节假日）9:00-12:00、14:00-18:00，空闲时段为高峰的一半。
 * - 百炼 qwen-flash 阶梯价（按输入上下文长度分档，priceTimeBands 只有 standard，无峰谷）。
 *
 * 已知偏差（均向高估方向，接口/前端如实标注）：
 * - 不维护法定节假日表，节假日会被判成高峰；
 * - 上游未回传缓存命中 token 时全按未命中价计（cacheHitInputTokens 为 null 即上界标记）。
 */

export const PRICING_VERSION = "2026-11-12";

/** 金额统一 micro-CNY：1 元 = 1_000_000，聚合即 SUM(Int) */
export const MICRO_PER_CNY = 1_000_000;

const TOKENS_PER_MILLION = 1_000_000;

/**
 * 峰谷判定固定按北京时间。生产容器未设 TZ（docker/docker-compose.yml 的 environment 无 TZ），
 * 用 Date#getHours 会整体偏 8 小时，把高峰判成空闲。
 */
const PRICING_TIMEZONE = "Asia/Shanghai";

export type PriceBand = "peak" | "off_peak";
export type LlmVendor = "deepseek" | "dashscope" | "unknown";
/** exact＝上游回传了缓存命中数；upper_bound＝未回传，全按未命中价 */
export type CostAccuracy = "exact" | "upper_bound";

/** 上游 usage 原文（两家 vendor 字段并集，全部可缺省） */
export interface RawUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  /** DeepSeek 官方字段 */
  prompt_cache_hit_tokens?: number | null;
  prompt_cache_miss_tokens?: number | null;
  /** DashScope 新加坡地域扁平字段 */
  cached_tokens?: number | null;
  /** DashScope 北京地域 / OpenAI 兼容形状 */
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
}

/** 元/百万 tokens 换算成 micro-CNY/百万 tokens 后的单价 */
export interface UnitPrice {
  inputMissMicroPerMillion: number;
  inputHitMicroPerMillion: number;
  outputMicroPerMillion: number;
}

// 元/百万 tokens：flash 空闲 1 / 0.02 / 4，高峰 2 / 0.04 / 8
const DEEPSEEK_UNIT_PRICES: Record<string, Record<PriceBand, UnitPrice>> = {
  "deepseek-flash": {
    off_peak: {
      inputMissMicroPerMillion: 1_000_000,
      inputHitMicroPerMillion: 20_000,
      outputMicroPerMillion: 4_000_000,
    },
    peak: {
      inputMissMicroPerMillion: 2_000_000,
      inputHitMicroPerMillion: 40_000,
      outputMicroPerMillion: 8_000_000,
    },
  },
  // 元/百万 tokens：空闲 4.5 / 0.15 / 13.5，高峰 9 / 0.3 / 27
  "deepseek-v4-pro": {
    off_peak: {
      inputMissMicroPerMillion: 4_500_000,
      inputHitMicroPerMillion: 150_000,
      outputMicroPerMillion: 13_500_000,
    },
    peak: {
      inputMissMicroPerMillion: 9_000_000,
      inputHitMicroPerMillion: 300_000,
      outputMicroPerMillion: 27_000_000,
    },
  },
};

/** 官方口径：旧模型名已下线，请求由 Flash 承接并按 Flash 价计费 */
const DEEPSEEK_PRICE_ALIASES: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
};

interface TieredPrice {
  maxPromptTokens: number;
  unit: UnitPrice;
}

// qwen-flash 元/百万 tokens：≤128k 0.15/0.03/1.5；128k-256k 0.6/0.12/6；256k-1M 1.2/0.24/12
const QWEN_FLASH_TIERS: TieredPrice[] = [
  {
    maxPromptTokens: 128_000,
    unit: {
      inputMissMicroPerMillion: 150_000,
      inputHitMicroPerMillion: 30_000,
      outputMicroPerMillion: 1_500_000,
    },
  },
  {
    maxPromptTokens: 256_000,
    unit: {
      inputMissMicroPerMillion: 600_000,
      inputHitMicroPerMillion: 120_000,
      outputMicroPerMillion: 6_000_000,
    },
  },
  {
    // 超出官方 1M 上限时按最高档计，不抛错（主链路安全优先）
    maxPromptTokens: Number.POSITIVE_INFINITY,
    unit: {
      inputMissMicroPerMillion: 1_200_000,
      inputHitMicroPerMillion: 240_000,
      outputMicroPerMillion: 12_000_000,
    },
  },
];

const QWEN_TIERED_MODELS = new Set(["qwen-flash"]);

const beijingFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PRICING_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

function beijingParts(at: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
} {
  const values = new Map(
    beijingFormatter
      .formatToParts(at)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.get("year") ?? 0,
    month: values.get("month") ?? 0,
    day: values.get("day") ?? 0,
    hour: values.get("hour") ?? 0,
  };
}

/** 账单来源判定按模型名，不用 llm_usage_logs.tier（SMALL_LLM_MODEL 缺省时 tier 会全表退化为 small） */
export function vendorOfModel(model: string): LlmVendor {
  const name = normalizeModel(model);
  if (name.startsWith("deepseek")) return "deepseek";
  if (name.startsWith("qwen")) return "dashscope";
  return "unknown";
}

/** 高峰＝北京时间周一至周五 9:00-12:00、14:00-18:00；法定节假日未维护，按高峰计（高估） */
export function priceBandAt(at: Date): PriceBand {
  const { year, month, day, hour } = beijingParts(at);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const isWorkday = weekday >= 1 && weekday <= 5;
  const inPeakHours = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  return isWorkday && inPeakHours ? "peak" : "off_peak";
}

/** 缓存命中输入 token；三种上游形状都认，未回传返回 null */
export function extractCacheHitTokens(usage?: RawUsage | null): number | null {
  if (!usage) return null;
  const candidates: unknown[] = [
    usage.prompt_cache_hit_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.cached_tokens,
  ];
  for (const candidate of candidates) {
    const value = toTokenCount(candidate);
    if (value !== null) return value;
  }
  return null;
}

/**
 * 拆分输入 token 的命中/未命中部分。
 * 实测（Step 0-A）：DeepSeek 的 hit + miss === prompt_tokens，即命中数已含在 prompt_tokens 内，
 * DashScope 文档同口径（cached_tokens 包含在总输入 token 中）。
 * 因此计价只能用 miss × 未命中价 + hit × 命中价，对 prompt_tokens 整体套未命中价会重复计费。
 */
export function splitInputTokens(usage?: RawUsage | null): {
  hitTokens: number | null;
  missTokens: number | null;
} {
  if (!usage) return { hitTokens: null, missTokens: null };
  const prompt = toTokenCount(usage.prompt_tokens);
  let hitTokens = extractCacheHitTokens(usage);
  if (hitTokens !== null && prompt !== null && hitTokens > prompt) {
    hitTokens = prompt; // 上游异常，钳制以免算出负数
  }
  const reportedMiss = toTokenCount(usage.prompt_cache_miss_tokens);
  let missTokens: number | null;
  if (reportedMiss !== null) {
    missTokens = reportedMiss;
  } else if (prompt !== null && hitTokens !== null) {
    missTokens = Math.max(0, prompt - hitTokens);
  } else {
    // 无缓存字段：全部按未命中，金额为上界
    missTokens = prompt;
  }
  if (
    prompt !== null &&
    hitTokens !== null &&
    missTokens !== null &&
    hitTokens + missTokens > prompt
  ) {
    missTokens = Math.max(0, prompt - hitTokens);
  }
  return { hitTokens, missTokens };
}

export function costAccuracyOf(usage?: RawUsage | null): CostAccuracy {
  return extractCacheHitTokens(usage) === null ? "upper_bound" : "exact";
}

/**
 * 单次调用成本（micro-CNY）。缺 token、模型未定价一律返回 null，绝不返回 0：
 * 0 会被聚合当成真实花费，null 才能被接口统计为「未计价」。
 */
export function costMicroCnyOf(input: {
  model: string;
  usage?: RawUsage | null;
  at: Date;
}): number | null {
  const usage = input.usage ?? null;
  if (!usage) return null;
  const promptTokens = toTokenCount(usage.prompt_tokens);
  const completionTokens = toTokenCount(usage.completion_tokens);
  if (promptTokens === null || completionTokens === null) return null;

  const unit = resolveUnitPrice(
    input.model,
    promptTokens,
    priceBandAt(input.at),
  );
  if (!unit) return null;

  const { hitTokens, missTokens } = splitInputTokens(usage);
  const hit = hitTokens ?? 0;
  const miss = missTokens ?? Math.max(0, promptTokens - hit);
  const micro =
    microFor(miss, unit.inputMissMicroPerMillion) +
    microFor(hit, unit.inputHitMicroPerMillion) +
    microFor(completionTokens, unit.outputMicroPerMillion);
  if (!Number.isFinite(micro)) return null;
  return Math.max(0, Math.round(micro));
}

/** micro-CNY → 元，保留 6 位小数（接口出参用 number，不引入 Decimal 字符串） */
export function toCny(microCny: number): number {
  return Number((microCny / MICRO_PER_CNY).toFixed(6));
}

/** 官网定价参考线（前端「每百万 token 有效单价」图的 markLine 用） */
export interface OfficialPriceLine {
  model: string;
  /** qwen-flash 无峰谷 → null */
  band: PriceBand | null;
  kind: "input_miss" | "input_hit" | "output";
  /** 阶梯档位标签（qwen-flash 按输入上下文长度分档），无阶梯为 null */
  tierLabel: string | null;
  label: string;
  cnyPerMillionTokens: number;
}

const KIND_LABELS: Record<OfficialPriceLine["kind"], string> = {
  input_miss: "输入（缓存未命中）",
  input_hit: "输入（缓存命中）",
  output: "输出",
};

const BAND_LABELS: Record<PriceBand, string> = {
  peak: "高峰",
  off_peak: "空闲",
};

/**
 * 官网定价明细，按 PRICING_VERSION 冻结。
 * 单一来源：前端图 C 的参考线取自此接口，不得在 dashboard 里另写一份价格常量。
 */
export function officialPriceLines(): OfficialPriceLine[] {
  const lines: OfficialPriceLine[] = [];
  const kinds = Object.keys(KIND_LABELS) as OfficialPriceLine["kind"][];
  for (const [model, bands] of Object.entries(DEEPSEEK_UNIT_PRICES)) {
    for (const band of Object.keys(bands) as PriceBand[]) {
      for (const kind of kinds) {
        lines.push({
          model,
          band,
          kind,
          tierLabel: null,
          label: `${KIND_LABELS[kind]}·${BAND_LABELS[band]}`,
          cnyPerMillionTokens: toCny(bands[band][priceFieldOf(kind)]),
        });
      }
    }
  }
  let lowerBound = 0;
  for (const tier of QWEN_FLASH_TIERS) {
    const tierLabel = Number.isFinite(tier.maxPromptTokens)
      ? `${formatTokenBound(lowerBound)}-${formatTokenBound(tier.maxPromptTokens)}`
      : `>${formatTokenBound(lowerBound)}`;
    for (const kind of kinds) {
      lines.push({
        model: "qwen-flash",
        band: null,
        kind,
        tierLabel,
        label: `${KIND_LABELS[kind]}·${tierLabel}`,
        cnyPerMillionTokens: toCny(tier.unit[priceFieldOf(kind)]),
      });
    }
    lowerBound = tier.maxPromptTokens;
  }
  return lines;
}

function priceFieldOf(kind: OfficialPriceLine["kind"]): keyof UnitPrice {
  if (kind === "input_miss") return "inputMissMicroPerMillion";
  if (kind === "input_hit") return "inputHitMicroPerMillion";
  return "outputMicroPerMillion";
}

function formatTokenBound(tokens: number): string {
  if (tokens === 0) return "0";
  return tokens % 1000 === 0 ? `${tokens / 1000}k` : String(tokens);
}

/**
 * 回填用：把已落库的 token 列还原成计价输入。
 * 历史行没有缓存命中数据 → 还原结果不含缓存字段，金额只能按未命中价（上界），
 * 页面据 cacheHitInputTokens IS NULL 标 upper_bound。
 */
export function usageFromLogRow(row: {
  promptTokens?: number | null;
  completionTokens?: number | null;
  cacheHitInputTokens?: number | null;
}): RawUsage | null {
  const prompt = toTokenCount(row.promptTokens);
  const completion = toTokenCount(row.completionTokens);
  if (prompt === null || completion === null) return null;
  const usage: RawUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
  };
  const hit = toTokenCount(row.cacheHitInputTokens);
  if (hit !== null) {
    usage.prompt_cache_hit_tokens = Math.min(hit, prompt);
    usage.prompt_cache_miss_tokens = Math.max(0, prompt - hit);
  }
  return usage;
}

function normalizeModel(model: string): string {
  return typeof model === "string" ? model.trim().toLowerCase() : "";
}

function resolveUnitPrice(
  model: string,
  promptTokens: number,
  band: PriceBand,
): UnitPrice | null {
  const name = normalizeModel(model);
  const deepseekName = DEEPSEEK_PRICE_ALIASES[name] ?? name;
  const deepseekPrice = DEEPSEEK_UNIT_PRICES[deepseekName];
  if (deepseekPrice) return deepseekPrice[band];
  if (QWEN_TIERED_MODELS.has(name)) {
    const tier =
      QWEN_FLASH_TIERS.find(
        (candidate) => promptTokens <= candidate.maxPromptTokens,
      ) ?? QWEN_FLASH_TIERS[QWEN_FLASH_TIERS.length - 1];
    return tier.unit;
  }
  return null;
}

function microFor(tokens: number, microPerMillion: number): number {
  return (tokens * microPerMillion) / TOKENS_PER_MILLION;
}

function toTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return null;
  return Math.trunc(value);
}
