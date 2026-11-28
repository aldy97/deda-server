import { registerAs } from "@nestjs/config";
import { createHash } from "crypto";
import { resolveForbiddenWords } from "@/common/content/forbidden-words";

/**
 * 冒险短视频的配置解析。
 *
 * 与内容管理台的关系：本模块是**加法模块**，开关默认关闭；关闭时只影响
 * `/analytics/adventure-video/*`，不改变任何既有接口行为。
 *
 * 音色分两档，切换只靠 env：
 * - system：VIDEO_TTS_MODE 缺省值。cosyvoice-v3-flash 的三条系统音色，
 *   用于样本到位前的联调与试跑。
 * - cloned：cosyvoice-v3.5-flash + 复刻音色。v3.5 系列没有系统音色，
 *   所以两种模式必须用不同模型，不能简单换 voice id。
 *
 * TODO(voice-samples): 三份 10–20 秒样本到位、复刻写入 adventure_video_voices 后，
 * 把 VIDEO_TTS_MODE 默认值切到 cloned（或部署配置显式设置），并删除本注释。
 */

export const VIDEO_TTS_MODEL_SYSTEM = "cosyvoice-v3-flash";
export const VIDEO_TTS_MODEL_CLONED = "cosyvoice-v3.5-flash";

export type VideoTtsMode = "system" | "cloned";
export type VideoVoiceRole = "elly" | "polly" | "narrator";

/** 系统试跑音色：只用于联调，不代表最终角色声线。 */
export const VIDEO_SYSTEM_VOICES: Record<VideoVoiceRole, string> = {
  elly: "longhua_v3",
  polly: "longze_v3",
  narrator: "longwan_v3",
};

export const VIDEO_ASPECT_DEFAULT = "9:16";
export const VIDEO_RESOLUTION_DEFAULT = "720P";
export const VIDEO_TEASER_SECONDS = 60;
export const VIDEO_BUDGET_CNY_DEFAULT = 50;
export const VIDEO_SIGNED_URL_TTL_SEC_DEFAULT = 3600;

export interface VideoStudioConfig {
  enabled: boolean;
  ttsMode: VideoTtsMode;
  /**
   * 是否允许给 TTS 请求下发 instruction（情绪/语速）。
   * off 是紧急止血开关：上游改动 Instruct 规则时靠 env 关掉，不必等发版。
   */
  ttsInstruction: VideoTtsInstruction;
  systemVoices: Record<VideoVoiceRole, string>;
  aspect: string;
  resolution: string;
  budgetCents: number;
  bailian: {
    apiKey: string;
    workspaceId: string;
  };
  oss: {
    region: string;
    bucket: string;
    endpoint: string;
    accessKeyId: string;
    accessKeySecret: string;
    signedUrlTtlSec: number;
  };
  workerConcurrency: number;
  /** 角色参考图在 OSS 里的 objectKey；缺省则不带参考图生成（质量降级） */
  referenceKeys: { elly?: string; polly?: string };
  /** 中文字体目录，烧字幕用；镜像里是 /usr/share/fonts */
  fontsDir: string;
  /** 儿童内容违禁词（与 ADVENTURE_LINT_FORBIDDEN_WORDS 同源，逗号分隔），分镜文案扫描用 */
  lintForbiddenWords: string[];
  /** 视频任务轮询间隔；测试里设 0 避免真等 */
  pollIntervalMs: number;
}

type EnvReader = (key: string) => string | undefined;

