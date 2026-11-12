import {
  PRICING_VERSION,
  costAccuracyOf,
  costMicroCnyOf,
  extractCacheHitTokens,
  officialPriceLines,
  priceBandAt,
  splitInputTokens,
  toCny,
  usageFromLogRow,
  vendorOfModel,
} from "./llm-cost.util";

/**
 * 定价口径单测。
 *
 * 真实 usage 样本来自 2026-11-12 对 api.deepseek.com 的一次流式调用（Step 0-A 验证）：
 *   call#1 {"prompt_tokens":3607,"completion_tokens":7,"total_tokens":3614,
 *           "prompt_tokens_details":{"cached_tokens":0},
 *           "prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":3607}
 *   call#2 {"prompt_tokens":3607,"completion_tokens":2,"total_tokens":3609,
 *           "prompt_tokens_details":{"cached_tokens":3456},
 *           "prompt_cache_hit_tokens":3456,"prompt_cache_miss_tokens":151}
 * 关键结论：hit + miss === prompt_tokens，即缓存命中数已包含在 prompt_tokens 内，
 * 计价必须按 miss 部分 × 未命中价 + hit 部分 × 命中价，不能对 prompt_tokens 整体套未命中价。
 */
const DEEPSEEK_CALL_CACHED = {
  prompt_tokens: 3607,
  completion_tokens: 2,
  total_tokens: 3609,
  prompt_tokens_details: { cached_tokens: 3456 },
  prompt_cache_hit_tokens: 3456,
  prompt_cache_miss_tokens: 151,
};

const DEEPSEEK_CALL_COLD = {
  prompt_tokens: 3607,
  completion_tokens: 7,
  total_tokens: 3614,
  prompt_tokens_details: { cached_tokens: 0 },
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 3607,
};

/** 周四：北京时间 2026-11-12（UTC+8） */
const THU_PEAK_0930 = new Date("2026-11-12T01:30:00Z");
const THU_OFFPEAK_1230 = new Date("2026-11-12T04:30:00Z");

