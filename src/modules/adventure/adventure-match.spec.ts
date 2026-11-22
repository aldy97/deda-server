import {
  diagnoseChoiceMatch,
  matchChoiceDeterministic,
  parseChoiceVerdict,
  MatchableChoice,
} from "./adventure-match";

describe("matchChoiceDeterministic", () => {
  const riverLand: MatchableChoice[] = [{ text: "河边" }, { text: "陆地" }];

  const pathBridge: MatchableChoice[] = [{ text: "小路" }, { text: "小桥" }];

  // ── 非字符串 / 空字符串 ──

  it("returns null for empty string", () => {
    expect(matchChoiceDeterministic(riverLand, "")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(matchChoiceDeterministic(riverLand, "   ")).toBeNull();
  });

  // ── 非数组 / 空数组 ──

  it("returns null for an empty choices array", () => {
    expect(matchChoiceDeterministic([], "河边")).toBeNull();
  });

  it("returns null when choices is not an array", () => {
    expect(matchChoiceDeterministic(null as any, "河边")).toBeNull();
  });

  // ── 零命中 ──

  it("returns null when no choice text is present in asrText", () => {
    expect(
      matchChoiceDeterministic(riverLand, "有水的地方太危险了"),
    ).toBeNull();
  });

  it("returns null when asrText mentions neither choice", () => {
    expect(matchChoiceDeterministic(riverLand, "先走小路再走桥")).toBeNull();
  });

  // ── 单命中 ──

  it("returns index 0 for a direct match of the first choice", () => {
    expect(matchChoiceDeterministic(riverLand, "河边")).toBe(0);
  });

  it("returns index 1 for a match of the second choice", () => {
    expect(matchChoiceDeterministic(riverLand, "我们去陆地吧")).toBe(1);
  });

  // ── 双命中 → null（不取第一个）──

  it("returns null when asrText contains both option texts", () => {
    expect(matchChoiceDeterministic(pathBridge, "先走小路再走小桥")).toBeNull();
  });

  // ── 否定守卫 ──

  it("returns null when the matched text is preceded by 不", () => {
    expect(
      matchChoiceDeterministic(riverLand, "不要走河边，走陆地"),
    ).toBeNull();
  });

  it("returns null when the matched text is preceded by 别", () => {
    expect(matchChoiceDeterministic([{ text: "河边" }], "别去河边")).toBeNull();
  });

  it("returns the index when a negation word appears outside the 4-char lookbehind window", () => {
    expect(
      matchChoiceDeterministic(riverLand, "我不喜欢下雨，我们去河边"),
    ).toBe(0);
  });

  // ── key 绝不参与匹配 ──

  it("returns null when asrText matches only key, not text (English key exclusion)", () => {
    expect(
      matchChoiceDeterministic([{ key: "river", text: "河边" }], "river"),
    ).toBeNull();
  });

  it("returns null when asrText matches a Chinese key but not text (polly/1/1 bug repro)", () => {
    expect(
      matchChoiceDeterministic(
        [
          { key: "不要", text: "这个是什么呢" },
          { key: "要的", text: "什么意思" },
        ],
        "不要",
      ),
    ).toBeNull();
  });

  // ── 空文案的选项被跳过 ──

  it("returns null when the only non-empty choice has no match and empty-choice is skipped", () => {
    expect(
      matchChoiceDeterministic(
        [{ text: "" }, { text: "陆地" }],
        "随便说点什么",
      ),
    ).toBeNull();
  });

  it("returns index 1 when an empty-text choice is skipped and the other matches", () => {
    expect(
      matchChoiceDeterministic([{ text: "" }, { text: "陆地" }], "我要去陆地"),
    ).toBe(1);
  });
});

describe("diagnoseChoiceMatch", () => {
  const riverLand: MatchableChoice[] = [{ text: "河边" }, { text: "陆地" }];

  it("reports empty_text for blank input", () => {
    expect(diagnoseChoiceMatch(riverLand, "   ")).toEqual({
      index: null,
      reason: "empty_text",
      hitIndices: [],
    });
  });

  it("reports no_choices for an empty or non-array choices list", () => {
    expect(diagnoseChoiceMatch([], "河边")).toEqual({
      index: null,
      reason: "no_choices",
      hitIndices: [],
    });
    expect(diagnoseChoiceMatch(null as any, "河边")).toEqual({
      index: null,
      reason: "no_choices",
      hitIndices: [],
    });
  });

  it("reports no_hit when no option text appears", () => {
    expect(diagnoseChoiceMatch(riverLand, "有水的地方太危险了")).toEqual({
      index: null,
      reason: "no_hit",
      hitIndices: [],
    });
  });

  it("reports multi_hit when both option texts appear", () => {
    expect(
      diagnoseChoiceMatch(
        [{ text: "小路" }, { text: "小桥" }],
        "先走小路再走小桥",
      ),
    ).toEqual({
      index: null,
      reason: "multi_hit",
      hitIndices: [0, 1],
    });
  });

  it("reports negation_guard for a negated mention", () => {
    expect(diagnoseChoiceMatch(riverLand, "你不应该偷拿别人的东西")).toEqual({
      index: null,
      reason: "no_hit",
      hitIndices: [],
    });
    expect(diagnoseChoiceMatch(riverLand, "不要走河边")).toEqual({
      index: null,
      reason: "negation_guard",
      hitIndices: [0],
    });
  });

  it("reports matched with the winning index", () => {
    expect(diagnoseChoiceMatch(riverLand, "我们去陆地吧")).toEqual({
      index: 1,
      reason: "matched",
      hitIndices: [1],
    });
  });
});

describe("parseChoiceVerdict", () => {
  // ── 有效输入：序数 0 ──

  it("parses '0' as index 0 with empty redirect", () => {
    expect(parseChoiceVerdict("0", 2)).toEqual({ index: 0, redirectText: "" });
  });

  it("parses '0' with redirect text after newline", () => {
    const result = parseChoiceVerdict("0\n我们去陆地吧", 2);
    expect(result.index).toBe(0);
    expect(result.redirectText).toBe("我们去陆地吧");
  });

  it("parses '0' with redirect text spanning multiple lines", () => {
    const result = parseChoiceVerdict("0\n第一句\n第二句", 2);
    expect(result.index).toBe(0);
    expect(result.redirectText).toBe("第一句\n第二句");
  });

  // ── 有效输入：序数 1 ──

  it("parses '1' as index 1 with empty redirect", () => {
    expect(parseChoiceVerdict("1", 2)).toEqual({ index: 1, redirectText: "" });
  });

  it("parses '1' with trailing newline and empty redirect", () => {
    expect(parseChoiceVerdict("1\n", 2)).toEqual({
      index: 1,
      redirectText: "",
    });
  });

  it("parses '1' with redirect text", () => {
    const result = parseChoiceVerdict("1\n走，我们去森林！", 2);
    expect(result.index).toBe(1);
    expect(result.redirectText).toBe("走，我们去森林！");
  });

  // ── 空白容忍 ──

  it("trims whitespace around the verdict digit", () => {
    expect(parseChoiceVerdict(" 1 ", 2)).toEqual({
      index: 1,
      redirectText: "",
    });
  });

  it("trims whitespace around the verdict and keeps redirect", () => {
    const result = parseChoiceVerdict(" 0 \n好的，就这么办", 2);
    expect(result.index).toBe(0);
    expect(result.redirectText).toBe("好的，就这么办");
  });

  // ── NONE ──

  it("parses 'NONE' as null index with empty redirect", () => {
    expect(parseChoiceVerdict("NONE", 2)).toEqual({
      index: null,
      redirectText: "",
    });
  });

  it("parses 'none' case-insensitively", () => {
    expect(parseChoiceVerdict("none", 2)).toEqual({
      index: null,
      redirectText: "",
    });
  });

  it("parses 'NONE' with remaining lines as redirect text", () => {
    const result = parseChoiceVerdict("NONE\n孩子说得不清楚", 2);
    expect(result.index).toBeNull();
    expect(result.redirectText).toBe("孩子说得不清楚");
  });

  // ── 越界 ──

  it("returns null index when parsed digit exceeds choiceCount", () => {
    const result = parseChoiceVerdict("2", 2);
    expect(result.index).toBeNull();
    expect(result.redirectText).toBe("");
  });

  it("returns null index when parsed 3 for 2 choices", () => {
    const result = parseChoiceVerdict("3", 2);
    expect(result.index).toBeNull();
    expect(result.redirectText).toBe("");
  });

  // ── 无效输入 ──

  it("returns null for empty string", () => {
    const result = parseChoiceVerdict("", 2);
    expect(result.index).toBeNull();
    expect(result.redirectText).toBe("");
  });

  it("returns null for whitespace-only string", () => {
    const result = parseChoiceVerdict("   ", 2);
    expect(result.index).toBeNull();
    expect(result.redirectText).toBe("");
  });

  it("returns null for non-numeric garbage first line", () => {
    const result = parseChoiceVerdict("我不知道", 2);
    expect(result.index).toBeNull();
    expect(result.redirectText).toBe("");
  });

  it("returns null for multi-line content with garbage first line", () => {
    const result = parseChoiceVerdict("随便\n说点什么", 2);
    expect(result.index).toBeNull();
    expect(result.redirectText).toBe("");
  });

  it("returns null for '0' when choiceCount is 0", () => {
    const result = parseChoiceVerdict("0", 0);
    expect(result.index).toBeNull();
    expect(result.redirectText).toBe("");
  });

  // ── 非字符串输入 ──

  it("returns null for null input", () => {
    const result = parseChoiceVerdict(null, 2);
    expect(result.index).toBeNull();
    expect(result.redirectText).toBe("");
  });

  it("returns null for undefined input", () => {
    const result = parseChoiceVerdict(undefined, 2);
    expect(result.index).toBeNull();
    expect(result.redirectText).toBe("");
  });

  it("returns null for number input", () => {
    const result = parseChoiceVerdict(123, 2);
    expect(result.index).toBeNull();
    expect(result.redirectText).toBe("");
  });

  // ── 边界：空行前缀 ──

  it("treats leading empty lines as garbage and returns null", () => {
    const result = parseChoiceVerdict("\n\n0", 2);
    expect(result.index).toBeNull();
    expect(result.redirectText).toBe("");
  });

  it("handles trailing newlines after a valid verdict gracefully", () => {
    const result = parseChoiceVerdict("1\n\n", 2);
    expect(result.index).toBe(1);
    expect(result.redirectText).toBe("");
  });
});
