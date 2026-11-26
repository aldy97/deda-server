import { ChildSafetyService } from "@/modules/vendor/child-safety.service";
import {
  ADVENTURE_UNSAFE_LINE,
  resolveSafetyInstruction,
} from "./safety-profile";
import type { SafetyVerdict } from "@/modules/vendor/child-safety.service";
import {
  SafetyGateService,
  diffSafetyEvaluations,
} from "./safety-gate.service";

function verdict(overrides: Partial<SafetyVerdict> = {}): SafetyVerdict {
  return {
    blocked: true,
    category: "violence",
    layer: "L2",
    source: "l2_model",
    matched: null,
    ...overrides,
  };
}

const cannedReply = jest.fn().mockReturnValue("这个话题不适合小朋友聊哦。");
const childSafety = { cannedReply } as unknown as ChildSafetyService;
const gate = new SafetyGateService(childSafety);

beforeEach(() => {
  cannedReply.mockClear();
});

describe("SafetyGateService.interpret", () => {
  it("blocked → canned + canned_block + snapshot", () => {
    const result = gate.interpret({ verdict: verdict(), intent: "free_chat" });
    expect(result).toMatchObject({
      profile: "default",
      blocked: true,
      safetyReply: "canned_block",
      cannedReply: "这个话题不适合小朋友聊哦。",
      promptInstruction: undefined,
      snapshot: {
        layer: "L2",
        category: "violence",
        blocked: true,
        reply: "canned_block",
        inferred: false,
      },
    });
    expect(cannedReply).toHaveBeenCalledWith("violence");
  });

  it("emotional_harm → 不拦截但注入共情指令并写快照", () => {
    const result = gate.interpret({
      verdict: verdict({
        blocked: false,
        category: "emotional_harm",
      }),
      intent: "free_chat",
    });
    expect(result).toMatchObject({
      blocked: false,
      safetyReply: "none",
      promptInstruction: ChildSafetyService.EMOTIONAL_HARM_GUIDANCE,
      snapshot: { category: "emotional_harm", reply: "none" },
    });
    expect(result?.cannedReply).toBeUndefined();
  });

  it("fail-open → 不拦截，但写 fail-open 快照", () => {
    const result = gate.interpret({
      verdict: verdict({
        blocked: false,
        category: null,
        layer: null,
        source: "l2_fail_open",
      }),
      intent: "free_chat",
    });
    expect(result).toMatchObject({
      blocked: false,
      safetyReply: "none",
      promptInstruction: undefined,
      snapshot: { source: "l2_fail_open", reply: "none" },
    });
  });

  it("safe → 不写快照", () => {
    expect(
      gate.interpret({
        verdict: verdict({ blocked: false, category: "safe" }),
        intent: "free_chat",
      })?.snapshot,
    ).toBeNull();
  });

  it("sleep_story / sleep_config 使用 sleep profile", () => {
    expect(
      gate.interpret({ verdict: verdict(), mode: "sleep_story" }),
    ).toMatchObject({
      profile: "sleep",
      blocked: true,
      safetyReply: "canned_block",
      cannedReply: "这个话题不适合小朋友聊哦。",
    });
    expect(
      gate.interpret({ verdict: verdict(), intent: "sleep_config" }),
    ).toMatchObject({ profile: "sleep", blocked: true });
  });

  it("sleep profile 的 emotional_harm 仍注入共情指令", () => {
    expect(
      gate.interpret({
        verdict: verdict({ blocked: false, category: "emotional_harm" }),
        mode: "sleep_story",
      }),
    ).toMatchObject({
      profile: "sleep",
      blocked: false,
      promptInstruction: ChildSafetyService.EMOTIONAL_HARM_GUIDANCE,
      snapshot: { category: "emotional_harm" },
    });
  });

  it("adventure profile 在 Phase 3 仍返回 null，由旧链路继续", () => {
    expect(
      gate.interpret({ verdict: verdict(), mode: "adventure_story" }),
    ).toBeNull();
  });
});