function nonEmpty(value: string | undefined): string | null {
  const text = (value ?? "").trim();
  return text.length > 0 ? text : null;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseTtsMode(value: string | undefined): VideoTtsMode {
  // 拼错一律回落 system：system 是能出片的试跑档，比拒绝启动更适合联调；
  // 真正的复刻缺位由 voice service 抛 VOICE_NOT_READY，不靠这里兜。
  return (value ?? "").trim().toLowerCase() === "cloned" ? "cloned" : "system";
}

export type VideoTtsInstruction = "on" | "off";

export function parseTtsInstruction(
  value: string | undefined,
): VideoTtsInstruction {
  return (value ?? "").trim().toLowerCase() === "off" ? "off" : "on";
}

/**
 * v3-flash 的三个系统试跑音色（longhua_v3 / longze_v3 / longwan_v3）在官方音色表里
 * 标注「Instruct：不支持」，带 instruction 调用会被上游以 428（InvalidParameter）拒绝；
 * v3.5-flash 的复刻音色支持自由中文指令，所以只有 cloned 档才下发。
 */
export function supportsTtsInstruction(
  config: Pick<VideoStudioConfig, "ttsMode" | "ttsInstruction">,
): boolean {
  return config.ttsInstruction === "on" && config.ttsMode === "cloned";
}

/**
 * 音色集指纹：进入 job 的唯一性判断。换音色后重新生成不会被
 * 「同一版本已有视频」误判为重复；系统试跑与复刻产物也天然分开。
 */
export function buildVoiceSetVersion(
  mode: VideoTtsMode,
  voices: Record<VideoVoiceRole, string>,
): string {
  const canonical = (["elly", "polly", "narrator"] as VideoVoiceRole[])
    .map((role) => `${role}:${voices[role] ?? ""}`)
    .join("|");
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `${mode}:${digest.slice(0, 16)}`;
}

export function resolveVideoStudioConfig(get: EnvReader): VideoStudioConfig {
  const ttsMode = parseTtsMode(get("VIDEO_TTS_MODE"));
  return {
    enabled: (get("ADVENTURE_VIDEO_ENABLED") ?? "").trim() === "true",
    ttsMode,
    ttsInstruction: parseTtsInstruction(get("VIDEO_TTS_INSTRUCTION")),
    systemVoices: { ...VIDEO_SYSTEM_VOICES },
    aspect: nonEmpty(get("VIDEO_ASPECT")) ?? VIDEO_ASPECT_DEFAULT,
    resolution: nonEmpty(get("VIDEO_RESOLUTION")) ?? VIDEO_RESOLUTION_DEFAULT,
    budgetCents:
      parsePositiveInt(
        get("VIDEO_TEASER_BUDGET_CNY"),
        VIDEO_BUDGET_CNY_DEFAULT,
      ) * 100,
    bailian: {
      apiKey: nonEmpty(get("BAILIAN_API_KEY")) ?? "",
      workspaceId: nonEmpty(get("BAILIAN_WORKSPACE_ID")) ?? "",
    },
    oss: {
      region: nonEmpty(get("OSS_REGION")) ?? "",
      bucket: nonEmpty(get("OSS_BUCKET")) ?? "",
      endpoint: nonEmpty(get("OSS_ENDPOINT")) ?? "",
      accessKeyId: nonEmpty(get("OSS_ACCESS_KEY_ID")) ?? "",
      accessKeySecret: nonEmpty(get("OSS_ACCESS_KEY_SECRET")) ?? "",
      signedUrlTtlSec: parsePositiveInt(
        get("OSS_SIGNED_URL_TTL_SEC"),
        VIDEO_SIGNED_URL_TTL_SEC_DEFAULT,
      ),
    },
    workerConcurrency: parsePositiveInt(get("VIDEO_WORKER_CONCURRENCY"), 2),
    referenceKeys: parseReferenceKeys(get("VIDEO_REFERENCE_KEYS")),
    fontsDir: nonEmpty(get("VIDEO_FONTS_DIR")) ?? "/usr/share/fonts",
    lintForbiddenWords: resolveForbiddenWords(
      get("ADVENTURE_LINT_FORBIDDEN_WORDS"),
    ),
    pollIntervalMs: parsePositiveInt(get("VIDEO_POLL_INTERVAL_MS"), 15_000),
  };
}

function parseReferenceKeys(raw: string | undefined): {
  elly?: string;
  polly?: string;
} {
  const text = (raw ?? "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const result: { elly?: string; polly?: string } = {};
    for (const role of ["elly", "polly"] as const) {
      const value = parsed[role];
      if (typeof value === "string" && value.trim()) {
        result[role] = value.trim();
      }
    }
    return result;
  } catch {
    // 配置拼错时宁可不带参考图出片，也不让 worker 启动即崩；错误会在日志里可见。
    return {};
  }
}

export default registerAs("video", () =>
  resolveVideoStudioConfig((key) => process.env[key]),
);
