import { matchChoiceDeterministic, MatchableChoice } from "./adventure-match";

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
