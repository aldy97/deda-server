import {
  buildMatchedChoice,
  findCurrentInteraction,
  resolveChoiceLlmEnabled,
  toRecapLines,
  withInteractionMeta,
} from "./adventure-reply";
import type { AdventureReply, PlayableSegment } from "./adventure.service";

const segment = (
  overrides: Partial<PlayableSegment> = {},
): PlayableSegment => ({
  order: 0,
  kind: "narration",
  text: "t",
  ...overrides,
});

describe("withInteractionMeta", () => {
  const reply: AdventureReply = { texts: ["a"], action: "narrate" };

  it("空 interaction 原样返回", () => {
    expect(withInteractionMeta(reply, null)).toBe(reply);
    expect(withInteractionMeta(reply, undefined)).toBe(reply);
  });

  it("盖上交互类型与段号，缺省类型落 unknown", () => {
    const withType = withInteractionMeta(
      reply,
      segment({ order: 3, interactionType: "two_choice" }),
    );
    expect(withType.interaction).toEqual({ type: "two_choice", order: 3 });

    const withoutType = withInteractionMeta(reply, segment({ order: 5 }));
    expect(withoutType.interaction).toEqual({ type: "unknown", order: 5 });
  });
});

describe("findCurrentInteraction", () => {
  const segments = [
    segment({ order: 0, kind: "narration" }),
    segment({ order: 1, kind: "interaction", interactionType: "two_choice" }),
    segment({ order: 2, kind: "narration" }),
  ];

  it("定位 nextSegmentOrder - 1 的交互段", () => {
    expect(
      findCurrentInteraction({ nextSegmentOrder: 2 }, segments)?.order,
    ).toBe(1);
  });

  it("非交互段不认", () => {
    expect(
      findCurrentInteraction({ nextSegmentOrder: 1 }, segments),
    ).toBeUndefined();
  });

  it("无匹配时返回 undefined", () => {
    expect(
      findCurrentInteraction({ nextSegmentOrder: 99 }, segments),
    ).toBeUndefined();
  });
});

describe("toRecapLines", () => {
  it("空 recap 返回空数组", () => {
    expect(toRecapLines(null)).toEqual([]);
  });
  it("非空 recap 包成单元素数组", () => {
    expect(toRecapLines("前情回顾")).toEqual(["前情回顾"]);
  });
});

describe("resolveChoiceLlmEnabled", () => {
  it("未配置回落默认值", () => {
    expect(resolveChoiceLlmEnabled(undefined, true)).toBe(true);
    expect(resolveChoiceLlmEnabled(undefined, false)).toBe(false);
    expect(resolveChoiceLlmEnabled("", true)).toBe(true);
    expect(resolveChoiceLlmEnabled("  ", false)).toBe(false);
  });
  it("字面 false/0 关，其余开", () => {
    expect(resolveChoiceLlmEnabled("false", true)).toBe(false);
    expect(resolveChoiceLlmEnabled("FALSE", true)).toBe(false);
    expect(resolveChoiceLlmEnabled("0", true)).toBe(false);
    expect(resolveChoiceLlmEnabled("true", false)).toBe(true);
    expect(resolveChoiceLlmEnabled("1", false)).toBe(true);
    expect(resolveChoiceLlmEnabled("yes", false)).toBe(true);
  });
});

describe("buildMatchedChoice", () => {
  it("确定性命中封装", () => {
    const mc = buildMatchedChoice({
      index: 0,
      source: "deterministic",
      choices: [{ key: "forest" }],
      segmentOrder: 2,
      episodeVersionId: "v1",
    });
    expect(mc).toEqual({
      index: 0,
      source: "deterministic",
      key: "forest",
      segmentOrder: 2,
      episodeVersionId: "v1",
    });
  });

  it("缺 key 落 null", () => {
    const mc = buildMatchedChoice({
      index: 1,
      source: "llm",
      choices: [{ key: "a" }, {}],
      segmentOrder: 4,
      episodeVersionId: null,
    });
    expect(mc.key).toBeNull();
    expect(mc.episodeVersionId).toBeNull();
  });
});
