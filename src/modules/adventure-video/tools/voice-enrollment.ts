/**
 * 声音复刻请求/响应的纯函数。
 *
 * 单独抽出来是为了让脚本可以在没有网络、没有数据库时被测试：
 * 参数拼错、voice_id 取错字段，都会让「复刻看起来成功、合成时 404」，
 * 那种故障排查成本远高于这里多写 20 行。
 */

export interface CreateVoiceInput {
  targetModel: string;
  prefix: string;
  audioDataUri: string;
  languageHints?: string[];
  maxPromptAudioLengthSec?: number;
}

export interface VoiceEnrollmentBody {
  model: "voice-enrollment";
  input: {
    action: "create_voice";
    target_model: string;
    audio: string;
    prefix: string;
    language_hints: string[];
    max_prompt_audio_length?: number;
  };
}

export function buildCreateVoiceBody(
  input: CreateVoiceInput,
): VoiceEnrollmentBody {
  const prefix = input.prefix.trim();
  if (!/^[A-Za-z0-9]{1,10}$/.test(prefix)) {
    throw new Error("prefix 只能是 1–10 位字母或数字");
  }
  if (!input.audioDataUri.startsWith("data:audio/")) {
    throw new Error("audio 必须是 data:audio/... 的 Data URI");
  }
  return {
    model: "voice-enrollment",
    input: {
      action: "create_voice",
      target_model: input.targetModel,
      audio: input.audioDataUri,
      prefix,
      language_hints: input.languageHints ?? ["zh"],
      ...(input.maxPromptAudioLengthSec
        ? { max_prompt_audio_length: input.maxPromptAudioLengthSec }
        : {}),
    },
  };
}

export function parseCreatedVoiceId(response: unknown): string {
  const id = (response as { output?: { voice_id?: unknown } })?.output
    ?.voice_id;
  if (typeof id !== "string" || !id) {
    throw new Error("复刻响应里没有 output.voice_id");
  }
  return id;
}

export function parseVoiceStatus(response: unknown): string {
  const status = (response as { output?: { status?: unknown } })?.output
    ?.status;
  return typeof status === "string" ? status : "UNKNOWN";
}

export function toAudioDataUri(buffer: Buffer, fileName: string): string {
  const name = fileName.toLowerCase();
  const mime = name.endsWith(".wav")
    ? "audio/wav"
    : name.endsWith(".mp3")
      ? "audio/mpeg"
      : name.endsWith(".m4a")
        ? "audio/mp4"
        : null;
  if (!mime) {
    throw new Error(`不支持的音频格式：${fileName}（只接受 wav/mp3/m4a）`);
  }
  return `data:${mime};base64,${buffer.toString("base64")}`;
}
