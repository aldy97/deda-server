import { LintIssue } from "./adventure-linter";
import {
  ADVENTURE_INTERACTION_TYPES,
  AdventureInteractionType,
  businessKey,
  EpisodeContentDraft,
  EpisodeIdentity,
  EpisodeSegmentDraft,
  SegmentOptions,
  TwoChoiceOption,
} from "./adventure-content.types";

/**
 * 冒险内容静态走查。
 *
 * 目的：让内容创作者在发布前看到「孩子实际会听到什么、在哪里被要求开口」，
 * 以及这一集大概多长、发几颗星。
 *
 * 刻意**不**复制引擎状态机。引擎的五类处置、超时、跑题引回都是运行时行为，
 * 再实现一份必然漂移；走查只还原可见的播放节拍：recap + 旁白连播到交互点停下。
 * 与引擎一致的两条关键口径：
 * - `kind === "interaction"` 但 interactionType 缺失或不在白名单 → 当普通旁白播过去（引擎 `continue`）；
 * - 星光只在 `reward` 段与 `two_choice` 命中时发放；挂在 open_question / repeat_after_me 上的
 *   `rewardStar` 引擎根本读不到，所以走查也不计入，并单独报一条问题。
 */

/** 中文 TTS 的保守语速（字/秒），用于把字数折算成时长给创作者看。 */
export const TTS_CHARS_PER_SECOND = 4;

/** 真正会发放星光的交互原语；与 AdventureService 的发星分支保持一致。 */
const STAR_AWARDING_TYPES: AdventureInteractionType[] = [
  "reward",
  "two_choice",
];

export interface SimulationThresholds {
  /** 单集让孩子开口的次数上限；超过说明这一集太碎，一次坐不住 */
  maxAwaitPoints: number;
  /** 单集预计播报时长上限（秒） */
  maxSessionSeconds: number;
}

export const DEFAULT_SIMULATION_THRESHOLDS: SimulationThresholds = {
  maxAwaitPoints: 12,
  maxSessionSeconds: 900,
};

export interface SimulatedBeat {
  /** 这一拍连着播给孩子听的文本（含首拍的 recap） */
  says: string[];
  /** 这一拍停在哪个交互点上等回答；不等回答则为 null */
  stopsAtOrder: number | null;
  waitsForReply: boolean;
  interactionType: AdventureInteractionType | null;
  /**
   * 这一拍期间孩子拿到的星光。
   * reward 段算在播到它的那一拍；two_choice 算在孩子答完之后的下一拍（答对才发）。
   */
  starsAwarded: number;
  choices: TwoChoiceOption[] | null;
  praise: string | null;
  outcome: "await_reply" | "episode_complete";
}

export interface SimulationResult {
  businessKey: string;
  recap: string | null;
  beats: SimulatedBeat[];
  /** recap + 全部段文本 + 可预期的接话（two_choice 取选项均值、repeat_after_me 取 praise） */
  totalSpokenChars: number;
  estimatedSeconds: number;
  awaitsReplyCount: number;
  totalStars: number;
  problems: LintIssue[];
}

