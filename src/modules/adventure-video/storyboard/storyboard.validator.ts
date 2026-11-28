import {
  estimateBeatSeconds,
  STORYBOARD_MAX_BEATS,
  STORYBOARD_MAX_CHARS,
  STORYBOARD_MAX_CLIPS,
  STORYBOARD_MAX_CLIP_SECONDS,
  STORYBOARD_MAX_OPTIONAL_BEATS,
  STORYBOARD_MAX_TOTAL_SECONDS,
  type Storyboard,
  type StoryboardBeat,
  type StoryboardClip,
  type StoryboardPayload,
  type VideoEmotion,
  type VideoSpeaker,
} from "./storyboard.types";

export class StoryboardValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "StoryboardValidationError";
  }
}

export interface StoryboardEnvelope {
  title: string;
  businessKey: string;
  episodeVersionId: string;
  contentHash: string;
  aspect: string;
  resolution: string;
}

export interface ValidateStoryboardOptions {
  maxChars?: number;
  maxBeats?: number;
  maxClips?: number;
  maxClipSeconds?: number;
  maxTotalSeconds?: number;
  maxOptionalBeats?: number;
  /** 儿童内容违禁词（复用 ADVENTURE_LINT_FORBIDDEN_WORDS 同源），命中即拒 */
  forbiddenWords?: string[];
}

const SPEAKERS: VideoSpeaker[] = ["narrator", "elly", "polly"];
const EMOTIONS: VideoEmotion[] = [
  "calm",
  "curious",
  "excited",
  "gentle",
  "tense",
];
const CHARACTERS = ["elly", "polly"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string, message: string, path?: string): never {
  throw new StoryboardValidationError(code, message, path);
}

function requireString(
  value: unknown,
  path: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    fail("STORYBOARD_TYPE", `${path} 必须是字符串`, path);
  }
  const text = value.trim();
  if (!text) fail("STORYBOARD_EMPTY", `${path} 不能为空`, path);
  if (text.length > maxLength) {
    fail("STORYBOARD_TOO_LONG", `${path} 超过 ${maxLength} 字`, path);
  }
  return text;
}

/** 违禁词是子串命中：text 与三类画面字段都要过同一张表。 */
function assertNoForbiddenWords(
  value: string,
  path: string,
  forbiddenWords: string[],
): void {
  const hits = forbiddenWords.filter((word) => value.includes(word));
  if (hits.length > 0) {
    fail(
      "STORYBOARD_FORBIDDEN_WORD",
      `${path} 含违禁词：${hits.join("、")}`,
      path,
    );
  }
}

/**
 * 分镜校验。所有失败都带机器码与路径，worker 可以据此决定
 * 「让导演模型重试一次」还是「直接失败、不要浪费视频调用」。
 */
