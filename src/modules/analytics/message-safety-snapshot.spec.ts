import {
  buildMessageSafetySnapshot,
  mergeSafetyIntoRawPayload,
  removeBackfilledSafety,
  type MessageSafetyDecision,
} from "./message-safety-snapshot";
import { ADVENTURE_UNSAFE_LINE } from "@/modules/adventure/adventure.constants";

const NOW = new Date("2026-11-23T10:00:00.000Z");

function decision(
  overrides: Partial<MessageSafetyDecision> = {},
): MessageSafetyDecision {
  return {
    safetyLayer: "L2",
    safetyCategory: "violence",
    safetyBlocked: true,
    safetySource: "l2_model",
    safetyMatched: null,
    ...overrides,
  };
}

describe("buildMessageSafetySnapshot", () => {
  it("拦截轮次回补为 canned_block，保留 layer/category/source/matched", () => {
    const snapshot = buildMessageSafetySnapshot({
      decision: decision(),
      mode: "adventure_story",
      assistantTexts: [ADVENTURE_UNSAFE_LINE],
      now: NOW,
    });

    expect(snapshot).toEqual({
      layer: "L2",
      category: "violence",
      blocked: true,
      source: "l2_model",
      matched: null,
      reply: "canned_block",
      inferred: false,
      backfilledAt: NOW.toISOString(),
    });
  });

  it("L2 不可用且回复命中固定安全句：回补 unsafe_line_echo", () => {
    const snapshot = buildMessageSafetySnapshot({
      decision: decision({
        safetyLayer: null,
        safetyCategory: null,
        safetyBlocked: false,
        safetySource: "l2_fail_open",
      }),
      mode: "adventure_story",
      assistantTexts: [`嗯……${ADVENTURE_UNSAFE_LINE}`],
      now: NOW,
    });

    expect(snapshot).toMatchObject({
      layer: null,
      category: null,
      blocked: false,
      source: "l2_fail_open",
      reply: "unsafe_line_echo",
      inferred: false,
    });
  });

  it("冒险 fail-open 但回复未命中安全句：回补 caution_injected", () => {
    const snapshot = buildMessageSafetySnapshot({
      decision: decision({
        safetyLayer: null,
        safetyCategory: null,
        safetyBlocked: false,
        safetySource: "l2_fail_open",
      }),
      mode: "adventure_story",
      assistantTexts: ["我们继续去森林吧。"],
      now: NOW,
    });

    expect(snapshot).toMatchObject({
      source: "l2_fail_open",
      reply: "caution_injected",
      inferred: false,
    });
  });

  it("非冒险模式的 fail-open 不推断 caution_injected", () => {
    const snapshot = buildMessageSafetySnapshot({
      decision: decision({
        safetyLayer: null,
        safetyCategory: null,
        safetyBlocked: false,
        safetySource: "l2_fail_open",
      }),
      mode: "free_chat",
      assistantTexts: ["我们聊点别的吧。"],
      now: NOW,
    });

    expect(snapshot).toMatchObject({ reply: "none", inferred: false });
  });

  it("无判定行但 AI 回复命中安全句：标记为 inferred_from_reply", () => {
    const snapshot = buildMessageSafetySnapshot({
      decision: null,
      mode: "adventure_story",
      assistantTexts: [ADVENTURE_UNSAFE_LINE],
      now: NOW,
    });

    expect(snapshot).toEqual({
      layer: null,
      category: null,
      blocked: false,
      source: "inferred_from_reply",
      matched: null,
      reply: "unsafe_line_echo",
      inferred: true,
      backfilledAt: NOW.toISOString(),
    });
  });

  it("无判定行且回复不含安全句：不生成快照", () => {
    expect(
      buildMessageSafetySnapshot({
        decision: null,
        mode: "adventure_story",
        assistantTexts: ["我们继续吧。"],
        now: NOW,
      }),
    ).toBeNull();
  });

  it("safe / not_evaluated 且无安全句：不回补", () => {
    expect(
      buildMessageSafetySnapshot({
        decision: decision({
          safetyLayer: "L2",
          safetyCategory: "safe",
          safetyBlocked: false,
          safetySource: "l2_model",
        }),
        mode: "free_chat",
        assistantTexts: ["好的呀"],
        now: NOW,
      }),
    ).toBeNull();
    expect(
      buildMessageSafetySnapshot({
        decision: decision({
          safetyLayer: null,
          safetyCategory: null,
          safetyBlocked: false,
          safetySource: "not_evaluated",
        }),
        mode: "adventure_story",
        assistantTexts: ["段落一"],
        now: NOW,
      }),
    ).toBeNull();
  });

  it("emotional_harm 即使没有安全句也回补（行为改变点）", () => {
    const snapshot = buildMessageSafetySnapshot({
      decision: decision({
        safetyCategory: "emotional_harm",
        safetyBlocked: false,
      }),
      mode: "free_chat",
      assistantTexts: ["你是不是和弟弟吵架了呀？"],
      now: NOW,
    });

    expect(snapshot).toMatchObject({
      category: "emotional_harm",
      blocked: false,
      reply: "none",
      inferred: false,
    });
  });
});

