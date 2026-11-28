/**
 * 60 秒故事短片的分镜契约。
 *
 * 这是唯一中间产物：导演模型产出它，配音/画面/合成三个阶段都只读它。
 * 三条硬约束（由 validator 执行）：
 * 1. text 是受控压缩后的口播文案：忠于原文（结局一致、不加情节），
 *    允许压缩合并与调整语序，禁止凭空创作；
 * 2. 最多一处角色台词，其余全部旁白；
 * 3. 口播目标 54–58 秒（约 230–265 字），切成 1–2 段、每段 ≤30 秒；
 *    开端与结局不得标 optional。审批以 TTS 实测时长为准，字数只用于第一版约束。
 */

import { createHash } from "crypto";

export type VideoSpeaker = "narrator" | "elly" | "polly";

export type VideoEmotion = "calm" | "curious" | "excited" | "gentle" | "tense";

export interface StoryboardBeat {
  order: number;
  /** 原文 segments 下标，允许连续多段拼成一句 */
  sourceSegmentOrders: number[];
  speaker: VideoSpeaker;
  /** 受控压缩后的口播文案：忠于原文，允许压缩合并，禁止凭空创作 */
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

export const STORYBOARD_TARGET_SECONDS = 60;
export const STORYBOARD_MIN_TOTAL_SECONDS = 54;
export const STORYBOARD_MAX_TOTAL_SECONDS = 58;
export const STORYBOARD_MAX_CHARS = 265;
export const STORYBOARD_MAX_BEATS = 8;
export const STORYBOARD_MAX_CLIPS = 2;
export const STORYBOARD_MAX_CLIP_SECONDS = 30;
export const STORYBOARD_MAX_OPTIONAL_BEATS = 2;
/**
 * 预估语速：按 CosyVoice 中文旁白约 5 字/秒估。
 * 它只用于第一版分镜与编辑时的结构校验；审批一律以 TTS 实测时长为准。
 */
export const STORYBOARD_CHARS_PER_SECOND = 5;
export const STORYBOARD_BEAT_PAUSE_SECONDS = 0.6;

export function estimateBeatSeconds(text: string): number {
  return (
    text.length / STORYBOARD_CHARS_PER_SECOND + STORYBOARD_BEAT_PAUSE_SECONDS
  );
}

/**
 * 已生成音频对应的文案指纹。只覆盖会影响 TTS 的字段：
 * text / speaker / emotion / order + 音色集版本。
 * 改 shot / visualPrompt / optional / stylePrompt 不会让音频失效。
 */
export function computeVoiceTextHash(
  beats: Array<Pick<StoryboardBeat, "order" | "speaker" | "emotion" | "text">>,
  voiceSetVersion: string,
): string {
  const canonical = beats
    .map((beat) => `${beat.order}|${beat.speaker}|${beat.emotion}|${beat.text}`)
    .join("\n");
  return createHash("sha256")
    .update(`${voiceSetVersion}\n${canonical}`)
    .digest("hex");
}