describe("PRICING_VERSION", () => {
  it("是日期版本号，改价必须升版本（口径可追溯）", () => {
    expect(PRICING_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("vendorOfModel", () => {
  it("按模型名判定账单来源，不依赖埋点 tier 字段", () => {
    expect(vendorOfModel("deepseek-flash")).toBe("deepseek");
    expect(vendorOfModel("deepseek-v4-pro")).toBe("deepseek");
    expect(vendorOfModel("qwen-flash")).toBe("dashscope");
    expect(vendorOfModel("gpt-4o")).toBe("unknown");
    expect(vendorOfModel("")).toBe("unknown");
  });
});

describe("priceBandAt（峰谷按北京时间，容器为 UTC 也必须正确）", () => {
  it.each([
    ["2026-11-12T00:59:59Z", "周四 08:59:59", "off_peak"],
    ["2026-11-12T01:00:00Z", "周四 09:00:00", "peak"],
    ["2026-11-12T03:59:59Z", "周四 11:59:59", "peak"],
    ["2026-11-12T04:00:00Z", "周四 12:00:00", "off_peak"],
    ["2026-11-12T05:59:00Z", "周四 13:59:00", "off_peak"],
    ["2026-11-12T06:00:00Z", "周四 14:00:00", "peak"],
    ["2026-11-12T09:59:59Z", "周四 17:59:59", "peak"],
    ["2026-11-12T10:00:00Z", "周四 18:00:00", "off_peak"],
    ["2026-11-13T01:30:00Z", "周五 09:30", "peak"],
    ["2026-11-14T02:00:00Z", "周六 10:00", "off_peak"],
    ["2026-11-15T07:00:00Z", "周日 15:00", "off_peak"],
  ])("%s（%s）→ %s", (iso, _label, expected) => {
    expect(priceBandAt(new Date(iso))).toBe(expected);
  });
});

describe("extractCacheHitTokens", () => {
  it("识别 DeepSeek 官方字段", () => {
    expect(extractCacheHitTokens(DEEPSEEK_CALL_CACHED)).toBe(3456);
  });

  it("命中数为 0 也算「已回传」，返回 0 而不是 null", () => {
    expect(extractCacheHitTokens(DEEPSEEK_CALL_COLD)).toBe(0);
  });

  it("回落 DashScope 北京地域形状 prompt_tokens_details.cached_tokens", () => {
    expect(
      extractCacheHitTokens({
        prompt_tokens: 1316,
        prompt_tokens_details: { cached_tokens: 1152 },
      }),
    ).toBe(1152);
  });

  it("回落 DashScope 新加坡地域扁平形状 usage.cached_tokens", () => {
    expect(
      extractCacheHitTokens({ prompt_tokens: 900, cached_tokens: 500 }),
    ).toBe(500);
  });

  it("优先级：prompt_cache_hit_tokens > prompt_tokens_details > 扁平字段", () => {
    expect(
      extractCacheHitTokens({
        prompt_tokens: 1000,
        prompt_cache_hit_tokens: 700,
        cached_tokens: 100,
        prompt_tokens_details: { cached_tokens: 200 },
      }),
    ).toBe(700);
  });

  it("上游未回传时返回 null（金额退化为上界）", () => {
    expect(extractCacheHitTokens({ prompt_tokens: 1000 })).toBeNull();
    expect(extractCacheHitTokens({ prompt_tokens_details: null })).toBeNull();
    expect(extractCacheHitTokens(undefined)).toBeNull();
    expect(extractCacheHitTokens(null)).toBeNull();
  });
});

describe("splitInputTokens", () => {
  it("官方同时给 hit/miss 时直接采用（实测 hit+miss=prompt_tokens）", () => {
    expect(splitInputTokens(DEEPSEEK_CALL_CACHED)).toEqual({
      hitTokens: 3456,
      missTokens: 151,
    });
  });

  it("只给 hit 时按 prompt_tokens 减出 miss（cached 是 prompt 的子集）", () => {
    expect(
      splitInputTokens({
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 800 },
      }),
    ).toEqual({ hitTokens: 800, missTokens: 200 });
  });

  it("无任何缓存字段时 miss = 全部输入（上界），hit 为 null", () => {
    expect(splitInputTokens({ prompt_tokens: 1000 })).toEqual({
      hitTokens: null,
      missTokens: 1000,
    });
  });

  it("上游异常（hit 超过 prompt_tokens）时钳制，不产生负数", () => {
    expect(
      splitInputTokens({ prompt_tokens: 100, prompt_cache_hit_tokens: 500 }),
    ).toEqual({ hitTokens: 100, missTokens: 0 });
  });

  it("缺 prompt_tokens 时不做减法推断", () => {
    expect(splitInputTokens({ prompt_cache_hit_tokens: 300 })).toEqual({
      hitTokens: 300,
      missTokens: null,
    });
  });
});

describe("costAccuracyOf", () => {
  it("拿到缓存字段即为 exact，含命中 0 的情况", () => {
    expect(costAccuracyOf(DEEPSEEK_CALL_CACHED)).toBe("exact");
    expect(costAccuracyOf(DEEPSEEK_CALL_COLD)).toBe("exact");
  });

  it("拿不到缓存字段或无 usage 时为 upper_bound", () => {
    expect(costAccuracyOf({ prompt_tokens: 100 })).toBe("upper_bound");
    expect(costAccuracyOf(undefined)).toBe("upper_bound");
  });
});

describe("costMicroCnyOf — deepseek-flash（1 元 = 1_000_000 micro）", () => {
  it("空闲时段用实测样本：miss 151×1元 + hit 3456×0.02元 + out 2×4元 = 228 micro", () => {
    expect(
      costMicroCnyOf({
        model: "deepseek-flash",
        usage: DEEPSEEK_CALL_CACHED,
        at: THU_OFFPEAK_1230,
      }),
    ).toBe(228);
  });

  it("高峰时段同样本：miss 151×2元 + hit 3456×0.04元 + out 2×8元 = 456 micro", () => {
    expect(
      costMicroCnyOf({
        model: "deepseek-flash",
        usage: DEEPSEEK_CALL_CACHED,
        at: THU_PEAK_0930,
      }),
    ).toBe(456);
  });

  it("无缓存字段时全按未命中价（上界），且显著高于 exact（回归护栏）", () => {
    const upperBound = costMicroCnyOf({
      model: "deepseek-flash",
      usage: { prompt_tokens: 3607, completion_tokens: 2 },
      at: THU_OFFPEAK_1230,
    });
    const exact = costMicroCnyOf({
      model: "deepseek-flash",
      usage: DEEPSEEK_CALL_CACHED,
      at: THU_OFFPEAK_1230,
    });
    expect(upperBound).toBe(3615); // 3607×1元 + 2×4元
    expect(exact).toBe(228);
    expect((upperBound as number) / (exact as number)).toBeGreaterThan(15);
  });

  it("复核落地方案里的举例：3000 prompt / 命中 80% / 空闲 → 648 micro（¥0.000648）", () => {
    expect(
      costMicroCnyOf({
        model: "deepseek-flash",
        usage: {
          prompt_tokens: 3000,
          completion_tokens: 0,
          prompt_cache_hit_tokens: 2400,
          prompt_cache_miss_tokens: 600,
        },
        at: THU_OFFPEAK_1230,
      }),
    ).toBe(648);
    expect(
      costMicroCnyOf({
        model: "deepseek-flash",
        usage: { prompt_tokens: 3000, completion_tokens: 0 },
        at: THU_OFFPEAK_1230,
      }),
    ).toBe(3000); // 上界 ¥0.003
  });

  it("未列价的 deepseek 型号返回 null，不静默按 flash 计价", () => {
    expect(
      costMicroCnyOf({
        model: "deepseek-unknown-xxx",
        usage: DEEPSEEK_CALL_CACHED,
        at: THU_OFFPEAK_1230,
      }),
    ).toBeNull();
  });

  it("旧模型名 deepseek-v4-flash 按官方口径仍按 flash 价计费", () => {
    const args = { usage: DEEPSEEK_CALL_CACHED, at: THU_OFFPEAK_1230 };
    expect(costMicroCnyOf({ model: "deepseek-v4-flash", ...args })).toBe(
      costMicroCnyOf({ model: "deepseek-flash", ...args }),
    );
  });

  it("deepseek-v4-pro 用自己的价（空闲 4.5/0.15/13.5 元每百万）", () => {
    expect(
      costMicroCnyOf({
        model: "deepseek-v4-pro",
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
        at: THU_OFFPEAK_1230,
      }),
    ).toBe(5850); // 1000×4.5 + 100×13.5
  });
});

describe("costMicroCnyOf — qwen-flash（阶梯价，无峰谷）", () => {
  it("≤128k：0.15/1.5 元每百万，缓存命中 0.03", () => {
    expect(
      costMicroCnyOf({
        model: "qwen-flash",
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
        at: THU_OFFPEAK_1230,
      }),
    ).toBe(300); // 150 + 150
  });

  it("峰谷不影响 qwen-flash（priceTimeBands 只有 standard）", () => {
    const args = {
      model: "qwen-flash",
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
    };
    expect(costMicroCnyOf({ ...args, at: THU_PEAK_0930 })).toBe(
      costMicroCnyOf({ ...args, at: THU_OFFPEAK_1230 }),
    );
  });

  it("缓存命中部分按 0.03 元计价", () => {
    expect(
      costMicroCnyOf({
        model: "qwen-flash",
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 512 },
        },
        at: THU_OFFPEAK_1230,
      }),
    ).toBe(89); // 488×0.15 + 512×0.03 = 73.2 + 15.36
  });

  it("128k<输入≤256k 走第二阶梯：0.6/6 元", () => {
    expect(
      costMicroCnyOf({
        model: "qwen-flash",
        usage: { prompt_tokens: 200_000, completion_tokens: 0 },
        at: THU_OFFPEAK_1230,
      }),
    ).toBe(120_000); // ¥0.12
  });

  it("256k<输入≤1M 走第三阶梯：1.2/12 元；超 1M 按最高档不抛错", () => {
    expect(
      costMicroCnyOf({
        model: "qwen-flash",
        usage: { prompt_tokens: 300_000, completion_tokens: 0 },
        at: THU_OFFPEAK_1230,
      }),
    ).toBe(360_000);
    expect(
      costMicroCnyOf({
        model: "qwen-flash",
        usage: { prompt_tokens: 2_000_000, completion_tokens: 0 },
        at: THU_OFFPEAK_1230,
      }),
    ).toBe(2_400_000);
  });
});

describe("costMicroCnyOf — 缺数据一律 null，不写 0", () => {
  it.each([
    ["无 usage", { model: "deepseek-flash", usage: undefined }],
    [
      "缺 prompt_tokens",
      { model: "deepseek-flash", usage: { completion_tokens: 5 } },
    ],
    [
      "缺 completion_tokens",
      { model: "deepseek-flash", usage: { prompt_tokens: 5 } },
    ],
    ["未定价模型", { model: "gpt-4o", usage: DEEPSEEK_CALL_CACHED }],
    [
      "token 为负",
      {
        model: "deepseek-flash",
        usage: { prompt_tokens: -1, completion_tokens: 2 },
      },
    ],
    [
      "token 非有限数",
      {
        model: "deepseek-flash",
        usage: { prompt_tokens: NaN, completion_tokens: 2 },
      },
    ],
  ])("%s → null", (_label, input) => {
    expect(
      costMicroCnyOf({ ...input, at: THU_OFFPEAK_1230 } as never),
    ).toBeNull();
  });
});

describe("toCny", () => {
  it("micro → 元，保留 6 位小数", () => {
    expect(toCny(228)).toBe(0.000228);
    expect(toCny(0)).toBe(0);
    expect(toCny(1_000_000)).toBe(1);
  });
});

describe("usageFromLogRow（回填：历史行只有 token 列）", () => {
  it("无缓存数据的历史行：还原出的 usage 不含缓存字段，金额只能是上界", () => {
    const usage = usageFromLogRow({
      promptTokens: 3607,
      completionTokens: 2,
      cacheHitInputTokens: null,
    });
    expect(usage).toEqual({ prompt_tokens: 3607, completion_tokens: 2 });
    expect(costAccuracyOf(usage)).toBe("upper_bound");
    expect(
      costMicroCnyOf({ model: "deepseek-flash", usage, at: THU_OFFPEAK_1230 }),
    ).toBe(3615);
  });

  it("已有缓存命中数的行按 exact 重算（miss = prompt - hit）", () => {
    const usage = usageFromLogRow({
      promptTokens: 3607,
      completionTokens: 2,
      cacheHitInputTokens: 3456,
    });
    expect(usage).toEqual({
      prompt_tokens: 3607,
      completion_tokens: 2,
      prompt_cache_hit_tokens: 3456,
      prompt_cache_miss_tokens: 151,
    });
    expect(costAccuracyOf(usage)).toBe("exact");
    expect(
      costMicroCnyOf({ model: "deepseek-flash", usage, at: THU_OFFPEAK_1230 }),
    ).toBe(228);
  });

  it("缓存命中数超过 prompt 时钳制，不产生负 miss", () => {
    const usage = usageFromLogRow({
      promptTokens: 100,
      completionTokens: 0,
      cacheHitInputTokens: 500,
    });
    expect(
      costMicroCnyOf({ model: "deepseek-flash", usage, at: THU_OFFPEAK_1230 }),
    ).toBe(2); // 100×0.02 元
  });

  it("token 缺失返回 null，回填脚本据此跳过", () => {
    expect(
      usageFromLogRow({
        promptTokens: null,
        completionTokens: 2,
        cacheHitInputTokens: null,
      }),
    ).toBeNull();
    expect(
      usageFromLogRow({
        promptTokens: 10,
        completionTokens: null,
        cacheHitInputTokens: null,
      }),
    ).toBeNull();
  });
});

describe("officialPriceLines（前端参考线的唯一价格来源）", () => {
  const lines = officialPriceLines();

  it("覆盖 deepseek-flash 空闲/高峰 × 未命中/命中/输出，数值与官网一致", () => {
    const flash = lines.filter((line) => line.model === "deepseek-flash");
    expect(flash).toHaveLength(6);
    const pick = (band: string, kind: string) =>
      flash.find((line) => line.band === band && line.kind === kind)
        ?.cnyPerMillionTokens;
    expect(pick("off_peak", "input_miss")).toBe(1);
    expect(pick("off_peak", "input_hit")).toBe(0.02);
    expect(pick("off_peak", "output")).toBe(4);
    expect(pick("peak", "input_miss")).toBe(2);
    expect(pick("peak", "input_hit")).toBe(0.04);
    expect(pick("peak", "output")).toBe(8);
  });

  it("qwen-flash 三档阶梯价都出现，band 为 null（官方无峰谷）", () => {
    const qwen = lines.filter((line) => line.model === "qwen-flash");
    expect(qwen).toHaveLength(9);
    expect(qwen.every((line) => line.band === null)).toBe(true);
    expect([...new Set(qwen.map((line) => line.tierLabel))]).toEqual([
      "0-128k",
      "128k-256k",
      ">256k",
    ]);
    const firstTierOutput = qwen.find(
      (line) => line.tierLabel === "0-128k" && line.kind === "output",
    );
    expect(firstTierOutput?.cnyPerMillionTokens).toBe(1.5);
  });

  it("label 可读且不含 undefined，供前端直接当图例", () => {
    for (const line of lines) {
      expect(line.label).not.toMatch(/undefined|null/);
      expect(line.cnyPerMillionTokens).toBeGreaterThan(0);
    }
    expect(lines.some((line) => line.label === "输入（缓存命中）·空闲")).toBe(
      true,
    );
  });
});
