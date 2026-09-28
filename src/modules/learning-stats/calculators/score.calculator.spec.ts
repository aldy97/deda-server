import { ScoreCalculator } from "./score.calculator";

describe("ScoreCalculator", () => {
  const calculator = new ScoreCalculator();

  const msg = (content: string) => ({ content });

  it("returns null for empty input", () => {
    expect(calculator.calculate([])).toBeNull();
  });

  it("scores all-English word-rich turns high", () => {
    const result = calculator.calculate([
      msg("I want to play football with my friends today"),
      msg("My mother cooks delicious noodles every weekend"),
    ]);

    // 英文占比 1 → 70 分;平均词数 ≥8 → 30 分
    expect(result).toBe(100);
  });

  it("scores all-Chinese turns with zero English ratio", () => {
    const result = calculator.calculate([
      msg("我今天很开心"),
      msg("我不想睡觉"),
    ]);

    // 英文占比 0 → 0 分;词数 0 → 0 分
    expect(result).toBe(0);
  });

  it("scores mixed Chinese/English by English ratio and word count", () => {
    const result = calculator.calculate([
      msg("我想喝果汁"), // 中文
      msg("I want juice"), // 英文,3 词
    ]);

    // 英文占比 0.5 → 35;英文消息平均词数 3/8×30 ≈ 11 → 合计 46
    expect(result).toBe(46);
  });

  it("treats mostly-Latin messages as English", () => {
    expect(calculator.calculate([msg("I like apple 苹果")]))
      // 拉丁字母占比 > 60% → 英文;词数 3 → 70 + round(3/8*30)=11
      .toBe(81);
  });

  it("caps word-count component at the maximum", () => {
    const long =
      "one two three four five six seven eight nine ten eleven twelve";
    const result = calculator.calculate([msg(long)]);

    expect(result).toBe(100);
  });
});