export function simulateEpisode(
  identity: EpisodeIdentity,
  content: EpisodeContentDraft,
  overrides: Partial<SimulationThresholds> = {},
): SimulationResult {
  const thresholds: SimulationThresholds = {
    ...DEFAULT_SIMULATION_THRESHOLDS,
    ...overrides,
  };
  const key = businessKey(identity);
  const problems: LintIssue[] = [];
  const report = (
    code: string,
    severity: "error" | "warning",
    message: string,
    segmentOrder?: number,
  ) =>
    problems.push({
      severity,
      code,
      message,
      businessKey: key,
      ...(segmentOrder === undefined ? {} : { segmentOrder }),
    });

  const recap =
    typeof content.recap === "string" && content.recap.trim()
      ? content.recap.trim()
      : null;
  const rawSegments = Array.isArray(content.segments) ? content.segments : [];
  const segments = [...rawSegments].sort(
    (a, b) => Number(a.order) - Number(b.order),
  );

  if (segments.length === 0) {
    report(
      "NO_SEGMENTS",
      "error",
      "这一集没有任何段落，走查没有可播内容；孩子打开后会立刻被判定为已完成。",
    );
    return {
      businessKey: key,
      recap,
      beats: [],
      totalSpokenChars: 0,
      estimatedSeconds: 0,
      awaitsReplyCount: 0,
      totalStars: 0,
      problems,
    };
  }

  const beats: SimulatedBeat[] = [];
  let says: string[] = recap ? [recap] : [];
  let spokenChars = recap ? recap.length : 0;
  let beatStars = 0;
  let totalStars = 0;
  let awaitsReplyCount = 0;

  for (const segment of segments) {
    const text = typeof segment.text === "string" ? segment.text : "";
    says.push(text);
    spokenChars += text.length;

    if (segment.kind !== "interaction") {
      continue;
    }

    const type = ADVENTURE_INTERACTION_TYPES.includes(
      segment.interactionType as (typeof ADVENTURE_INTERACTION_TYPES)[number],
    )
      ? (segment.interactionType as AdventureInteractionType)
      : null;

    if (!type) {
      report(
        "INTERACTION_WITHOUT_TYPE",
        "warning",
        `第 ${segment.order} 段标成了交互点，却没有可用的 interactionType，引擎会把它当旁白播过去，孩子不会被邀请开口。`,
        segment.order,
      );
      continue;
    }
    if (type === "reward") {
      if (segment.rewardStar) {
        beatStars += 1;
        totalStars += 1;
      }
      continue;
    }

    let choices: TwoChoiceOption[] | null = null;
    let praise: string | null = null;

    if (type === "two_choice") {
      choices = readChoices(segment);
      const replies = choices.map((choice) => choice.reply.length);
      if (replies.length > 0) {
        spokenChars += Math.round(
          replies.reduce((sum, length) => sum + length, 0) / replies.length,
        );
      }
      if (segment.rewardStar) {
        totalStars += 1;
      }
    } else {
      if (type === "repeat_after_me") {
        praise = readPraise(segment);
        if (praise) {
          spokenChars += praise.length;
        }
      }
      if (segment.rewardStar) {
        report(
          "STAR_ON_NON_AWARDING_INTERACTION",
          "warning",
          `第 ${segment.order} 段勾选了发星光，但 ${type} 类型的交互点引擎不会发星（只有 reward 段与 two_choice 答对时才发）。这颗星永远到不了孩子手上，请改成 reward 段或去掉勾选。`,
          segment.order,
        );
      }
    }

    beats.push({
      says,
      stopsAtOrder: segment.order,
      waitsForReply: true,
      interactionType: type,
      // two_choice 的星在孩子答完之后才落袋，记在下一拍
      starsAwarded: beatStars,
      choices,
      praise,
      outcome: "await_reply",
    });
    beatStars = type === "two_choice" && segment.rewardStar ? 1 : 0;
    says = [];
    awaitsReplyCount += 1;
  }

  const endsOnInteraction = says.length === 0 && beats.length > 0;
  beats.push({
    says,
    stopsAtOrder: null,
    waitsForReply: false,
    interactionType: null,
    starsAwarded: beatStars,
    choices: null,
    praise: null,
    outcome: "episode_complete",
  });

  if (endsOnInteraction) {
    report(
      "EPISODE_ENDS_ON_INTERACTION",
      "warning",
      "这一集停在一个问题上就结束了：孩子答完直接完集，没有收尾旁白，体感像被掐断。建议在最后补一段旁白。",
    );
  }
  if (awaitsReplyCount === 0) {
    report(
      "NO_AWAIT_POINTS",
      "warning",
      "这一集从头到尾没有邀请孩子开口，等于一段单向播放，起不到互动作用。",
    );
  }
  if (awaitsReplyCount > thresholds.maxAwaitPoints) {
    report(
      "TOO_MANY_AWAIT_POINTS",
      "warning",
      `这一集要孩子开口 ${awaitsReplyCount} 次，超过建议上限 ${thresholds.maxAwaitPoints} 次；每次开口都有一次 ASR 失败的风险，太碎会让孩子卡住。`,
    );
  }
  if (totalStars === 0) {
    report(
      "STAR_NEVER_AWARDED",
      "warning",
      "这一集不会发出任何星光，孩子拿不到正反馈。",
    );
  }

  const estimatedSeconds = Math.round(spokenChars / TTS_CHARS_PER_SECOND);
  if (estimatedSeconds > thresholds.maxSessionSeconds) {
    report(
      "SESSION_TOO_LONG",
      "warning",
      `这一集预计播报约 ${Math.round(
        estimatedSeconds / 60,
      )} 分钟，超过建议上限 ${Math.round(
        thresholds.maxSessionSeconds / 60,
      )} 分钟，孩子很难一次听完。`,
    );
  }

  return {
    businessKey: key,
    recap,
    beats,
    totalSpokenChars: spokenChars,
    estimatedSeconds,
    awaitsReplyCount,
    totalStars,
    problems,
  };
}

function readChoices(segment: EpisodeSegmentDraft): TwoChoiceOption[] {
  const options = segment.options as SegmentOptions | null | undefined;
  if (!options || !Array.isArray(options.choices)) {
    return [];
  }
  return options.choices
    .filter((choice) => !!choice && typeof choice === "object")
    .map((choice) => ({
      key: typeof choice.key === "string" ? choice.key : "",
      text: typeof choice.text === "string" ? choice.text : "",
      reply: typeof choice.reply === "string" ? choice.reply : "",
    }));
}

function readPraise(segment: EpisodeSegmentDraft): string | null {
  const options = segment.options as SegmentOptions | null | undefined;
  const praise = options?.praise;
  return typeof praise === "string" && praise.trim() ? praise : null;
}

/** 供调用方判断某类型是否真的会发星（与引擎分支一致）。 */
export function awardsStar(type: AdventureInteractionType | null): boolean {
  return !!type && STAR_AWARDING_TYPES.includes(type);
}