export function validateStoryboard(
  input: unknown,
  payload: StoryboardPayload,
  envelope: StoryboardEnvelope,
  options: ValidateStoryboardOptions = {},
): Storyboard {
  const maxChars = options.maxChars ?? STORYBOARD_MAX_CHARS;
  const maxBeats = options.maxBeats ?? STORYBOARD_MAX_BEATS;
  const maxClips = options.maxClips ?? STORYBOARD_MAX_CLIPS;
  const maxClipSeconds = options.maxClipSeconds ?? STORYBOARD_MAX_CLIP_SECONDS;
  const maxTotalSeconds =
    options.maxTotalSeconds ?? STORYBOARD_MAX_TOTAL_SECONDS;
  const maxOptionalBeats =
    options.maxOptionalBeats ?? STORYBOARD_MAX_OPTIONAL_BEATS;

  if (!isRecord(input)) {
    fail("STORYBOARD_TYPE", "分镜必须是 JSON 对象");
  }
  const segments = Array.isArray(payload.segments) ? payload.segments : [];
  const forbiddenWords = options.forbiddenWords ?? [];
  const stylePrompt = requireString(input.stylePrompt, "stylePrompt", 400);
  assertNoForbiddenWords(stylePrompt, "stylePrompt", forbiddenWords);
  const rawBeats = input.beats;
  if (!Array.isArray(rawBeats) || rawBeats.length === 0) {
    fail("STORYBOARD_BEATS", "beats 必须是非空数组", "beats");
  }
  if (rawBeats.length > maxBeats) {
    fail("STORYBOARD_BEATS", `beats 最多 ${maxBeats} 段`, "beats");
  }

  let nonNarratorCount = 0;
  let optionalCount = 0;
  let charTotal = 0;

  const beats: StoryboardBeat[] = rawBeats.map((raw, index) => {
    const path = `beats[${index}]`;
    if (!isRecord(raw)) fail("STORYBOARD_TYPE", `${path} 必须是对象`, path);
    if (raw.order !== index) {
      fail(
        "STORYBOARD_ORDER",
        `${path}.order 必须等于 ${index}`,
        `${path}.order`,
      );
    }
    if (raw.optional !== undefined && typeof raw.optional !== "boolean") {
      fail(
        "STORYBOARD_TYPE",
        `${path}.optional 必须是布尔值`,
        `${path}.optional`,
      );
    }
    const speakerValue = raw.speaker;
    if (!SPEAKERS.includes(speakerValue as VideoSpeaker)) {
      fail(
        "STORYBOARD_SPEAKER",
        `${path}.speaker 不是合法角色`,
        `${path}.speaker`,
      );
    }
    const speaker = speakerValue as VideoSpeaker;
    const emotion = raw.emotion;
    if (!EMOTIONS.includes(emotion as VideoEmotion)) {
      fail(
        "STORYBOARD_EMOTION",
        `${path}.emotion 不是合法情绪`,
        `${path}.emotion`,
      );
    }
    if (!Array.isArray(raw.characters)) {
      fail(
        "STORYBOARD_CHARACTERS",
        `${path}.characters 必须是数组`,
        `${path}.characters`,
      );
    }
    const characters = raw.characters.map((item) => {
      if (!CHARACTERS.includes(item as (typeof CHARACTERS)[number])) {
        fail(
          "STORYBOARD_CHARACTERS",
          `${path}.characters 只能包含 elly / polly`,
          `${path}.characters`,
        );
      }
      return item as "elly" | "polly";
    });
    if (speaker !== "narrator" && !characters.includes(speaker)) {
      fail(
        "STORYBOARD_SPEAKER_OFFSCREEN",
        `${path} 的说话角色必须出现在 characters 里`,
        `${path}.characters`,
      );
    }

    const text = requireString(raw.text, `${path}.text`, 120);
    if (/[\r\n]/.test(text)) {
      fail("STORYBOARD_TEXT_NEWLINE", `${path}.text 不能换行`, `${path}.text`);
    }
    assertNoForbiddenWords(text, `${path}.text`, forbiddenWords);
    if (
      !Array.isArray(raw.sourceSegmentOrders) ||
      raw.sourceSegmentOrders.length === 0
    ) {
      fail(
        "STORYBOARD_SOURCE",
        `${path}.sourceSegmentOrders 不能为空`,
        `${path}.sourceSegmentOrders`,
      );
    }
    const sourceSegmentOrders = raw.sourceSegmentOrders.map((value) => {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value >= segments.length
      ) {
        fail(
          "STORYBOARD_SOURCE",
          `${path}.sourceSegmentOrders 越界`,
          `${path}.sourceSegmentOrders`,
        );
      }
      return value;
    });
    for (let i = 1; i < sourceSegmentOrders.length; i += 1) {
      if (sourceSegmentOrders[i] <= sourceSegmentOrders[i - 1]) {
        fail(
          "STORYBOARD_SOURCE",
          `${path}.sourceSegmentOrders 必须严格递增`,
          `${path}.sourceSegmentOrders`,
        );
      }
    }
    // 受控压缩模式：text 是忠于原文的改写而非子串，溯源靠
    // sourceSegmentOrders 标注来源；忠实度由 prompt 规则 + 违禁词扫描兜底。

    if (speaker !== "narrator") nonNarratorCount += 1;
    if (raw.optional === true) optionalCount += 1;
    charTotal += text.length;

    const shot = requireString(raw.shot, `${path}.shot`, 120);
    assertNoForbiddenWords(shot, `${path}.shot`, forbiddenWords);
    const visualPrompt = requireString(
      raw.visualPrompt,
      `${path}.visualPrompt`,
      400,
    );
    assertNoForbiddenWords(
      visualPrompt,
      `${path}.visualPrompt`,
      forbiddenWords,
    );

    return {
      order: index,
      sourceSegmentOrders,
      speaker: speaker as VideoSpeaker,
      text,
      emotion: emotion as VideoEmotion,
      characters,
      shot,
      visualPrompt,
      optional: raw.optional === true,
    };
  });

  if (nonNarratorCount > 1) {
    fail(
      "STORYBOARD_SPEAKER_LIMIT",
      "60 秒短片最多只允许一处角色台词，其余必须是旁白",
      "beats",
    );
  }
  // 三幕闭环的结构守卫：开端与结局是整个故事不可裁剪的部分，
  // clips 覆盖规则保证 beats[0] 与 beats[len-1] 分别就是开端与结局。
  if (beats[0].optional) {
    fail(
      "STORYBOARD_ENDING_REQUIRED",
      "开端 beat 不能标记 optional",
      "beats[0].optional",
    );
  }
  if (beats[beats.length - 1].optional) {
    fail(
      "STORYBOARD_ENDING_REQUIRED",
      "结局 beat 不能标记 optional",
      `beats[${beats.length - 1}].optional`,
    );
  }
  if (optionalCount > maxOptionalBeats) {
    fail(
      "STORYBOARD_OPTIONAL_LIMIT",
      `optional beat 最多 ${maxOptionalBeats} 段`,
      "beats",
    );
  }
  if (charTotal > maxChars) {
    fail(
      "STORYBOARD_CHAR_BUDGET",
      `旁白共 ${charTotal} 字，超过 ${maxChars} 字预算`,
      "beats",
    );
  }

  const rawClips = input.clips;
  if (!Array.isArray(rawClips) || rawClips.length === 0) {
    fail("STORYBOARD_CLIPS", "clips 必须是非空数组", "clips");
  }
  if (rawClips.length > maxClips) {
    fail("STORYBOARD_CLIPS", `clips 最多 ${maxClips} 段`, "clips");
  }

  const seen: number[] = [];
  const clips: StoryboardClip[] = rawClips.map((raw, index) => {
    const path = `clips[${index}]`;
    if (!isRecord(raw)) fail("STORYBOARD_TYPE", `${path} 必须是对象`, path);
    if (raw.order !== index) {
      fail(
        "STORYBOARD_ORDER",
        `${path}.order 必须等于 ${index}`,
        `${path}.order`,
      );
    }
    if (!Array.isArray(raw.beats) || raw.beats.length === 0) {
      fail("STORYBOARD_CLIPS", `${path}.beats 不能为空`, `${path}.beats`);
    }
    const orders = raw.beats.map((value) => {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value >= beats.length
      ) {
        fail("STORYBOARD_CLIPS", `${path}.beats 越界`, `${path}.beats`);
      }
      return value;
    });
    seen.push(...orders);
    const seconds = orders.reduce(
      (sum, order) => sum + estimateBeatSeconds(beats[order].text),
      0,
    );
    if (seconds > maxClipSeconds) {
      fail(
        "STORYBOARD_CLIP_TOO_LONG",
        `${path} 预估 ${seconds.toFixed(1)} 秒，超过 ${maxClipSeconds} 秒`,
        path,
      );
    }
    return { order: index, beats: orders };
  });

  if (
    seen.length !== beats.length ||
    seen.some((value, index) => value !== index)
  ) {
    fail(
      "STORYBOARD_CLIP_COVERAGE",
      "clips 必须按顺序、不重不漏地覆盖全部 beats",
      "clips",
    );
  }

  const totalSeconds = beats.reduce(
    (sum, beat) => sum + estimateBeatSeconds(beat.text),
    0,
  );
  if (totalSeconds > maxTotalSeconds) {
    fail(
      "STORYBOARD_TOTAL_TOO_LONG",
      `预估总时长 ${totalSeconds.toFixed(1)} 秒，超过 ${maxTotalSeconds} 秒`,
      "beats",
    );
  }

  return {
    version: 1,
    title: envelope.title,
    businessKey: envelope.businessKey,
    episodeVersionId: envelope.episodeVersionId,
    contentHash: envelope.contentHash,
    aspect: envelope.aspect,
    resolution: envelope.resolution,
    stylePrompt,
    totalTextChars: charTotal,
    beats,
    clips,
  };
}
