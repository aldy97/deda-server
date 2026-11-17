import {
  ADVENTURE_CHARACTER_KEYS,
  ADVENTURE_INTERACTION_TYPES,
  ADVENTURE_SEASON,
  businessKey,
  EpisodeContentDraft,
  EpisodeIdentity,
  EpisodeSegmentDraft,
  REPLY_WAITING_INTERACTION_TYPES,
  SegmentOptions,
  TwoChoiceOption,
} from "./adventure-content.types";

/**
 * 冒险内容发布闸口。
 *
 * 每一条 error 都对应一个「上线后孩子会遇到什么」的真实故障，而不是风格偏好：
 * - order 不连续 → 引擎 `order >= segments.length` 会提前判完集，孩子听到半截就被记完成；
 * - 二选一 key/text 过短或互为子串 → 引擎用 `asrText.includes(...)` 匹配，会静默走错分支；
 * - 交互点缺兜底/退出话术 → 孩子沉默或跑题时只能落回硬编码的通用句，人设崩塌；
 * - 发布顺序断档 → 引擎在未发布集处硬停播，后面所有已发布集全部播不到。
 *
 * warning 是可发布的质量提示（时长、星光密度、开场节奏），不阻断。
 * 禁用词是 error：儿童内容安全不留「先发了再说」的余地。
 */

export type LintSeverity = "error" | "warning";

export interface LintIssue {
  severity: LintSeverity;
  /** 机器可读，前端按 code 定位表单字段与做文案映射 */
  code: string;
  /** 中文，直接展示给内容创作者 */
  message: string;
  businessKey: string;
  segmentOrder?: number;
  /** 段内字段路径，如 segments[2].options.choices[0].text */
  path?: string;
}

export interface LintReport {
  /** 无 error 即可发布；warning 不影响 ok */
  ok: boolean;
  issues: LintIssue[];
  errors: LintIssue[];
  warnings: LintIssue[];
}

export interface LintThresholds {
  /** 交互点引导词字数上限（孩子要听完再作答，过长会走神） */
  maxInteractionTextChars: number;
  /** 单段旁白字数上限（TTS 一口气播完的长度） */
  maxNarrationTextChars: number;
  /** 集标题字数上限（家长端与看板列表展示） */
  maxTitleChars: number;
  /** 单集星光上限（防止「每段都发星」稀释激励） */
  maxStarsPerEpisode: number;
  /** 二选一 key 最小长度：引擎用 includes 匹配，单字符几乎必误命中 */
  minChoiceKeyChars: number;
  /** 二选一 text 最小长度：同上 */
  minChoiceTextChars: number;
  /** 禁用词，命中即阻断；默认空，由 config/env 注入 */
  forbiddenWords: string[];
}

export const DEFAULT_LINT_THRESHOLDS: LintThresholds = {
  maxInteractionTextChars: 60,
  maxNarrationTextChars: 120,
  maxTitleChars: 40,
  maxStarsPerEpisode: 5,
  minChoiceKeyChars: 2,
  minChoiceTextChars: 2,
  forbiddenWords: [],
};

export interface LintContext {
  /** 同 characterKey/season 下已占用的业务键 */
  takenBusinessKeys?: string[];
  /** 正在编辑的这一集自身的业务键；用于「改自己不算重名」 */
  ownBusinessKey?: string;
  /** 同 characterKey/season 下已发布的集号 */
  publishedEpisodeNumbers?: number[];
  /** 是否按发布标准校验（草稿保存时发布顺序断档不阻断） */
  forPublish?: boolean;
}

const SEGMENT_KINDS = ["narration", "interaction"];

