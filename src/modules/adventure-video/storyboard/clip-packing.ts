import { StoryboardValidationError } from "./storyboard.validator";
import {
  estimateBeatSeconds,
  STORYBOARD_MAX_CLIP_SECONDS,
  STORYBOARD_MAX_CLIPS,
  type StoryboardClip,
} from "./storyboard.types";

export interface PackableBeat {
  order: number;
  text: string;
}

export interface PackClipsOptions {
  maxClips?: number;
  maxClipSeconds?: number;
}

/**
 * 审核稿的 clips 由服务端推导，不让审核员手改分段。
 *
 * 规则与 worker 的 planClips 同口径：按顺序装段、每段 ≤30 秒、最多 2 段。
 * 不同点是这里用预估时长，只做结构校验；真实时长在审批时由 TTS 实测决定。
 */
export function packClipsByEstimate(
  beats: PackableBeat[],
  options: PackClipsOptions = {},
): StoryboardClip[] {
  const maxClips = options.maxClips ?? STORYBOARD_MAX_CLIPS;
  const maxClipSeconds = options.maxClipSeconds ?? STORYBOARD_MAX_CLIP_SECONDS;

  const clips: Array<{ order: number; beats: number[] }> = [];
  let current: number[] = [];
  let elapsed = 0;

  for (const beat of beats) {
    const seconds = estimateBeatSeconds(beat.text);
    if (seconds > maxClipSeconds) {
      throw new StoryboardValidationError(
        "STORYBOARD_CLIP_TOO_LONG",
        `beat ${beat.order} 预估 ${seconds.toFixed(1)} 秒，超过 ${maxClipSeconds} 秒`,
        `beats[${beat.order}]`,
      );
    }
    if (current.length > 0 && elapsed + seconds > maxClipSeconds) {
      clips.push({ order: clips.length, beats: current });
      if (clips.length >= maxClips) {
        throw new StoryboardValidationError(
          "STORYBOARD_CLIP_TOO_LONG",
          `旁白需要超过 ${maxClips} 段、每段 ≤${maxClipSeconds} 秒才能装下`,
          "beats",
        );
      }
      current = [];
      elapsed = 0;
    }
    current.push(beat.order);
    elapsed += seconds;
  }

  if (current.length > 0) {
    clips.push({ order: clips.length, beats: current });
  }
  return clips;
}
