import {
  AdventureTestTitleCandidate,
  matchTestTitle,
  normalizeTestTitle,
  parseTestEpisodeShortcut,
} from "./adventure-test-title-matcher";

/**
 * 样机试播标题匹配器单测（TDD 先行）。
 *
 * 覆盖四类 ASR 错位：句末标点 / IP 译名（Elly↔艾丽）/ 漏字多字个别错字 /
 * 集号短口令，以及「歧义绝不静默猜」的安全语义。
 */
describe("normalizeTestTitle", () => {
  it("strips trailing punctuation and whitespace", () => {
    expect(normalizeTestTitle("Elly与三个巨人。")).toBe("elly与三个巨人");
    expect(normalizeTestTitle("  Elly与三个巨人！ ")).toBe("elly与三个巨人");
    expect(normalizeTestTitle("Elly与三个巨人…")).toBe("elly与三个巨人");
  });

  it("strips leading punctuation after the trigger prefix", () => {
    expect(normalizeTestTitle("，Elly与三个巨人")).toBe("elly与三个巨人");
  });

  it("lower-cases latin letters", () => {
    expect(normalizeTestTitle("Elly与三个巨人")).toBe("elly与三个巨人");
  });

  it("translates IP name variants to their canonical latin form", () => {
    expect(normalizeTestTitle("艾丽与三个巨人")).toBe("elly与三个巨人");
    expect(normalizeTestTitle("爱莉与三个巨人")).toBe("elly与三个巨人");
    expect(normalizeTestTitle("伊莉与三个巨人")).toBe("elly与三个巨人");
    expect(normalizeTestTitle("波丽与三个巨人")).toBe("polly与三个巨人");
  });

  it("keeps internal punctuation intact", () => {
    expect(normalizeTestTitle("第1集：出发")).toBe("第1集：出发");
  });

  it("normalizes an empty or punctuation-only title to an empty string", () => {
    expect(normalizeTestTitle("")).toBe("");
    expect(normalizeTestTitle("。")).toBe("");
  });
});

describe("parseTestEpisodeShortcut", () => {
  it.each([
    ["第3集", 3],
    ["第3个", 3],
    ["第 10 集", 10],
    ["3号", 3],
    ["3", 3],
    ["12", 12],
  ])("%s → 第 %i 集", (text, expected) => {
    expect(parseTestEpisodeShortcut(text)).toBe(expected);
  });

  it.each(["第三集", "三", "不是集号", "第集", ""])(
    "%s → null（只认阿拉伯数字）",
    (text) => {
      expect(parseTestEpisodeShortcut(text)).toBeNull();
    },
  );
});

describe("matchTestTitle", () => {
  const elly = (overrides: Partial<AdventureTestTitleCandidate> = {}) => ({
    episodeId: "ep1",
    title: "Elly与三个巨人",
    episodeNumber: 3,
    season: 1,
    episodeVersionId: "v1",
    ...overrides,
  });
  const polly = (overrides: Partial<AdventureTestTitleCandidate> = {}) => ({
    episodeId: "ep2",
    title: "Polly与三只小马",
    episodeNumber: 4,
    season: 1,
    episodeVersionId: "v2",
    ...overrides,
  });

  it("matches the exact title after normalization", () => {
    const result = matchTestTitle("Elly与三个巨人。", [elly(), polly()]);
    expect(result.matched?.episodeId).toBe("ep1");
    expect(result.matchedBy).toBe("exact");
    expect(result.score).toBe(1);
    expect(result.ambiguous).toBe(false);
  });

  it("matches an IP transliteration as exact", () => {
    const result = matchTestTitle("艾丽与三个巨人", [elly(), polly()]);
    expect(result.matched?.episodeId).toBe("ep1");
    expect(result.matchedBy).toBe("exact");
  });

  it("matches an author-registered alias", () => {
    const result = matchTestTitle("三个巨人", [
      elly({ aliases: ["三个巨人"] }),
      polly(),
    ]);
    expect(result.matched?.episodeId).toBe("ep1");
    expect(result.matchedBy).toBe("alias");
  });

  it("matches a single-char ASR slip via edit distance", () => {
    const result = matchTestTitle("艾丽与三歌巨人", [elly(), polly()]);
    expect(result.matched?.episodeId).toBe("ep1");
    expect(result.matchedBy).toBe("fuzzy");
    expect(result.ambiguous).toBe(false);
  });

  it("matches a dropped character via edit distance", () => {
    const result = matchTestTitle("艾丽与三巨人", [elly(), polly()]);
    expect(result.matched?.episodeId).toBe("ep1");
    expect(result.matchedBy).toBe("fuzzy");
  });

  it("does not match a title that is too far off", () => {
    const result = matchTestTitle("完全不一样的故事", [elly(), polly()]);
    expect(result.matched).toBeNull();
  });

  it("flags two equally-plausible fuzzy candidates as ambiguous", () => {
    const a = elly({ episodeId: "ep1", title: "三个巨人" });
    const b = polly({ episodeId: "ep2", title: "三只巨人" });
    const result = matchTestTitle("三棵巨人", [a, b]);
    expect(result.matched).toBeNull();
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toHaveLength(2);
  });

  it("flags duplicate exact titles as ambiguous", () => {
    const result = matchTestTitle("Elly与三个巨人", [
      elly(),
      elly({ episodeId: "ep9" }),
    ]);
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toHaveLength(2);
  });

  it("prefers an exact hit over a nearby fuzzy candidate", () => {
    const exact = elly({ episodeId: "ep1", title: "三个巨人" });
    const near = polly({ episodeId: "ep2", title: "三只巨人" });
    const result = matchTestTitle("三个巨人", [exact, near]);
    expect(result.matched?.episodeId).toBe("ep1");
    expect(result.matchedBy).toBe("exact");
    expect(result.ambiguous).toBe(false);
  });

  it("returns an empty candidate list with no input", () => {
    const result = matchTestTitle("", [elly(), polly()]);
    expect(result.matched).toBeNull();
    expect(result.ambiguous).toBe(false);
  });
});
