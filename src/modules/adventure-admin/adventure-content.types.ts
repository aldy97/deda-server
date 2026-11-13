/**
 * 冒险内容域的唯一真相形状。
 *
 * 刻意与 Prisma 行类型解耦：admin 编辑的是「草稿内容」，引擎播放的是「版本快照 payload」，
 * 导入导出搬运的是「bundle」，三者共用这一套结构，只有外壳（id / 时间戳 / 发布态）不同。
 * 外壳字段一律不进内容哈希，否则同样的内容在不同环境会算出不同的 hash。
 */

/** 本期只做 season=1；跨季需要另做选集与进度语义，不在当前范围。 */
export const ADVENTURE_SEASON = 1;

export const ADVENTURE_CHARACTER_KEYS = ["elly", "polly"] as const;
export type AdventureCharacterKey = (typeof ADVENTURE_CHARACTER_KEYS)[number];

/**
 * 四种交互原语。引擎按 interactionType 分支处理，options 是多态的：
 * two_choice 用 choices，repeat_after_me 用 praise，reward 只看 rewardStar。
 */
export const ADVENTURE_INTERACTION_TYPES = [
  "open_question",
  "two_choice",
  "repeat_after_me",
  "reward",
] as const;
export type AdventureInteractionType =
  (typeof ADVENTURE_INTERACTION_TYPES)[number];

/** 需要孩子开口作答、因而必须有兜底与退出话术的原语。reward 不等回答，不在此列。 */
export const REPLY_WAITING_INTERACTION_TYPES: AdventureInteractionType[] = [
  "open_question",
  "two_choice",
  "repeat_after_me",
];

export interface TwoChoiceOption {
  key: string;
  text: string;
  reply: string;
}

/**
 * 段落选项。字段按 interactionType 取用，未用到的键必须留空而不是塞进别的语义——
 * 引擎是鸭子类型读取（options?.choices / options?.praise），塞错键会静默走兜底。
 */
export interface SegmentOptions {
  choices?: TwoChoiceOption[];
  praise?: string;
}

export interface EpisodeSegmentDraft {
  /** 集内顺序，必须严格 0..n-1 连续；引擎用 order >= segments.length 判完集。 */
  order: number;
  kind: "narration" | "interaction";
  text: string;
  interactionType?: AdventureInteractionType | null;
  options?: SegmentOptions | null;
  fallbackText?: string | null;
  exitText?: string | null;
  rewardStar?: boolean;
}

export interface EpisodeContentDraft {
  title: string;
  recap?: string | null;
  segments: EpisodeSegmentDraft[];
}

export interface EpisodeIdentity {
  characterKey: AdventureCharacterKey;
  season: number;
  episodeNumber: number;
}

/** 业务键：人可读、可手输确认，也是破坏性操作 confirmText 的比对目标。 */
export function businessKey(identity: EpisodeIdentity): string {
  return `${identity.characterKey}/${identity.season}/${identity.episodeNumber}`;
}

/** 引擎播放时真正读取的最小段落形状（与 AdventureService 的 PlayableSegment 同构）。 */
export type PlayableSegmentDraft = EpisodeSegmentDraft;
