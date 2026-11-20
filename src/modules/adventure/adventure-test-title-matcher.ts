/**
 * 样机试播的标题匹配器（独立、纯函数、零依赖）。
 *
 * 刻意独立成文件且只在试播触发路径引入：这里的所有「模糊」与「译名转写」
 * 都是为测试环境识别 ASR 错位服务的，**绝不进入正常用户体验的意图路由 /
 * 每日门禁逻辑**。普通孩子照旧走精确的每日冒险链路，不受这里任何一层影响。
 *
 * 匹配从确定到模糊逐层放宽，且「模糊必确认、歧义绝不静默猜」：
 * 1. 归一化（剥首尾标点/空白、英文小写、IP 译名转写 艾丽→elly）；
 * 2. 精确/别名（归一化后全等）；
 * 3. 编辑距离（漏字/多字/个别同音字，得分达阈值才纳入）；
 * 4. 集号短口令（第N集 / N号 / N），确定性退路，也用于歧义消解。
 */

export interface AdventureTestTitleCandidate {
  /** 内部集 id（AdventureEpisode.id） */
  episodeId: string;
  /** 规范标题（已发布标题列或草稿 payload 标题） */
  title: string;
  /** 作者可选登记的别名（如「三个巨人」）；不参与 DB，由调用方传入 */
  aliases?: string[];
  episodeNumber?: number;
  season?: number;
  /** 命中草稿时为草稿版本 id，否则为当前发布版本 id 或 null */
  episodeVersionId?: string | null;
}

export type AdventureTestTitleMatchedBy = "exact" | "alias" | "fuzzy" | null;

export interface AdventureTestTitleMatch {
  matched: AdventureTestTitleCandidate | null;
  matchedBy: AdventureTestTitleMatchedBy;
  /** 0..1，供日志/看板观察识别质量 */
  score: number;
  /** true = 存在多个同样可信的候选，调用方必须让用户消歧，不得直接开播 */
  ambiguous: boolean;
  /** 按得分降序的候选（歧义时为 2..3 个，供确认交互列出） */
  candidates: AdventureTestTitleCandidate[];
}

/** IP 名译名转写：ASR 常把 Elly 识别成「艾丽/爱莉/伊莉」，把 Polly 识别成「波丽/宝莉」。 */
const IP_NAME_VARIANTS: ReadonlyArray<{
  canonical: string;
  variants: readonly string[];
}> = [
  {
    canonical: "elly",
    variants: ["艾丽丽", "艾丽", "爱丽", "艾利", "爱莉", "伊莉", "艾力", "eli"],
  },
  {
    canonical: "polly",
    variants: ["波丽丽", "波莉", "波丽", "波利", "宝莉", "poli"],
  },
];

const EDGE_PUNCTUATION = "。，、！？!?,;；:：.…·~～'\"“”‘’（）()《》<>";

/** 编辑距离低于此得分的候选直接丢弃（离得太远，不是这集）。 */
export const FUZZY_MIN_SCORE = 0.6;
/** 模糊命中要直接开播所需的最低得分；低于它宁可进歧义确认。 */
export const FUZZY_CONFIDENT_SCORE = 0.7;
/** 第一名与第二名得分差距低于此值即视为歧义。 */
export const AMBIGUITY_MARGIN = 0.25;

function stripEdgePunctuation(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && EDGE_PUNCTUATION.includes(value[start])) {
    start += 1;
  }
  while (end > start && EDGE_PUNCTUATION.includes(value[end - 1])) {
    end -= 1;
  }
  return value.slice(start, end);
}

/**
 * 标题归一化：trim + 英文小写 + IP 译名转写 + 剥首尾标点。
 * 只动首尾标点，句中标点（如「第1集：出发」的冒号）原样保留。
 */
export function normalizeTestTitle(text: string): string {
  let value = (text ?? "").trim().toLowerCase();
  for (const group of IP_NAME_VARIANTS) {
    for (const variant of group.variants) {
      value = value.split(variant).join(group.canonical);
    }
  }
  return stripEdgePunctuation(value);
}

/** 集号短口令：第N集 / 第N个 / N号 / N。只认阿拉伯数字，中文数字不猜。 */
export function parseTestEpisodeShortcut(text: string): number | null {
  const value = (text ?? "").trim();
  const prefixed = value.match(/^第\s*(\d+)\s*[集个]?$/);
  if (prefixed) {
    return Number(prefixed[1]);
  }
  const bare = value.match(/^(\d+)\s*号?$/);
  if (bare) {
    return Number(bare[1]);
  }
  return null;
}

/** 经典 Levenshtein 编辑距离。 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

interface ScoredCandidate {
  candidate: AdventureTestTitleCandidate;
  score: number;
  matchedBy: Exclude<AdventureTestTitleMatchedBy, null>;
}

function noMatch(
  ambiguous: boolean,
  candidates: AdventureTestTitleCandidate[] = [],
): AdventureTestTitleMatch {
  return { matched: null, matchedBy: null, score: 0, ambiguous, candidates };
}

/**
 * 把 ASR 提取出的原始标题匹配到候选集。
 *
 * 语义：
 * - 归一化后精确命中（含译名转写）或别名命中 → 直接返回；
 * - 多个精确命中（标题撞名）→ 歧义；
 * - 否则按编辑距离得分，唯一且够自信才返回，否则歧义；
 * - 一个都不够格 → 无匹配。
 */
export function matchTestTitle(
  rawTitle: string,
  candidates: AdventureTestTitleCandidate[],
): AdventureTestTitleMatch {
  const title = normalizeTestTitle(rawTitle);
  if (!title) {
    return noMatch(false);
  }

  const exact: ScoredCandidate[] = [];
  const fuzzy: ScoredCandidate[] = [];

  for (const candidate of candidates) {
    const canonical = normalizeTestTitle(candidate.title);
    const aliases = (candidate.aliases ?? []).map(normalizeTestTitle);
    const matchedBy: ScoredCandidate["matchedBy"] =
      canonical === title
        ? "exact"
        : aliases.includes(title)
          ? "alias"
          : "fuzzy";
    if (matchedBy === "exact" || matchedBy === "alias") {
      exact.push({ candidate, score: 1, matchedBy });
      continue;
    }
    const dist = editDistance(title, canonical);
    const maxLen = Math.max(title.length, canonical.length);
    const score = 1 - dist / maxLen;
    if (score >= FUZZY_MIN_SCORE) {
      fuzzy.push({ candidate, score, matchedBy: "fuzzy" });
    }
  }

  if (exact.length === 1) {
    return {
      matched: exact[0].candidate,
      matchedBy: exact[0].matchedBy,
      score: 1,
      ambiguous: false,
      candidates: [exact[0].candidate],
    };
  }
  if (exact.length > 1) {
    return {
      matched: null,
      matchedBy: null,
      score: 1,
      ambiguous: true,
      candidates: exact.map((e) => e.candidate),
    };
  }

  fuzzy.sort((a, b) => b.score - a.score);
  if (fuzzy.length === 0) {
    return noMatch(false);
  }
  const top = fuzzy[0];
  const second = fuzzy[1];
  const confident =
    top.score >= FUZZY_CONFIDENT_SCORE &&
    (!second || top.score - second.score >= AMBIGUITY_MARGIN);
  if (confident) {
    return {
      matched: top.candidate,
      matchedBy: top.matchedBy,
      score: top.score,
      ambiguous: false,
      candidates: [top.candidate],
    };
  }
  return {
    matched: null,
    matchedBy: null,
    score: top.score,
    ambiguous: true,
    candidates: fuzzy.slice(0, 3).map((f) => f.candidate),
  };
}
