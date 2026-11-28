import {
  DEFAULT_FORBIDDEN_WORDS,
  parseForbiddenWordsOverride,
  resolveForbiddenWords,
} from "./forbidden-words";

describe("forbidden words", () => {
  it("baseline 固定 20 个词，且都是 ≥2 字的子串安全词", () => {
    expect(DEFAULT_FORBIDDEN_WORDS).toHaveLength(20);
    expect(new Set(DEFAULT_FORBIDDEN_WORDS).size).toBe(20);
    for (const word of DEFAULT_FORBIDDEN_WORDS) {
      expect(word.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("env 为空时只返回 baseline", () => {
    expect(resolveForbiddenWords(undefined)).toEqual([
      ...DEFAULT_FORBIDDEN_WORDS,
    ]);
    expect(resolveForbiddenWords("   ")).toEqual([...DEFAULT_FORBIDDEN_WORDS]);
  });

  it("中英文逗号与换行都认，trim 去空", () => {
    expect(parseForbiddenWordsOverride("人贩子, 脏话， 谣言\n拐卖")).toEqual([
      "人贩子",
      "脏话",
      "谣言",
      "拐卖",
    ]);
  });

  it("env 只追加、不替换 baseline，重复词去重", () => {
    const words = resolveForbiddenWords("人贩子, 血腥，脏话");
    expect(words.slice(0, DEFAULT_FORBIDDEN_WORDS.length)).toEqual([
      ...DEFAULT_FORBIDDEN_WORDS,
    ]);
    expect(words).toContain("人贩子");
    expect(words).toContain("脏话");
    expect(words.filter((word) => word === "血腥")).toHaveLength(1);
  });
});
