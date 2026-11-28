/**
 * 切段：把已经量过真实时长的 beat 装进 1–2 个 ≤30 秒的 clip。
 *
 * 顺序上刻意放在 TTS 之后：视频 prompt 里的时间戳必须与真实旁白一致，
 * 不能先按字数猜。超时长时只允许丢 optional，不允许改写或静默截断。
 */

export interface PlannedBeatInput {
  beatOrder: number;
  text: string;
  audioDurationSec: number;
  optional: boolean;
}

export interface PlannedBeat extends PlannedBeatInput {
  startSec: number;
  endSec: number;
}

export interface PlannedClip {
  order: number;
  beats: PlannedBeat[];
  durationSec: number;
}

export interface PlanClipsOptions {
  maxClips?: number;
  maxClipSeconds?: number;
  maxTotalSeconds?: number;
  /** beat 之间的自然停顿 */
  gapSeconds?: number;
}

export interface PlanClipsResult {
  clips: PlannedClip[];
  droppedBeatOrders: number[];
  totalSec: number;
}

export class ClipPlanError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClipPlanError";
  }
}

export function planClips(
  beats: PlannedBeatInput[],
  options: PlanClipsOptions = {},
): PlanClipsResult {
  const maxClips = options.maxClips ?? 2;
  const maxClipSeconds = options.maxClipSeconds ?? 30;
  const maxTotalSeconds = options.maxTotalSeconds ?? 58;
  const gapSeconds = options.gapSeconds ?? 0.35;

  if (beats.length === 0) {
    throw new ClipPlanError("NO_BEATS", "没有可用的旁白段落");
  }
  if (beats.some((beat) => beat.audioDurationSec > maxClipSeconds)) {
    throw new ClipPlanError(
      "BEAT_TOO_LONG",
      `存在单段超过 ${maxClipSeconds} 秒的旁白，无法切段`,
    );
  }

  const dropped: number[] = [];
  let active = [...beats];

  const tryPlan = (input: PlannedBeatInput[]): PlanClipsResult | null => {
    const clips: PlannedClip[] = [];
    let current: PlannedBeat[] = [];
    let elapsed = 0;

    for (const beat of input) {
      const duration = beat.audioDurationSec;
      const withGap = current.length > 0 ? duration + gapSeconds : duration;
      if (elapsed + withGap > maxClipSeconds) {
        if (current.length === 0) return null;
        clips.push({
          order: clips.length,
          beats: current,
          durationSec: elapsed,
        });
        if (clips.length >= maxClips) return null;
        current = [];
        elapsed = 0;
      }
      const start = elapsed;
      const end = start + duration;
      current.push({ ...beat, startSec: start, endSec: end });
      elapsed = end + gapSeconds;
    }
    if (current.length > 0) {
      clips.push({ order: clips.length, beats: current, durationSec: elapsed });
    }
    if (clips.length > maxClips) return null;
    const totalSec = clips.reduce((sum, clip) => sum + clip.durationSec, 0);
    if (totalSec > maxTotalSeconds) return null;
    return { clips, droppedBeatOrders: [...dropped], totalSec };
  };

  let planned = tryPlan(active);
  while (!planned) {
    const optionalIndex = [...active]
      .map((beat, index) => ({ beat, index }))
      .filter((item) => item.beat.optional)
      .map((item) => item.index)
      .pop();
    if (optionalIndex === undefined) {
      throw new ClipPlanError(
        "OVER_BUDGET",
        `旁白总时长超过 ${maxTotalSeconds} 秒且没有可丢弃的 optional 段`,
      );
    }
    dropped.push(active[optionalIndex].beatOrder);
    active = active.filter((_, index) => index !== optionalIndex);
    planned = tryPlan(active);
  }

  return planned;
}