describe("mergeSafetyIntoRawPayload", () => {
  const snapshot = buildMessageSafetySnapshot({
    decision: decision(),
    mode: "adventure_story",
    assistantTexts: [ADVENTURE_UNSAFE_LINE],
    now: NOW,
  })!;

  it("保留原有 key 并追加 safety", () => {
    const result = mergeSafetyIntoRawPayload(
      { channel: "baidu-rtc" },
      snapshot,
      { force: false },
    );
    expect(result).toEqual({
      changed: true,
      replacedNonObject: false,
      payload: { channel: "baidu-rtc", safety: snapshot },
    });
  });

  it("已有相同 safety 时返回未变更（幂等）", () => {
    const result = mergeSafetyIntoRawPayload(
      { channel: "baidu-rtc", safety: snapshot },
      snapshot,
      { force: false },
    );
    expect(result).toEqual({
      changed: false,
      replacedNonObject: false,
      payload: { channel: "baidu-rtc", safety: snapshot },
    });
  });

  it("已有不同 safety 时默认不覆盖，force 才覆盖", () => {
    const existing = { ...snapshot, source: "old_source" };
    const kept = mergeSafetyIntoRawPayload({ safety: existing }, snapshot, {
      force: false,
    });
    expect(kept.changed).toBe(false);
    expect(kept.payload).toEqual({ safety: existing });

    const forced = mergeSafetyIntoRawPayload({ safety: existing }, snapshot, {
      force: true,
    });
    expect(forced.changed).toBe(true);
    expect(forced.payload).toEqual({ safety: snapshot });
  });

  it("rawPayload 为 null / 非对象时替换为只含 safety 的对象", () => {
    for (const raw of [null, "text", 42, ["a"]]) {
      const result = mergeSafetyIntoRawPayload(raw, snapshot, { force: false });
      expect(result.payload).toEqual({ safety: snapshot });
      expect(result.changed).toBe(true);
      expect(result.replacedNonObject).toBe(true);
    }
  });
});

describe("removeBackfilledSafety", () => {
  it("只移除带 backfilledAt 的快照", () => {
    const snapshot = buildMessageSafetySnapshot({
      decision: decision(),
      mode: "adventure_story",
      assistantTexts: [ADVENTURE_UNSAFE_LINE],
      now: NOW,
    })!;

    const removed = removeBackfilledSafety({
      channel: "baidu-rtc",
      safety: snapshot,
    });
    expect(removed).toEqual({
      changed: true,
      payload: { channel: "baidu-rtc" },
    });

    const untouched = removeBackfilledSafety({
      safety: { ...snapshot, backfilledAt: undefined },
    });
    expect(untouched.changed).toBe(false);
  });

  it("rawPayload 非对象或没有 safety 时不变", () => {
    expect(removeBackfilledSafety(null).changed).toBe(false);
    expect(removeBackfilledSafety({ answer: "hi" }).changed).toBe(false);
  });
});