export function lintEpisode(
  identity: EpisodeIdentity,
  content: EpisodeContentDraft,
  context: LintContext = {},
  overrides: Partial<LintThresholds> = {},
): LintReport {
  const thresholds: LintThresholds = {
    ...DEFAULT_LINT_THRESHOLDS,
    ...overrides,
  };
  const key = businessKey(identity);
  const issues: LintIssue[] = [];

  const error = (
    code: string,
    message: string,
    detail: { segmentOrder?: number; path?: string } = {},
  ) =>
    issues.push({
      severity: "error",
      code,
      message,
      businessKey: key,
      ...detail,
    });
  const warn = (
    code: string,
    message: string,
    detail: { segmentOrder?: number; path?: string } = {},
  ) =>
    issues.push({
      severity: "warning",
      code,
      message,
      businessKey: key,
      ...detail,
    });

  lintIdentity(identity, key, context, error);
  lintTitleAndRecap(content, thresholds, error, warn);

  const segments = Array.isArray(content.segments) ? content.segments : [];
  if (segments.length === 0) {
    error(
      "NO_SEGMENTS",
      "这一集没有任何段落，孩子打开后会立刻被判定为已完成。",
    );
  } else {
    lintSegmentOrder(segments, error);
    segments.forEach((segment, index) =>
      lintSegment(segment, index, segments, thresholds, error, warn),
    );
    lintEpisodeShape(segments, thresholds, warn);
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return { ok: errors.length === 0, issues, errors, warnings };
}

function lintIdentity(
  identity: EpisodeIdentity,
  key: string,
  context: LintContext,
  error: (code: string, message: string) => void,
) {
  if (identity.season !== ADVENTURE_SEASON) {
    error(
      "SEASON_UNSUPPORTED",
      `当前只支持 season=${ADVENTURE_SEASON}，收到 ${identity.season}；跨季选集与进度语义尚未实现。`,
    );
  }
  if (
    !ADVENTURE_CHARACTER_KEYS.includes(
      identity.characterKey as (typeof ADVENTURE_CHARACTER_KEYS)[number],
    )
  ) {
    error(
      "UNKNOWN_CHARACTER_KEY",
      `characterKey 必须是 ${ADVENTURE_CHARACTER_KEYS.join(" / ")}，收到 "${identity.characterKey}"。`,
    );
  }
  if (!Number.isInteger(identity.episodeNumber) || identity.episodeNumber < 1) {
    error(
      "INVALID_EPISODE_NUMBER",
      `集号必须是不小于 1 的整数，收到 ${identity.episodeNumber}。`,
    );
  }

  const own = context.ownBusinessKey;
  const taken = (context.takenBusinessKeys ?? []).filter(
    (item) => item !== own && item === key,
  );
  if (taken.length > 0) {
    error(
      "BUSINESS_KEY_TAKEN",
      `业务键 ${key} 已被另一集占用；同 IP 同季同集号必须唯一。`,
    );
  }

  if (context.forPublish && Number.isInteger(identity.episodeNumber)) {
    const published = new Set(context.publishedEpisodeNumbers ?? []);
    const missing: number[] = [];
    for (let n = 1; n < identity.episodeNumber; n++) {
      if (!published.has(n)) {
        missing.push(n);
      }
    }
    if (missing.length > 0) {
      error(
        "PREDECESSOR_NOT_PUBLISHED",
        `第 ${identity.episodeNumber} 集不能先发布：第 ${missing.join(
          "、",
        )} 集仍未发布。引擎在未发布集处硬停播，先发布后面的集等于让孩子什么都听不到。`,
      );
    }
  }
}

function lintTitleAndRecap(
  content: EpisodeContentDraft,
  thresholds: LintThresholds,
  error: (code: string, message: string) => void,
  warn: (code: string, message: string) => void,
) {
  const title = typeof content.title === "string" ? content.title.trim() : "";
  if (!title) {
    error("TITLE_REQUIRED", "集标题不能为空；家长端与看板都靠它识别这一集。");
  } else if (title.length > thresholds.maxTitleChars) {
    warn(
      "TITLE_TOO_LONG",
      `集标题 ${title.length} 字，超过建议上限 ${thresholds.maxTitleChars} 字，列表里会被截断。`,
    );
  }

  const recap = typeof content.recap === "string" ? content.recap.trim() : "";
  if (!recap) {
    warn(
      "RECAP_EMPTY",
      "没有前情回顾。孩子隔天回来时会缺少上下文，第 1 集可以留空，后续集建议补上。",
    );
  }
}

function lintSegmentOrder(
  segments: EpisodeSegmentDraft[],
  error: (
    code: string,
    message: string,
    detail?: { segmentOrder?: number; path?: string },
  ) => void,
) {
  const seen = new Set<number>();
  for (const segment of segments) {
    const order = Number(segment.order);
    if (!Number.isInteger(order) || order < 0) {
      error(
        "SEGMENT_ORDER_INVALID",
        `段落 order 必须是不小于 0 的整数，收到 ${String(segment.order)}。`,
        { segmentOrder: order },
      );
      continue;
    }
    if (seen.has(order)) {
      error(
        "SEGMENT_ORDER_DUPLICATE",
        `第 ${order} 段 order 重复；引擎按 order 定位交互点，重复会让其中一段永远播不到。`,
        { segmentOrder: order },
      );
    }
    seen.add(order);
  }

  for (let expected = 0; expected < segments.length; expected++) {
    if (!seen.has(expected)) {
      error(
        "SEGMENT_ORDER_GAP",
        `段落 order 必须从 0 连续递增到 ${
          segments.length - 1
        }，缺少 ${expected}。引擎用「order >= 段数」判定完集，断号会让孩子提前被记为已完成。`,
        { segmentOrder: expected },
      );
      break;
    }
  }
}

function lintSegment(
  segment: EpisodeSegmentDraft,
  index: number,
  segments: EpisodeSegmentDraft[],
  thresholds: LintThresholds,
  error: (
    code: string,
    message: string,
    detail?: { segmentOrder?: number; path?: string },
  ) => void,
  warn: (
    code: string,
    message: string,
    detail?: { segmentOrder?: number; path?: string },
  ) => void,
) {
  const order = Number(segment.order);
  const at = (field: string) => ({
    segmentOrder: order,
    path: `segments[${index}].${field}`,
  });

  if (!SEGMENT_KINDS.includes(segment.kind)) {
    error(
      "UNKNOWN_SEGMENT_KIND",
      `第 ${order} 段 kind 必须是 narration 或 interaction，收到 "${String(
        segment.kind,
      )}"。`,
      at("kind"),
    );
  }

  const text = typeof segment.text === "string" ? segment.text.trim() : "";
  if (!text) {
    error(
      "SEGMENT_TEXT_REQUIRED",
      `第 ${order} 段文本不能为空；空段会让孩子听到一段沉默。`,
      at("text"),
    );
  }

  if (segment.kind === "narration") {
    if (segment.interactionType) {
      warn(
        "NARRATION_WITH_INTERACTION_TYPE",
        `第 ${order} 段是旁白却带了 interactionType "${String(
          segment.interactionType,
        )}"，引擎会忽略它。若想让孩子作答请把 kind 改成 interaction。`,
        at("interactionType"),
      );
    }
    if (text.length > thresholds.maxNarrationTextChars) {
      warn(
        "NARRATION_TEXT_LONG",
        `第 ${order} 段旁白 ${text.length} 字，超过建议上限 ${thresholds.maxNarrationTextChars} 字，孩子容易走神。`,
        at("text"),
      );
    }
    lintForbiddenWords(text, thresholds, order, index, error);
    return;
  }

  if (segment.kind !== "interaction") {
    return;
  }

  if (text.length > thresholds.maxInteractionTextChars) {
    warn(
      "INTERACTION_TEXT_LONG",
      `第 ${order} 段引导词 ${text.length} 字，超过建议上限 ${thresholds.maxInteractionTextChars} 字，孩子听完就忘了要回答什么。`,
      at("text"),
    );
  }
  lintForbiddenWords(text, thresholds, order, index, error);

  const type = segment.interactionType;
  if (!type) {
    error(
      "INTERACTION_TYPE_REQUIRED",
      `第 ${order} 段是交互点却没有 interactionType，引擎会当成普通段落直接跳过。`,
      at("interactionType"),
    );
    return;
  }
  if (
    !ADVENTURE_INTERACTION_TYPES.includes(
      type as (typeof ADVENTURE_INTERACTION_TYPES)[number],
    )
  ) {
    error(
      "UNKNOWN_INTERACTION_TYPE",
      `第 ${order} 段 interactionType "${String(
        type,
      )}" 不在白名单内（${ADVENTURE_INTERACTION_TYPES.join(" / ")}）。`,
      at("interactionType"),
    );
    return;
  }

  lintForbiddenWords(
    segment.fallbackText ?? "",
    thresholds,
    order,
    index,
    error,
  );
  lintForbiddenWords(segment.exitText ?? "", thresholds, order, index, error);

  if (type === "two_choice") {
    lintTwoChoice(segment, index, thresholds, error);
  }
  if (type === "repeat_after_me") {
    const praise = (segment.options as SegmentOptions | null)?.praise;
    if (typeof praise !== "string" || !praise.trim()) {
      error(
        "PRAISE_REQUIRED",
        `第 ${order} 段是跟读交互点，必须填 options.praise 作为孩子开口后的鼓励语。`,
        at("options.praise"),
      );
    } else {
      lintForbiddenWords(praise, thresholds, order, index, error);
    }
  }
  if (type === "reward" && !segment.rewardStar) {
    warn(
      "REWARD_WITHOUT_STAR",
      `第 ${order} 段是 reward 交互点却没有勾选发星光，这一段对孩子没有任何反馈。`,
      at("rewardStar"),
    );
  }

  if (!REPLY_WAITING_INTERACTION_TYPES.includes(type)) {
    return;
  }
  if (
    typeof segment.fallbackText !== "string" ||
    !segment.fallbackText.trim()
  ) {
    error(
      "FALLBACK_TEXT_REQUIRED",
      `第 ${order} 段等孩子作答，必须填兜底话术：孩子跑题或沉默时只能靠它继续，缺失会退回硬编码通用句、丢掉人设。`,
      at("fallbackText"),
    );
  }
  if (typeof segment.exitText !== "string" || !segment.exitText.trim()) {
    error(
      "EXIT_TEXT_REQUIRED",
      `第 ${order} 段等孩子作答，必须填退出话术：孩子说「不想玩了」时要温柔收尾。`,
      at("exitText"),
    );
  }

  if (index === segments.length - 1) {
    warn(
      "EPISODE_ENDS_AWAITING_REPLY",
      `第 ${order} 段是这一集的最后一段，且需要孩子作答。孩子答完就直接完集，没有收尾旁白。`,
      at("text"),
    );
  }
}

function lintTwoChoice(
  segment: EpisodeSegmentDraft,
  index: number,
  thresholds: LintThresholds,
  error: (
    code: string,
    message: string,
    detail?: { segmentOrder?: number; path?: string },
  ) => void,
) {
  const order = Number(segment.order);
  const at = (field: string) => ({
    segmentOrder: order,
    path: `segments[${index}].${field}`,
  });
  const options = segment.options as SegmentOptions | null | undefined;
  const choices = options?.choices;

  if (!Array.isArray(choices) || choices.length < 2) {
    error(
      "CHOICES_REQUIRED",
      `第 ${order} 段是二选一交互点，必须给出至少 2 个选项，收到 ${
        Array.isArray(choices) ? choices.length : 0
      } 个。`,
      at("options.choices"),
    );
    return;
  }

  const seenKeys = new Set<string>();
  const seenTexts = new Set<string>();
  choices.forEach((choice, choiceIndex) => {
    const path = `options.choices[${choiceIndex}]`;
    const item = (choice ?? {}) as Partial<TwoChoiceOption>;
    const choiceKey = typeof item.key === "string" ? item.key : "";
    const choiceText = typeof item.text === "string" ? item.text : "";
    const reply = typeof item.reply === "string" ? item.reply.trim() : "";

    const trimmedKey = choiceKey.trim();
    if (
      !trimmedKey ||
      trimmedKey.length < thresholds.minChoiceKeyChars ||
      /\s/.test(trimmedKey)
    ) {
      error(
        "CHOICE_KEY_INVALID",
        `第 ${order} 段第 ${choiceIndex + 1} 个选项的 key "${choiceKey}" 不合法：不能为空、至少 ${
          thresholds.minChoiceKeyChars
        } 个字符、且不能含空格。引擎用「孩子说的话里是否包含 key」来匹配，单字符或带空格的 key 要么必误命中、要么永远匹配不上。`,
        at(`${path}.key`),
      );
    }
    const trimmedText = choiceText.trim();
    if (!trimmedText || trimmedText.length < thresholds.minChoiceTextChars) {
      error(
        "CHOICE_TEXT_INVALID",
        `第 ${order} 段第 ${choiceIndex + 1} 个选项的展示文案 "${choiceText}" 不合法：至少 ${thresholds.minChoiceTextChars} 个字符。匹配同样走 includes，过短会误命中。`,
        at(`${path}.text`),
      );
    }
    if (!reply) {
      error(
        "CHOICE_REPLY_REQUIRED",
        `第 ${order} 段第 ${choiceIndex + 1} 个选项缺少 reply：孩子选中后要播的接话句是预生成的，不能为空。`,
        at(`${path}.reply`),
      );
    }

    if (trimmedKey) {
      if (seenKeys.has(trimmedKey)) {
        error(
          "CHOICE_KEY_DUPLICATE",
          `第 ${order} 段选项 key "${trimmedKey}" 重复，引擎只会命中前一个。`,
          at(`${path}.key`),
        );
      }
      seenKeys.add(trimmedKey);
    }
    if (trimmedText) {
      if (seenTexts.has(trimmedText)) {
        error(
          "CHOICE_TEXT_DUPLICATE",
          `第 ${order} 段选项文案 "${trimmedText}" 重复，孩子无从区分。`,
          at(`${path}.text`),
        );
      }
      seenTexts.add(trimmedText);
    }
  });

  // 子串陷阱：引擎是 choices.find(includes)，短文案排在前面时会抢走长文案的命中。
  choices.forEach((choice, i) => {
    const a = (choice ?? {}) as Partial<TwoChoiceOption>;
    const aText = typeof a.text === "string" ? a.text.trim() : "";
    const aKey = typeof a.key === "string" ? a.key.trim() : "";
    if (!aText) {
      return;
    }
    choices.forEach((other, j) => {
      if (i === j) {
        return;
      }
      const b = (other ?? {}) as Partial<TwoChoiceOption>;
      const bText = typeof b.text === "string" ? b.text.trim() : "";
      const bKey = typeof b.key === "string" ? b.key.trim() : "";
      const textSwallowed =
        bText.length > aText.length && bText.includes(aText);
      const keySwallowed =
        !!bKey && bKey.length > aKey.length && bKey.includes(aKey);
      if (textSwallowed || keySwallowed) {
        error(
          "CHOICE_TEXT_SUBSTRING",
          `第 ${order} 段选项 ${i + 1}（"${aText}"）是选项 ${
            j + 1
          }（"${bText}"）的子串。引擎按顺序做 includes 匹配，孩子说长的那个时会被短选项抢走、静默走错分支。`,
          at(`options.choices[${i}].text`),
        );
      }
    });
  });
}

function lintForbiddenWords(
  text: string,
  thresholds: LintThresholds,
  order: number,
  index: number,
  error: (
    code: string,
    message: string,
    detail?: { segmentOrder?: number; path?: string },
  ) => void,
) {
  if (!text || thresholds.forbiddenWords.length === 0) {
    return;
  }
  const hits = thresholds.forbiddenWords.filter((word) => text.includes(word));
  if (hits.length === 0) {
    return;
  }
  error(
    "FORBIDDEN_WORD",
    `第 ${order} 段含禁用词：${hits.join("、")}。儿童内容不得出现，请改写后再发布。`,
    { segmentOrder: order, path: `segments[${index}].text` },
  );
}

function lintEpisodeShape(
  segments: EpisodeSegmentDraft[],
  thresholds: LintThresholds,
  warn: (
    code: string,
    message: string,
    detail?: { segmentOrder?: number; path?: string },
  ) => void,
) {
  const sorted = [...segments].sort(
    (a, b) => Number(a.order) - Number(b.order),
  );
  const first = sorted[0];
  if (first && first.kind === "interaction") {
    warn(
      "FIRST_SEGMENT_INTERACTION",
      "这一集一开口就向孩子提问，没有任何铺垫。建议前面加一段旁白交代情境。",
      { segmentOrder: Number(first.order), path: `segments[0].kind` },
    );
  }

  const stars = segments.filter((segment) => segment.rewardStar).length;
  if (stars > thresholds.maxStarsPerEpisode) {
    warn(
      "TOO_MANY_STARS",
      `这一集发出 ${stars} 颗星光，超过建议上限 ${thresholds.maxStarsPerEpisode} 颗，星光会变得不值钱。`,
    );
  }
}