describe("diffSafetyEvaluations", () => {
  const base = gate.interpret({ verdict: verdict(), intent: "free_chat" })!;

  it("完全一致返回空数组", () => {
    expect(diffSafetyEvaluations(base, { ...base })).toEqual([]);
  });

  it("逐项报告差异", () => {
    const next = {
      ...base,
      blocked: false,
      safetyReply: "none" as const,
      cannedReply: undefined,
      promptInstruction: "inject",
      snapshot: null,
    };
    const diffs = diffSafetyEvaluations(base, next);
    expect(diffs).toEqual(
      expect.arrayContaining([
        "blocked",
        "safetyReply",
        "cannedReply",
        "promptInstruction",
        "snapshot",
      ]),
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SafetyGateService.openLazyHandle", () => {
  const open = (getVerdict: jest.Mock) =>
    gate.openLazyHandle({ profile: "adventure", getVerdict })!;

  it("非 adventure profile 返回 null", () => {
    const getVerdict = jest.fn();
    expect(gate.openLazyHandle({ mode: "free_chat", getVerdict })).toBeNull();
    expect(
      gate.openLazyHandle({ intent: "sleep_story", getVerdict }),
    ).toBeNull();
    expect(gate.openLazyHandle({ profile: "default", getVerdict })).toBeNull();
  });

  it("adventure 的 profile / mode / intent 三种入口都能打开句柄", () => {
    const getVerdict = jest.fn();
    expect(
      gate.openLazyHandle({ profile: "adventure", getVerdict }),
    ).not.toBeNull();
    expect(
      gate.openLazyHandle({ mode: "adventure_story", getVerdict }),
    ).not.toBeNull();
    expect(
      gate.openLazyHandle({ intent: "adventure_story", getVerdict }),
    ).not.toBeNull();
  });

  it("并发调用单飞：getVerdict 只执行一次，结果共享", async () => {
    const d = deferred<SafetyVerdict>();
    const getVerdict = jest.fn(() => d.promise);
    const handle = open(getVerdict);

    const first = handle.evaluateIfNeeded();
    const second = handle.evaluateIfNeeded();
    d.resolve(verdict({ blocked: false, category: "safe" }));

    await expect(first).resolves.toMatchObject({ category: "safe" });
    await expect(second).resolves.toBe(await first);
    await handle.evaluateIfNeeded();
    expect(getVerdict).toHaveBeenCalledTimes(1);
  });

  it("评估失败 → null 且不重试，finalize 记 evaluated=true", async () => {
    const getVerdict = jest.fn().mockRejectedValue(new Error("down"));
    const handle = open(getVerdict);

    await expect(handle.evaluateIfNeeded()).resolves.toBeNull();
    await expect(handle.evaluateIfNeeded()).resolves.toBeNull();
    expect(getVerdict).toHaveBeenCalledTimes(1);
    // 与现状 resolveSafety 语义一致：null verdict 只代表「无结论」，
    // safetyReply 记 none，谨慎指令仍由 promptInstruction 注入。
    expect(handle.finalize({ texts: ["好的"] })).toMatchObject({
      evaluated: true,
      safetyReply: "none",
      snapshot: null,
      promptInstruction: resolveSafetyInstruction("adventure", null),
    });
  });

  it("promptInstruction 与 safety 纯函数逐值一致", () => {
    const handle = open(jest.fn());
    const cases = [
      null,
      undefined,
      verdict({ category: null, source: "l2_fail_open" }),
      verdict({ category: null, source: "l2_invalid_label" }),
      verdict({ category: "emotional_harm" }),
      verdict({ category: "safe" }),
    ] as const;
    for (const value of cases) {
      expect(handle.promptInstruction(value)).toBe(
        resolveSafetyInstruction("adventure", value),
      );
    }
  });

  it("finalize 优先使用产生点的显式处置，未评估也能给退化快照", () => {
    const handle = open(jest.fn());
    const evaluation = handle.finalize({
      texts: ["我们先回到故事里，好吗？"],
      safetyBlocked: true,
      safetyDisposition: "canned_block",
    });

    expect(evaluation).toMatchObject({
      profile: "adventure",
      blocked: true,
      safetyReply: "canned_block",
      cannedReply: ADVENTURE_UNSAFE_LINE,
      evaluated: false,
    });
    expect(evaluation.snapshot).toMatchObject({
      blocked: true,
      source: "not_evaluated",
      reply: "canned_block",
      inferred: true,
    });
  });

  it("finalize 用缓存 verdict 解释拦截并写快照", async () => {
    const handle = open(
      jest.fn().mockResolvedValue(verdict({ category: "violence" })),
    );
    await handle.evaluateIfNeeded();

    const evaluation = handle.finalize({ texts: [] });

    expect(evaluation).toMatchObject({
      blocked: true,
      safetyReply: "canned_block",
      cannedReply: ADVENTURE_UNSAFE_LINE,
      evaluated: true,
    });
    expect(evaluation.snapshot).toMatchObject({
      category: "violence",
      blocked: true,
      reply: "canned_block",
      inferred: false,
    });
  });

  it("finalize 推断模型回抄安全句为 unsafe_line_echo", async () => {
    const handle = open(
      jest
        .fn()
        .mockResolvedValue(verdict({ blocked: false, category: "safe" })),
    );
    await handle.evaluateIfNeeded();

    const evaluation = handle.finalize({
      texts: [`嗯……${ADVENTURE_UNSAFE_LINE}`],
    });

    expect(evaluation).toMatchObject({
      blocked: false,
      safetyReply: "unsafe_line_echo",
    });
    expect(evaluation.snapshot).toMatchObject({
      source: "l2_model",
      reply: "unsafe_line_echo",
      inferred: false,
    });
  });

  it("未评估但模型回抄安全句：写退化快照并标记 inferred", () => {
    const handle = open(jest.fn());

    const evaluation = handle.finalize({
      texts: [`嗯……${ADVENTURE_UNSAFE_LINE}`],
    });

    expect(evaluation).toMatchObject({
      blocked: false,
      safetyReply: "unsafe_line_echo",
      evaluated: false,
    });
    expect(evaluation.snapshot).toMatchObject({
      source: "inferred_from_reply",
      reply: "unsafe_line_echo",
      inferred: true,
    });
  });

  it("finalize 把 fail-open verdict 解释为 caution_injected", async () => {
    const failOpen = verdict({
      blocked: false,
      category: null,
      source: "l2_fail_open",
    });
    const handle = open(jest.fn().mockResolvedValue(failOpen));
    await handle.evaluateIfNeeded();

    const evaluation = handle.finalize({ texts: ["接住啦"] });

    expect(evaluation).toMatchObject({
      blocked: false,
      safetyReply: "caution_injected",
      promptInstruction: resolveSafetyInstruction("adventure", failOpen),
    });
    expect(evaluation.snapshot).toMatchObject({
      source: "l2_fail_open",
      reply: "caution_injected",
    });
  });

  it("finalize 对 safe 轮次返回 none 且不写快照", async () => {
    const handle = open(
      jest
        .fn()
        .mockResolvedValue(verdict({ blocked: false, category: "safe" })),
    );
    await handle.evaluateIfNeeded();

    const evaluation = handle.finalize({ texts: ["我们去森林！"] });

    expect(evaluation).toMatchObject({
      blocked: false,
      safetyReply: "none",
      cannedReply: undefined,
      snapshot: null,
      evaluated: true,
    });
  });

  it("finalize 从不触发评估", () => {
    const getVerdict = jest.fn();
    const handle = open(getVerdict);

    const evaluation = handle.finalize({ texts: ["好的"] });

    expect(getVerdict).not.toHaveBeenCalled();
    expect(evaluation).toMatchObject({
      safetyReply: "none",
      snapshot: null,
      evaluated: false,
    });
  });
});
