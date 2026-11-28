/**
 * 供应商边界：worker 只依赖这些接口，不直接依赖 axios 或具体模型。
 * 失败统一成 ProviderError，worker 按 retryable 决定「同参重试」还是「换模型」。
 */

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface VideoSubmitInput {
  model: string;
  prompt: string;
  /** 角色参考图公网 URL（签名后） */
  referenceImageUrls: string[];
  resolution: string;
  ratio: string;
  durationSec: number;
  seed: number;
  /** 一律 false：台词以我方 TTS 为准 */
  audio: boolean;
}

export interface VideoTaskState {
  status: "pending" | "running" | "succeeded" | "failed";
  videoUrl?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface SpeechInput {
  model: string;
  voice: string;
  text: string;
  rate?: number;
  instruction?: string;
  format?: "mp3" | "wav";
  sampleRate?: number;
}

export interface SpeechResult {
  audioUrl: string;
  characters: number;
}

export interface HttpTransport {
  post(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<unknown>;
  get(url: string): Promise<unknown>;
  getBuffer(url: string): Promise<Buffer>;
}

export const HTTP_TRANSPORT = Symbol("HTTP_TRANSPORT");

export const BAILIAN_REGION = "cn-beijing";
