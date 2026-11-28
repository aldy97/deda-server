/**
 * 60 秒预告的分镜契约。
 *
 * 这是唯一中间产物：导演模型产出它，配音/画面/合成三个阶段都只读它。
 * 三条硬约束（由 validator 执行）：
 * 1. text 必须是发布快照里原文的连续子串——预告可以少讲，不能改写；
 * 2. 最多一处角色台词，其余全部旁白；
 * 3. 总字数 ≤180，切成 1–2 段、每段 ≤30 秒。
 */

export type VideoSpeaker = "narrator" | "elly" | "polly";

export type VideoEmotion = "calm" | "curious" | "excited" | "gentle" | "tense";

export interface StoryboardBeat {
  order: number;
  /** 原文 segments 下标，允许连续多段拼成一句 */
  sourceSegmentOrders: number[];
  speaker: VideoSpeaker;
  /** 原文连续子串，逐字一致 */
  text: string;
  emotion: VideoEmotion;
  /** 画面里出现的角色，只能是两个 IP */
  characters: Array<"elly" | "polly">;
  /** 景别/运镜/动作的一句话，给视频 prompt 用 */
  shot: string;
  /** 该 beat 的画面描述（中文） */
  visualPrompt: string;
  /** 超时长时优先丢弃的段落；最多 2 段 */
  optional: boolean;
}

export interface StoryboardClip {
  order: number;
  /** beat.order 列表，按顺序铺进这一段的 30 秒里 */
  beats: number[];
}

export interface Storyboard {
  version: 1;
  title: string;
  businessKey: string;
  episodeVersionId: string;
  contentHash: string;
  aspect: string;
  resolution: string;
  /** 全局画风，拼进每个 clip 的 prompt，保证两段是同一部片 */
  stylePrompt: string;
  totalTextChars: number;
  beats: StoryboardBeat[];
  clips: StoryboardClip[];
}

export interface StoryboardSegmentSource {
  kind?: string;
  text?: string;
}

export interface StoryboardPayload {
  title?: string;
  recap?: string | null;
  segments?: StoryboardSegmentSource[];
}

export const STORYBOARD_MAX_CHARS = 180;
export const STORYBOARD_MAX_BEATS = 8;
export const STORYBOARD_MAX_CLIPS = 2;
export const STORYBOARD_MAX_CLIP_SECONDS = 30;
export const STORYBOARD_MAX_TOTAL_SECONDS = 60;
export const STORYBOARD_MAX_OPTIONAL_BEATS = 2;
/** 预估语速：儿童旁白偏慢，按 3.5 字/秒估，宁可低估容量也不让成片超 60 秒 */
export const STORYBOARD_CHARS_PER_SECOND = 3.5;
export const STORYBOARD_BEAT_PAUSE_SECONDS = 0.6;

export function estimateBeatSeconds(text: string): number {
  return (
    text.length / STORYBOARD_CHARS_PER_SECOND + STORYBOARD_BEAT_PAUSE_SECONDS
  );
}
