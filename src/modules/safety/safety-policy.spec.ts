import {
  buildSafetySnapshot,
  isSafetyEvent,
  resolveSafetyReply,
  shouldPersistAsrText,
} from "./safety-policy";
import type { SafetyReply } from "./safety.types";
import type { SafetyVerdict } from "@/modules/vendor/child-safety.service";

const UNSAFE = "我们先回到故事里，好吗？";

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

const safe = verdict({
  blocked: false,
  category: "safe",
  source: "l2_model",
});
const emotional = verdict({
  blocked: false,
  category: "emotional_harm",
  source: "l2_model",
});
const failOpen = verdict({
  blocked: false,
  category: null,
  layer: null,
  source: "l2_fail_open",
});
const invalidLabel = verdict({
  blocked: false,
  category: null,
  layer: "L2",
  source: "l2_invalid_label",
});

describe("isSafetyEvent", () => {
  it.each([
    ["blocked", verdict(), "none", true, true],
    ["emotional_harm", emotional, "none", true, true],
    ["fail-open 未触发", failOpen, "none", true, false],
    ["非法标签未触发", invalidLabel, "none", true, false],
    ["无 verdict + 回抄", null, "unsafe_line_echo", true, true],
    ["无 verdict + 固定话术", null, "canned_block", true, true],
    ["无 verdict + 谨慎指令", null, "caution_injected", true, true],
    ["safe + 未触发", safe, "none", false, false],
    ["无 verdict + 未触发", null, "none", false, false],
  ] as Array<[string, SafetyVerdict | null, SafetyReply, boolean, boolean]>)(
    "%s → 快照 %s / 留原文 %s",
    (_name, safety, reply, eventExpected, persistExpected) => {
      expect(isSafetyEvent(safety, reply)).toBe(eventExpected);
      expect(shouldPersistAsrText(safety, reply)).toBe(persistExpected);
    },
  );
});

describe("buildSafetySnapshot", () => {
  it("blocked → canned_block，保留判定字段", () => {
    expect(buildSafetySnapshot(verdict(), "canned_block")).toEqual({
      layer: "L2",
      category: "violence",
      blocked: true,
      source: "l2_model",
      matched: null,
      reply: "canned_block",
      inferred: false,
    });
  });

  it("fail-open + 回抄 → unsafe_line_echo", () => {
    expect(buildSafetySnapshot(failOpen, "unsafe_line_echo")).toMatchObject({
      layer: null,
      category: null,
      blocked: false,
      source: "l2_fail_open",
      reply: "unsafe_line_echo",
      inferred: false,
    });
  });

  it("fail-open 未回抄 → caution_injected", () => {
    expect(buildSafetySnapshot(failOpen, "caution_injected")).toMatchObject({
      source: "l2_fail_open",
      reply: "caution_injected",
      inferred: false,
    });
  });

  it("emotional_harm 即使未触发安全话术也写快照", () => {
    expect(buildSafetySnapshot(emotional, "none")).toMatchObject({
      category: "emotional_harm",
      blocked: false,
      reply: "none",
      inferred: false,
    });
  });

  it("safe + 未触发 → null", () => {
    expect(buildSafetySnapshot(safe, "none")).toBeNull();
  });

  it("无 verdict + 回抄 → 退化快照", () => {
    expect(buildSafetySnapshot(null, "unsafe_line_echo")).toEqual({
      layer: null,
      category: null,
      blocked: false,
      source: "inferred_from_reply",
      matched: null,
      reply: "unsafe_line_echo",
      inferred: true,
    });
  });

  it("无 verdict + 固定话术 → 退化快照且 blocked=true", () => {
    expect(buildSafetySnapshot(null, "canned_block")).toEqual({
      layer: null,
      category: null,
      blocked: true,
      source: "not_evaluated",
      matched: null,
      reply: "canned_block",
      inferred: true,
    });
  });

  it("无 verdict + 谨慎指令 → 退化快照", () => {
    expect(buildSafetySnapshot(null, "caution_injected")).toMatchObject({
      blocked: false,
      source: "not_evaluated",
      reply: "caution_injected",
      inferred: true,
    });
  });

  it("无 verdict + 未触发 → null", () => {
    expect(buildSafetySnapshot(null, "none")).toBeNull();
  });
});

describe("resolveSafetyReply", () => {
  it("代码已标记 blocked → canned_block", () => {
    expect(
      resolveSafetyReply({
        texts: ["继续故事"],
        safetyBlocked: true,
        verdict: null,
        unsafeLine: UNSAFE,
      }),
    ).toBe("canned_block");
  });

  it("verdict blocked → canned_block", () => {
    expect(
      resolveSafetyReply({
        texts: ["继续故事"],
        verdict: verdict(),
        unsafeLine: UNSAFE,
      }),
    ).toBe("canned_block");
  });

  it("回复包含固定安全句 → unsafe_line_echo", () => {
    expect(
      resolveSafetyReply({
        texts: [`嗯……${UNSAFE}`],
        verdict: failOpen,
        unsafeLine: UNSAFE,
      }),
    ).toBe("unsafe_line_echo");
  });

  it("fail-open 未回抄 → caution_injected", () => {
    expect(
      resolveSafetyReply({
        texts: ["我们继续去森林吧。"],
        verdict: failOpen,
        unsafeLine: UNSAFE,
      }),
    ).toBe("caution_injected");
  });

  it("safe 且未回抄 → none", () => {
    expect(
      resolveSafetyReply({
        texts: ["好的呀"],
        verdict: safe,
        unsafeLine: UNSAFE,
      }),
    ).toBe("none");
  });
});
