/**
 * 存储与合成端口。
 *
 * worker 只依赖接口：真实实现是 OSS + ffmpeg，测试用内存实现。
 * 这样「流水线逻辑」可以在没有网络、没有 ffmpeg 的 CI 里全量跑。
 */

export interface PutResult {
  objectKey: string;
  bytes: number;
  sha256: string;
}

export interface AssetStore {
  put(objectKey: string, body: Buffer, contentType: string): Promise<PutResult>;
  /** 读回已存对象；审批后的音频复用需要它 */
  get(objectKey: string): Promise<Buffer>;
  /** 私有桶签名 URL；同步签名，供拼 prompt 与前端播放使用 */
  signedUrl(
    objectKey: string,
    ttlSec?: number,
    response?: Record<string, string>,
  ): string;
}

export interface ProbeResult {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export interface AssembleClip {
  buffer: Buffer;
  durationSec: number;
}

export interface AssembleBeat {
  buffer: Buffer;
  startSec: number;
}

export interface AssembleCue {
  startSec: number;
  endSec: number;
  text: string;
}

export interface AssembleInput {
  clips: AssembleClip[];
  beats: AssembleBeat[];
  cues: AssembleCue[];
  totalDurationSec: number;
  aspect: string;
  resolution: string;
}

export interface AssembleResult {
  buffer: Buffer;
  durationSec: number;
  srt: string;
}

export interface MediaAssembler {
  probe(buffer: Buffer): Promise<ProbeResult>;
  assemble(input: AssembleInput): Promise<AssembleResult>;
}

export const ASSET_STORE = Symbol("ADVENTURE_VIDEO_ASSET_STORE");
export const MEDIA_ASSEMBLER = Symbol("ADVENTURE_VIDEO_MEDIA_ASSEMBLER");
