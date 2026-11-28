import {
  VIDEO_TTS_MODEL_CLONED,
  VIDEO_TTS_MODEL_SYSTEM,
  type VideoTtsMode,
} from "@/config/video.config";

/**
 * 60 秒预告的计价口径。
 *
 * 只用于「点按钮前的预估」与预算闸，不做账单真相：真实用量以百炼账单为准。
 * 单价取百炼模型广场列表价（华北2·北京）；万相 3.0 当前列表带 0.7 折扣标记，
 * 这里**刻意按原价**估，宁可预估偏高也不让预算闸被折扣骗过去。
 *
 * 单位一律「分」，避免浮点累积误差；只在最后向上取整一次。
 */

export const VIDEO_YUAN_PER_SECOND: Record<string, number> = {
  "480P": 0.3,
  "720P": 0.6,
  "1080P": 1.2,
};

export const TTS_YUAN_PER_10K_CHARS: Record<string, number> = {
  [VIDEO_TTS_MODEL_SYSTEM]: 1,
  [VIDEO_TTS_MODEL_CLONED]: 0.8,
};

/** 参考图/场景图按每张 1K 输出价计，统一 0.18 元。 */
export const IMAGE_YUAN_PER_CALL = 0.18;

export interface TeaserCostInput {
  durationSec: number;
  resolution: string;
  ttsChars: number;
  ttsMode: VideoTtsMode;
  imageCount?: number;
}

export interface TeaserCostBreakdown {
  videoCents: number;
  ttsCents: number;
  imageCents: number;
  totalCents: number;
}

export function isSupportedResolution(resolution: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    VIDEO_YUAN_PER_SECOND,
    resolution,
  );
}

export function ttsModelForMode(mode: VideoTtsMode): string {
  return mode === "cloned" ? VIDEO_TTS_MODEL_CLONED : VIDEO_TTS_MODEL_SYSTEM;
}

export function estimateTeaserCostCents(
  input: TeaserCostInput,
): TeaserCostBreakdown {
  const perSecond = VIDEO_YUAN_PER_SECOND[input.resolution];
  if (perSecond === undefined) {
    throw new Error(`unsupported resolution: ${input.resolution}`);
  }
  const durationSec = Math.max(0, Math.ceil(input.durationSec));
  const videoCents = Math.ceil(durationSec * perSecond * 100);

  const ttsModel = ttsModelForMode(input.ttsMode);
  const per10k = TTS_YUAN_PER_10K_CHARS[ttsModel];
  if (per10k === undefined) {
    throw new Error(`unsupported tts model: ${ttsModel}`);
  }
  const chars = Math.max(0, Math.ceil(input.ttsChars));
  const ttsCents = Math.ceil((chars * per10k * 100) / 10_000);

  const imageCount = Math.max(0, Math.ceil(input.imageCount ?? 0));
  const imageCents = Math.ceil(imageCount * IMAGE_YUAN_PER_CALL * 100);

  return {
    videoCents,
    ttsCents,
    imageCents,
    totalCents: videoCents + ttsCents + imageCents,
  };
}
