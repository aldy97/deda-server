import {
  extractRecentFillers,
  FILLER_POOLS,
  isFillerDuplicate,
  normalizeFiller,
  pickFillerLine,
  type FillerBucket,
} from "./filler-bank";

const CJK = /[\u4e00-\u9fff]/;

function cjkCount(text: string): number {
  return [...text.replace(/[\s\p{P}\p{S}]/gu, "")].length;
}

function wordCount(text: string): number {
  return text
    .replace(/[^A-Za-z' ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function opener(line: string): string {
  if (CJK.test(line)) {
    return normalizeFiller(line).slice(0, 4);
  }
  return line
    .toLowerCase()
    .replace(/[^a-z' ]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ");
}

const ZH_BUCKETS: FillerBucket[] = [
  "neutral",
  "question",
  "story",
  "sleep",
  "comfort",
  "celebrate",
  "identity",
  "preference",
  "stop",
  "continue",
];

const EN_BUCKETS: FillerBucket[] = [
  "en_neutral",
  "en_question",
  "en_story",
  "en_comfort",
  "en_celebrate",
  "en_stop",
  "en_continue",
];

describe("FILLER_POOLS invariants", () => {
  it("中文桶每条 15-20 字，英文桶每条 8-12 词", () => {
    for (const [bucket, pool] of Object.entries(FILLER_POOLS)) {
      const isEn = bucket.startsWith("en_");
      for (const line of pool) {
        const count = isEn ? wordCount(line) : cjkCount(line);
        if (isEn) {
          expect(count).toBeGreaterThanOrEqual(8);
          expect(count).toBeLessThanOrEqual(12);
        } else {
          expect(count).toBeGreaterThanOrEqual(15);
          expect(count).toBeLessThanOrEqual(20);
        }
      }
    }
  });

  it("中文以延续语气收尾，英文不以问号结尾", () => {
    for (const bucket of ZH_BUCKETS) {
      for (const line of FILLER_POOLS[bucket]) {
        expect(line).toMatch(/(呀|呢|……)$/);
      }
    }
    for (const bucket of EN_BUCKETS) {
      for (const line of FILLER_POOLS[bucket]) {
        expect(line).not.toMatch(/\?$/);
      }
    }
  });

  it("不含禁用开头、评价词、问号或名字", () => {
    const bannedOpeners = ["原来", "听起来", "你是不是", "难怪", "你说"];
    const bannedWords = [
      "真温柔",
      "真可爱",
      "真棒",
      "真厉害",
      "真乖",
      "小象 Elly",
    ];
    for (const pool of Object.values(FILLER_POOLS)) {
      for (const line of pool) {
        for (const opener of bannedOpeners) {
          expect(line.startsWith(opener)).toBe(false);
        }
        for (const word of bannedWords) {
          expect(line).not.toContain(word);
        }
        expect(line).not.toMatch(/[?？]/);
      }
    }
  });

  it("同一桶内无重复句、无重复开头", () => {
    for (const [bucket, pool] of Object.entries(FILLER_POOLS)) {
      const seen = new Set<string>();
      const openers = new Set<string>();
      for (const line of pool) {
        const normalized = normalizeFiller(line);
        const lineOpener = opener(line);
        expect({ bucket, line, duplicate: seen.has(normalized) }).toEqual({
          bucket,
          line,
          duplicate: false,
        });
        expect({
          bucket,
          line,
          duplicateOpener: openers.has(lineOpener),
        }).toEqual({ bucket, line, duplicateOpener: false });
        seen.add(normalized);
        openers.add(lineOpener);
      }
    }
  });

  it("每桶至少 12 条，保证 10 轮窗口后仍有候选", () => {
    for (const [bucket, pool] of Object.entries(FILLER_POOLS)) {
      expect({ bucket, size: pool.length }).toEqual({
        bucket,
        size: expect.any(Number),
      });
      expect(pool.length).toBeGreaterThanOrEqual(12);
    }
  });

  it("示例输入与任何模板都没有 4 字连续重叠", () => {
    const samples = [
      "我碰到了你最好的朋友",
      "我昨天去公园玩了",
      "我想吃冰淇淋",
      "恐龙为什么没有了",
    ];
    for (const pool of Object.values(FILLER_POOLS)) {
      for (const line of pool) {
        const compactLine = normalizeFiller(line);
        for (const sample of samples) {
          const compactSample = normalizeFiller(sample);
          for (let i = 0; i + 4 <= compactSample.length; i += 1) {
            expect(compactLine).not.toContain(compactSample.slice(i, i + 4));
          }
        }
      }
    }
  });
});

describe("story 桶视角迁移", () => {
  /** v1 的 13 条倾听视角句子：已删除，禁止回归 */
  const LEGACY_LISTENER_LINES = [
    "好呀，我先把小耳朵准备好，安安静静听你安排呢……",
    "好，我坐好啦，等你一说开始，我们就出发呀……",
    "嗯嗯，我准备好了，你一说我们就开始呀……",
    "我把小毯子盖好，安安静静等你开口呢……",
    "嗯，我乖乖坐好啦，慢慢听你的安排呀……",
    "嗯，我已经准备好啦，你说开始就开始呀……",
    "好，我把小手放好，安安静静等你讲故事呀……",
    "嗯，我坐好准备啦，你慢慢说，我认真听呀……",
    "我把小耳朵竖起来啦，等你的故事呀……",
    "嗯，我坐得稳稳的，等你带我去故事里呀……",
    "好呀，我把声音放得轻轻的，慢慢听你说呀……",
    "嗯，我准备好啦，你什么时候开始都可以呀……",
    "好，我安安静静坐好，等你讲故事给我听呀……",
  ];

  it("13 条旧倾听句全部消失", () => {
    for (const line of LEGACY_LISTENER_LINES) {
      expect(FILLER_POOLS.story).not.toContain(line);
    }
  });

  it("story / en_story 只保留讲述者视角", () => {
    for (const line of FILLER_POOLS.story) {
      expect(line).not.toMatch(/听你安排|听你说|等你|你来讲|开始都可以/);
    }
    for (const line of FILLER_POOLS.en_story) {
      expect(line).not.toMatch(
        /take your time|ready to listen|you can start|all ears/i,
      );
    }
  });
});

describe("pickFillerLine", () => {
  const base = {
    asrText: "我碰到了你最好的朋友",
    turnId: "turn-1",
    recentFillers: [] as string[],
  };

  it("普通陈述走 neutral，不碰孩子内容", () => {
    const picked = pickFillerLine({ ...base, intent: "free_chat" });
    expect(picked.bucket).toBe("neutral");
    expect(picked.text).not.toContain("朋友");
    expect(picked.text).not.toContain("碰到");
    expect(picked.text).not.toContain("原来");
  });

  it("故事/哄睡/问句/身份/偏好分桶", () => {
    expect(pickFillerLine({ ...base, intent: "sleep_story" }).bucket).toBe(
      "sleep",
    );
    expect(pickFillerLine({ ...base, intent: "english_story" }).bucket).toBe(
      "story",
    );
    expect(
      pickFillerLine({
        ...base,
        asrText: "为什么天是蓝的？",
        intent: "free_chat",
      }).bucket,
    ).toBe("question");
    expect(
      pickFillerLine({
        ...base,
        asrText: "你叫什么名字？",
        intent: "free_chat",
      }).bucket,
    ).toBe("identity");
    expect(
      pickFillerLine({
        ...base,
        asrText: "你喜欢吃什么？",
        intent: "free_chat",
      }).bucket,
    ).toBe("preference");
  });

  it("冒险已婉拒时强制 neutral，不预告冒险", () => {
    const picked = pickFillerLine({
      ...base,
      intent: "adventure_story",
      adventureDeclined: true,
    });
    expect(picked.bucket).toBe("neutral");
    expect(picked.text).not.toContain("冒险");
  });

  it("负面情绪走 comfort，正面情绪走 celebrate", () => {
    expect(
      pickFillerLine({ ...base, asrText: "我好难过", intent: "free_chat" })
        .bucket,
    ).toBe("comfort");
    expect(
      pickFillerLine({ ...base, asrText: "我好开心", intent: "free_chat" })
        .bucket,
    ).toBe("celebrate");
  });

  it("模型情绪优先于关键词", () => {
    expect(
      pickFillerLine({
        ...base,
        asrText: "我好开心",
        intent: "free_chat",
        emotion: "sad",
      }).bucket,
    ).toBe("comfort");
  });

  it("纯英文走 en_* 桶", () => {
    expect(
      pickFillerLine({
        ...base,
        asrText: "I can draw a cat",
        intent: "free_chat",
      }).bucket,
    ).toBe("en_neutral");
    expect(
      pickFillerLine({
        ...base,
        asrText: "Why is the sky blue?",
        intent: "free_chat",
      }).bucket,
    ).toBe("en_question");
  });

  it("最近 10 轮用过的句子不会再次出现", () => {
    const pool = FILLER_POOLS.neutral;
    const recent = pool.slice(0, 10);
    const picked = pickFillerLine({
      ...base,
      intent: "free_chat",
      recentFillers: recent,
    });
    expect(recent).not.toContain(picked.text);
  });

  it("同开头也会被避开", () => {
    const pool = FILLER_POOLS.neutral;
    const recent = [pool[0]];
    const picked = pickFillerLine({
      ...base,
      intent: "free_chat",
      recentFillers: recent,
    });
    expect(opener(picked.text)).not.toBe(opener(recent[0]));
  });

  it("同 turnId 稳定，不同 turnId 会变化", () => {
    const first = pickFillerLine({ ...base, intent: "free_chat" });
    const again = pickFillerLine({ ...base, intent: "free_chat" });
    expect(again.text).toBe(first.text);
    const others = new Set(
      Array.from(
        { length: 8 },
        (_, i) =>
          pickFillerLine({
            ...base,
            turnId: `turn-${i + 2}`,
            intent: "free_chat",
          }).text,
      ),
    );
    expect(others.size).toBeGreaterThan(1);
  });

  it("停止与继续走独立桶", () => {
    const stop = pickFillerLine({
      ...base,
      asrText: "我不要听了",
      intent: "free_chat",
      emotion: "sad",
    });
    expect(stop.bucket).toBe("stop");
    expect(stop.emotion).toBe("neutral");
    expect(FILLER_POOLS.stop).toContain(stop.text);

    const cont = pickFillerLine({
      ...base,
      asrText: "继续",
      intent: "sleep_story",
      intentSource: "continuation",
    });
    expect(cont.bucket).toBe("continue");
    expect(FILLER_POOLS.continue).toContain(cont.text);
  });

  it("“换一个”走 story 桶（讲述者视角），不落 stop", () => {
    const picked = pickFillerLine({
      ...base,
      asrText: "我不想听了，换一个",
      intent: "free_chat",
    });
    expect(picked.act).toBe("story_tell");
    expect(picked.bucket).toBe("story");
    expect(FILLER_POOLS.story).toContain(picked.text);
  });

  it("英文停止/继续走 en_stop / en_continue", () => {
    expect(
      pickFillerLine({
        ...base,
        asrText: "I don't want to listen",
        intent: "free_chat",
      }).bucket,
    ).toBe("en_stop");
    expect(
      pickFillerLine({
        ...base,
        asrText: "continue",
        intent: "free_chat",
      }).bucket,
    ).toBe("en_continue");
  });

  it("英文故事/情绪走 en_story / en_comfort / en_celebrate", () => {
    expect(
      pickFillerLine({
        ...base,
        asrText: "Tell me a story",
        intent: "english_story",
      }).bucket,
    ).toBe("en_story");
    expect(
      pickFillerLine({
        ...base,
        asrText: "I am sad",
        intent: "free_chat",
        emotion: "sad",
      }).bucket,
    ).toBe("en_comfort");
    expect(
      pickFillerLine({
        ...base,
        asrText: "I am happy",
        intent: "free_chat",
        emotion: "happy",
      }).bucket,
    ).toBe("en_celebrate");
  });

  it("最近 10 轮覆盖整桶时走兜底轮转", () => {
    const picked = pickFillerLine({
      ...base,
      intent: "free_chat",
      recentFillers: [...FILLER_POOLS.neutral],
    });
    expect(FILLER_POOLS.neutral).toContain(picked.text);
  });
});

describe("normalizeFiller / isFillerDuplicate", () => {
  it("去标点、空白、大小写", () => {
    expect(normalizeFiller("Hello, 世界！")).toBe("hello世界");
    expect(isFillerDuplicate("Hello World", ["hello world"])).toBe(true);
    expect(isFillerDuplicate("新句子", ["旧的"])).toBe(false);
  });
});

describe("extractRecentFillers", () => {
  it("倒序输入取最近 10 条并转正序", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      rawPayload: { filler: `f${i}`, answer: "a" },
    }));
    const fillers = extractRecentFillers(rows, 10);
    expect(fillers).toHaveLength(10);
    expect(fillers[0]).toBe("f9");
    expect(fillers[9]).toBe("f0");
  });

  it("跳过无 rawPayload / 非字符串 filler", () => {
    const rows = [
      { rawPayload: null },
      { rawPayload: {} },
      { rawPayload: { filler: 123 } },
      { rawPayload: { filler: "有效" } },
    ];
    expect(extractRecentFillers(rows, 10)).toEqual(["有效"]);
  });
});
