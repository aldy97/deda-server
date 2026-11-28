import { createHash } from "crypto";

/**
 * 每个 clip 的视频 prompt。
 *
 * wan3.0 支持「时间戳 + 多镜头」写法，所以这里把真实旁白时长转成
 * `0.0-8.2s：…` 的分镜行，让画面节奏跟着配音走，而不是先定 5 秒硬塞。
 *
 * 不写台词：audio=false，台词由我方 TTS 负责，避免模型自由发挥改故事。
 */

export interface ClipPromptBeat {
  startSec: number;
  endSec: number;
  shot: string;
  visualPrompt: string;
}

export interface ClipPromptInput {
  stylePrompt: string;
  beats: ClipPromptBeat[];
  characterKey: string;
}

export function buildClipPrompt(input: ClipPromptInput): string {
  const character = input.characterKey === "polly" ? "小马 Polly" : "小象 Elly";
  const lines = input.beats.map(
    (beat) =>
      `${beat.startSec.toFixed(1)}-${beat.endSec.toFixed(1)}s：${beat.shot}。${
        beat.visualPrompt
      }`,
  );
  return [
    input.stylePrompt,
    "9:16 竖屏，30fps，儿童动画，角色造型全片保持一致。",
    `主角：${character}；参考图里的角色外观不得改变。`,
    "分镜（严格按时间戳，多镜头）：",
    ...lines,
    "旁白为画外音，不需要口型同步；角色动作自然，不出现真实人脸、文字、水印或危险动作。",
  ].join("\n");
}

/** 固定 seed：同一 job 同一段重跑时，构图不会完全换一张脸。 */
export function buildClipSeed(jobId: string, order: number): number {
  const digest = createHash("sha256")
    .update(`${jobId}:${order}`)
    .digest("hex")
    .slice(0, 8);
  return Number.parseInt(digest, 16) % 2_147_483_647;
}
