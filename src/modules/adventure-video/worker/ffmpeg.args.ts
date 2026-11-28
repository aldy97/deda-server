/**
 * ffmpeg 参数构建：全部是纯函数，CI 没装 ffmpeg 也能测。
 *
 * 三道处理：
 * 1. 每段视频归一化（分辨率/帧率/像素格式/sar），否则 concat 会失败；
 * 2. 旁白铺轨（anullsrc 底 + adelay + amix），间隙靠底噪静音填；
 * 3. 烧字幕 + loudnorm + H.264/AAC + faststart。
 */

export interface NormalizeOptions {
  input: string;
  output: string;
  width: number;
  height: number;
  fps?: number;
}

export function buildNormalizeArgs(options: NormalizeOptions): string[] {
  const { width, height, fps = 30 } = options;
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    "setsar=1",
    `fps=${fps}`,
  ].join(",");
  return [
    "-y",
    "-i",
    options.input,
    "-vf",
    filter,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    options.output,
  ];
}

export function buildConcatArgs(listFile: string, output: string): string[] {
  return [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    output,
  ];
}

export interface AudioBeatInput {
  path: string;
  delayMs: number;
}

export function buildAudioMixArgs(
  beats: AudioBeatInput[],
  totalSeconds: number,
  output: string,
  sampleRate = 24_000,
): string[] {
  const args = [
    "-y",
    "-f",
    "lavfi",
    "-t",
    totalSeconds.toFixed(3),
    "-i",
    `anullsrc=r=${sampleRate}:cl=mono`,
  ];
  for (const beat of beats) {
    args.push("-i", beat.path);
  }
  const filters: string[] = [];
  const mixInputs: string[] = ["[0:a]"];
  beats.forEach((beat, index) => {
    const label = `[b${index}]`;
    filters.push(
      `[${index + 1}:a]aresample=${sampleRate},adelay=${Math.max(
        0,
        Math.round(beat.delayMs),
      )}:all=1${label}`,
    );
    mixInputs.push(label);
  });
  filters.push(
    `${mixInputs.join("")}amix=inputs=${beats.length + 1}:normalize=0,atrim=0:${totalSeconds.toFixed(
      3,
    )}[aout]`,
  );
  args.push("-filter_complex", filters.join(";"), "-map", "[aout]");
  args.push("-c:a", "pcm_s16le", output);
  return args;
}

export interface FinalOptions {
  video: string;
  audio: string;
  assFile: string;
  output: string;
  fontsDir?: string;
}

export function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export function buildFinalArgs(options: FinalOptions): string[] {
  const subtitles = `subtitles=${escapeFilterPath(options.assFile)}${
    options.fontsDir ? `:fontsdir=${escapeFilterPath(options.fontsDir)}` : ""
  }`;
  return [
    "-y",
    "-i",
    options.video,
    "-i",
    options.audio,
    "-vf",
    subtitles,
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-shortest",
    options.output,
  ];
}

export interface AssCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface AssOptions {
  width: number;
  height: number;
  fontName?: string;
  fontSize?: number;
}

function assTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const centis = Math.round((clamped - Math.floor(clamped)) * 100);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(
    2,
    "0",
  )}.${String(centis).padStart(2, "0")}`;
}

export function buildAssSubtitles(cues: AssCue[], options: AssOptions): string {
  const width = options.width;
  const height = options.height;
  const fontSize = options.fontSize ?? Math.round(height * 0.035);
  const marginV = Math.round(height * 0.18);
  const fontName = options.fontName ?? "Noto Sans CJK SC";
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,${Math.round(
    width * 0.08,
  )},${Math.round(width * 0.08)},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const lines = cues.map((cue) => {
    const text = cue.text
      .replace(/\r?\n/g, " ")
      .replace(/\{/g, "（")
      .replace(/\}/g, "）");
    return `Dialogue: 0,${assTimestamp(cue.startSec)},${assTimestamp(
      cue.endSec,
    )},Default,,0,0,0,,${text}`;
  });
  return `${header}${lines.join("\n")}\n`;
}

function srtTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0",
  )}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function buildSrt(cues: AssCue[]): string {
  return `${cues
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTimestamp(cue.startSec)} --> ${srtTimestamp(
          cue.endSec,
        )}\n${cue.text.replace(/\r?\n/g, " ")}\n`,
    )
    .join("\n")}`;
}

export interface ProbeOutput {
  format?: { duration?: string };
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
  }>;
}

export function parseProbeOutput(json: ProbeOutput): {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
} {
  const durationSec = Number.parseFloat(json.format?.duration ?? "0") || 0;
  const video = (json.streams ?? []).find((s) => s.codec_type === "video");
  const hasAudio = (json.streams ?? []).some((s) => s.codec_type === "audio");
  const [num, den] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
  const fps = den ? Math.round((num / den) * 100) / 100 : 0;
  return {
    durationSec,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps,
    hasAudio,
  };
}

export function resolutionToSize(resolution: string): {
  width: number;
  height: number;
} {
  switch (resolution) {
    case "480P":
      return { width: 480, height: 854 };
    case "1080P":
      return { width: 1080, height: 1920 };
    case "720P":
    default:
      return { width: 720, height: 1280 };
  }
}
