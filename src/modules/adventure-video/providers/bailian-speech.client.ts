import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { VideoStudioConfig } from "@/config/video.config";
import {
  BAILIAN_REGION,
  HTTP_TRANSPORT,
  ProviderError,
  type HttpTransport,
  type SpeechInput,
  type SpeechResult,
} from "./provider.types";

/**
 * CosyVoice 非实时 TTS 客户端。
 *
 * 关键约束：
 * - 复刻音色绑定 target_model，换模型必须重新复刻；调用方传进来的 model
 *   与 voice 必须来自同一套（system 用 v3-flash，cloned 用 v3.5-flash）。
 * - 返回的音频 URL 同样 24 小时过期，worker 必须立刻下载转存。
 * - instruction 上限 100 字符，超了上游会 400；这里提前截断，宁短勿炸。
 */
@Injectable()
export class BailianSpeechClient {
  constructor(
    @Inject(HTTP_TRANSPORT) private readonly http: HttpTransport,
    private readonly configService: ConfigService,
  ) {}

  async synthesize(input: SpeechInput): Promise<SpeechResult> {
    const text = (input.text ?? "").trim();
    if (!text) {
      throw new ProviderError(
        "bailian-speech",
        "EMPTY_TEXT",
        "TTS 文本为空",
        false,
      );
    }

    const body = {
      model: input.model,
      input: {
        text,
        voice: input.voice,
        format: input.format ?? "wav",
        sample_rate: input.sampleRate ?? 24000,
        ...(input.rate ? { rate: input.rate } : {}),
        ...(input.instruction
          ? { instruction: truncateInstruction(input.instruction) }
          : {}),
      },
    };

    const response = (await this.request(body, input)) as {
      output?: { audio?: { url?: unknown } };
      usage?: { characters?: unknown };
    };

    const audioUrl = response?.output?.audio?.url;
    if (typeof audioUrl !== "string" || !audioUrl) {
      throw new ProviderError(
        "bailian-speech",
        "NO_AUDIO_URL",
        "TTS 未返回音频 URL",
        true,
      );
    }
    const characters =
      typeof response?.usage?.characters === "number"
        ? response.usage.characters
        : text.length;

    return { audioUrl, characters };
  }

  /** 参数类错误（如音色不支持 instruction 的 428）换成领域码，并带出音色与模型。 */
  private async request(body: unknown, input: SpeechInput): Promise<unknown> {
    try {
      return await this.http.post(
        `${this.baseUrl()}/api/v1/services/audio/tts/SpeechSynthesizer`,
        body,
        {
          Authorization: `Bearer ${this.apiKey()}`,
          "Content-Type": "application/json",
        },
      );
    } catch (error) {
      if (error instanceof ProviderError && error.code === "InvalidParameter") {
        throw new ProviderError(
          error.provider,
          "TTS_PARAMETER_INVALID",
          `${error.message}（voice=${input.voice} model=${input.model}）`,
          false,
        );
      }
      throw error;
    }
  }

  private baseUrl(): string {
    const workspaceId = this.videoConfig().bailian.workspaceId;
    if (!workspaceId) {
      throw new ProviderError(
        "bailian-speech",
        "WORKSPACE_MISSING",
        "BAILIAN_WORKSPACE_ID 未配置",
        false,
      );
    }
    return `https://${workspaceId}.${BAILIAN_REGION}.maas.aliyuncs.com`;
  }

  private apiKey(): string {
    const apiKey = this.videoConfig().bailian.apiKey;
    if (!apiKey) {
      throw new ProviderError(
        "bailian-speech",
        "API_KEY_MISSING",
        "BAILIAN_API_KEY 未配置",
        false,
      );
    }
    return apiKey;
  }

  private videoConfig(): VideoStudioConfig {
    const config = this.configService.get<VideoStudioConfig>("video");
    if (!config) {
      throw new ProviderError(
        "bailian-speech",
        "CONFIG_MISSING",
        "video 配置未加载",
        false,
      );
    }
    return config;
  }
}

/** 官方上限：instruction 100 个字符，汉字按 2 计、其余按 1；超了上游直接 428。 */
const INSTRUCTION_MAX_UNITS = 100;
const HAN_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function truncateInstruction(
  text: string,
  maxUnits = INSTRUCTION_MAX_UNITS,
): string {
  let units = 0;
  let result = "";
  for (const char of text) {
    const cost = HAN_CHAR.test(char) ? 2 : 1;
    if (units + cost > maxUnits) break;
    units += cost;
    result += char;
  }
  return result;
}
