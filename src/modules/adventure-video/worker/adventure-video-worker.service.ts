import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import { PromptRegistryService } from "@/modules/prompt-registry/prompt-registry.service";
import type { VideoStudioConfig, VideoVoiceRole } from "@/config/video.config";
import {
  estimateTeaserCostCents,
  ttsModelForMode,
} from "../pricing/video-pricing";
import {
  StoryboardValidationError,
  validateStoryboard,
} from "../storyboard/storyboard.validator";
import {
  buildStoryboardUserPrompt,
  extractJsonObject,
} from "../storyboard/storyboard.prompt";
import type {
  Storyboard,
  StoryboardPayload,
  VideoEmotion,
} from "../storyboard/storyboard.types";
import { ClipPlanError, planClips } from "./clip-planner";
import { buildClipPrompt, buildClipSeed } from "./video-prompt";
import {
  ASSET_STORE,
  MEDIA_ASSEMBLER,
  type AssetStore,
  type MediaAssembler,
} from "../ports/media.ports";
import { AdventureVideoQueueService } from "../adventure-video-queue.service";
import { BailianSpeechClient } from "../providers/bailian-speech.client";
import { BailianVideoClient } from "../providers/bailian-video.client";
import {
  HTTP_TRANSPORT,
  ProviderError,
  type HttpTransport,
} from "../providers/provider.types";
import { FfmpegError } from "../assembly/ffmpeg-media.assembler";
import { AssetStoreError } from "../storage/oss-asset-store";

const VOICE_ROLES: VideoVoiceRole[] = ["elly", "polly", "narrator"];
const VIDEO_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const STORYBOARD_ATTEMPTS = 2;

const EMOTION_INSTRUCTION: Record<VideoEmotion, string> = {
  calm: "语气平静，语速稍慢，像睡前故事",
  curious: "带着好奇和期待，尾音上扬",
  excited: "明亮兴奋，但不要喊叫",
  gentle: "温柔轻声，贴近耳朵说话的感觉",
  tense: "压低声音，制造一点悬念",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string {
  if (error instanceof StoryboardValidationError) return error.code;
  if (error instanceof ClipPlanError) return error.code;
  if (error instanceof ProviderError) return error.code;
  if (error instanceof FfmpegError) return error.code;
  if (error instanceof AssetStoreError) return error.code;
  return "WORKER_ERROR";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 60 秒完整故事短片流水线（受控压缩：忠于原文讲完开端→经过→结局）。
 *
 * 顺序是硬约束：分镜 → TTS → 量真实时长 → 切段 → 视频 → 合成。
 * 先出音再出画，画面时间戳才跟旁白一致；反过来做一定会出现「话说完了镜头还在走」。
 *
 * 失败处理：任何一步抛错都由 runOnce 落成 failed + 领域码，已完成的中间产物
 * 留在 OSS 里，重试时按 objectKey 命中即可复用（本版先不读缓存，留好键位）。
 */
@Injectable()
export class AdventureVideoWorkerService {
  private readonly logger = new Logger(AdventureVideoWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: AdventureVideoQueueService,
    private readonly video: BailianVideoClient,
    private readonly speech: BailianSpeechClient,
    private readonly llm: LlmService,
    private readonly promptRegistry: PromptRegistryService,
    @Inject(HTTP_TRANSPORT) private readonly http: HttpTransport,
    @Inject(ASSET_STORE) private readonly store: AssetStore,
    @Inject(MEDIA_ASSEMBLER) private readonly assembler: MediaAssembler,
    private readonly configService: ConfigService,
  ) {}

  /** 领一条并跑完；没有任务返回 false，供 runner 决定是否继续轮询。 */
  async runOnce(): Promise<boolean> {
    const claimed = await this.queue.claimNext();
    if (!claimed) return false;
    try {
      await this.process(claimed.id);
    } catch (error) {
      this.logger.warn(
        `视频作业失败 job=${claimed.id} code=${errorCode(error)}: ${errorMessage(error)}`,
      );
      await this.queue.fail(claimed.id, errorCode(error), errorMessage(error));
    }
    return true;
  }

  async process(jobId: string): Promise<void> {
    const config = this.config();
    const job = await this.prisma.adventureVideoJob.findUnique({
      where: { id: jobId },
    });
    if (!job) throw new Error(`作业不存在：${jobId}`);
    if (!config.enabled) throw new Error("短视频开关已关闭，拒绝执行");

    const version = await this.prisma.adventureEpisodeVersion.findUnique({
      where: { id: job.episodeVersionId },
    });
    if (!version) throw new Error(`版本快照不存在：${job.episodeVersionId}`);
    const payload = (version.payload ?? {}) as unknown as StoryboardPayload;
    const voices = await this.resolveVoices(config);

    const storyboard = await this.generateStoryboard(job, payload, config);
    await this.prisma.adventureVideoJob.update({
      where: { id: job.id },
      data: { storyboard: storyboard as unknown as Prisma.InputJsonValue },
    });

    await this.queue.markStage(job.id, "voice");
    const voiced = await this.synthesizeBeats(job, storyboard, voices, config);

    await this.queue.markStage(job.id, "visual");
    const plan = planClips(
      voiced.map((item) => ({
        beatOrder: item.beat.order,
        text: item.beat.text,
        audioDurationSec: item.durationSec,
        optional: item.beat.optional,
      })),
    );

    const referenceUrls = this.referenceUrls(config, storyboard);
    const clipResults: Array<{ buffer: Buffer; durationSec: number }> = [];
    let clipOffset = 0;
    for (const clip of plan.clips) {
      const beats = clip.beats.map((planned) => {
        const source = voiced.find(
          (item) => item.beat.order === planned.beatOrder,
        );
        if (!source) throw new Error(`缺少旁白：beat ${planned.beatOrder}`);
        return { planned, source };
      });
      const prompt = buildClipPrompt({
        stylePrompt: storyboard.stylePrompt,
        characterKey: job.businessKey.split("/")[0],
        beats: beats.map(({ planned, source }) => ({
          startSec: planned.startSec,
          endSec: planned.endSec,
          shot: source.beat.shot,
          visualPrompt: source.beat.visualPrompt,
        })),
      });
      const seed = buildClipSeed(job.id, clip.order);
      const taskId = await this.video.submit({
        model: job.renderer,
        prompt,
        referenceImageUrls: referenceUrls,
        resolution: job.resolution,
        ratio: job.aspect,
        durationSec: Math.max(2, Math.min(30, Math.ceil(clip.durationSec))),
        seed,
        audio: false,
      });
      const videoUrl = await this.waitForVideo(taskId, job.id, config);
      const buffer = await this.download(videoUrl);
      const probed = await this.assembler.probe(buffer);
      const objectKey = `adventure-video/jobs/${job.businessKey}/${job.contentHash}/${job.id}/clips/clip-${clip.order}.mp4`;
      const stored = await this.store.put(objectKey, buffer, "video/mp4");
      await this.prisma.adventureVideoAsset.create({
        data: {
          jobId: job.id,
          kind: "clip",
          objectKey: stored.objectKey,
          bytes: stored.bytes,
          durationSec: probed.durationSec || clip.durationSec,
          sha256: stored.sha256,
        },
      });
      clipResults.push({
        buffer,
        durationSec: probed.durationSec || clip.durationSec,
      });
      clipOffset += clip.durationSec;
    }

    await this.queue.markStage(job.id, "assemble");
    const absoluteBeats = plan.clips.flatMap((clip, clipIndex) => {
      const offset = plan.clips
        .slice(0, clipIndex)
        .reduce((sum, item) => sum + item.durationSec, 0);
      return clip.beats.map((planned) => {
        const source = voiced.find(
          (item) => item.beat.order === planned.beatOrder,
        )!;
        return {
          buffer: source.buffer,
          startSec: offset + planned.startSec,
          endSec: offset + planned.endSec,
          text: source.beat.text,
        };
      });
    });

    const assembled = await this.assembler.assemble({
      clips: clipResults,
      beats: absoluteBeats.map((beat) => ({
        buffer: beat.buffer,
        startSec: beat.startSec,
      })),
      cues: absoluteBeats.map((beat) => ({
        startSec: beat.startSec,
        endSec: beat.endSec,
        text: beat.text,
      })),
      totalDurationSec: clipOffset,
      aspect: job.aspect,
      resolution: job.resolution,
    });

    await this.queue.markStage(job.id, "upload");
    const finalKey = `adventure-video/jobs/${job.businessKey}/${job.contentHash}/${job.id}/final/final.mp4`;
    const finalStored = await this.store.put(
      finalKey,
      assembled.buffer,
      "video/mp4",
    );
    const srtStored = await this.store.put(
      `adventure-video/jobs/${job.businessKey}/${job.contentHash}/${job.id}/final/final.srt`,
      Buffer.from(assembled.srt, "utf8"),
      "application/x-subrip",
    );
    await this.prisma.adventureVideoAsset.createMany({
      data: [
        {
          jobId: job.id,
          kind: "final_video",
          objectKey: finalStored.objectKey,
          bytes: finalStored.bytes,
          durationSec: assembled.durationSec,
          sha256: finalStored.sha256,
        },
        {
          jobId: job.id,
          kind: "srt",
          objectKey: srtStored.objectKey,
          bytes: srtStored.bytes,
          durationSec: null,
          sha256: srtStored.sha256,
        },
      ],
    });

    const cost = estimateTeaserCostCents({
      durationSec: plan.totalSec,
      resolution: job.resolution,
      ttsChars: voiced.reduce((sum, item) => sum + item.characters, 0),
      ttsMode: (job.ttsMode as "system" | "cloned") ?? config.ttsMode,
      imageCount: 0,
    });
    await this.queue.succeed(job.id, { actualCostCents: cost.totalCents });
  }

  private async generateStoryboard(
    job: {
      businessKey: string;
      episodeVersionId: string;
      contentHash: string;
      aspect: string;
      resolution: string;
    },
    payload: StoryboardPayload,
    config: VideoStudioConfig,
  ): Promise<Storyboard> {
    const envelope = {
      title: payload.title ?? "故事短片",
      businessKey: job.businessKey,
      episodeVersionId: job.episodeVersionId,
      contentHash: job.contentHash,
      aspect: job.aspect,
      resolution: job.resolution,
    };
    const basePrompt = buildStoryboardUserPrompt({
      title: envelope.title,
      recap: payload.recap,
      characterKey: job.businessKey.split("/")[0],
      payload,
    });
    let lastError: unknown = null;
    for (let attempt = 0; attempt < STORYBOARD_ATTEMPTS; attempt += 1) {
      const userPrompt =
        attempt === 0
          ? basePrompt
          : `${basePrompt}\n\n上一次输出被程序拒绝：${errorMessage(
              lastError,
            )}。请严格按规则修正后重新输出完整 JSON。`;
      const result = await this.llm.complete({
        scene: "adventure_video_storyboard",
        messages: [
          {
            role: "system",
            content: this.promptRegistry.render(
              "adventure_video_storyboard_system",
            ),
          },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.4,
        maxTokens: 4000,
        thinking: { type: "disabled" },
      });
      try {
        return validateStoryboard(
          extractJsonObject(result.text),
          payload,
          envelope,
          { forbiddenWords: config.lintForbiddenWords },
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("分镜生成失败");
  }

  private async synthesizeBeats(
    job: { id: string; businessKey: string; contentHash: string },
    storyboard: Storyboard,
    voices: Record<VideoVoiceRole, string>,
    config: VideoStudioConfig,
  ): Promise<
    Array<{
      beat: Storyboard["beats"][number];
      buffer: Buffer;
      durationSec: number;
      characters: number;
    }>
  > {
    const model = ttsModelForMode(config.ttsMode);
    const results: Array<{
      beat: Storyboard["beats"][number];
      buffer: Buffer;
      durationSec: number;
      characters: number;
    }> = [];
    for (const beat of storyboard.beats) {
      const speech = await this.speech.synthesize({
        model,
        voice: voices[beat.speaker],
        text: beat.text,
        instruction: EMOTION_INSTRUCTION[beat.emotion],
        format: "wav",
        sampleRate: 24000,
      });
      const buffer = await this.download(speech.audioUrl);
      const probed = await this.assembler.probe(buffer);
      const objectKey = `adventure-video/jobs/${job.businessKey}/${job.contentHash}/${job.id}/audio/beat-${beat.order}.wav`;
      const stored = await this.store.put(objectKey, buffer, "audio/wav");
      await this.prisma.adventureVideoAsset.create({
        data: {
          jobId: job.id,
          kind: "audio",
          objectKey: stored.objectKey,
          bytes: stored.bytes,
          durationSec: probed.durationSec,
          sha256: stored.sha256,
        },
      });
      results.push({
        beat,
        buffer,
        durationSec: probed.durationSec,
        characters: speech.characters,
      });
    }
    return results;
  }

  private async waitForVideo(
    taskId: string,
    jobId: string,
    config: VideoStudioConfig,
  ): Promise<string> {
    const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await this.video.poll(taskId);
      if (state.status === "succeeded" && state.videoUrl) {
        return state.videoUrl;
      }
      if (state.status === "failed") {
        throw new ProviderError(
          "bailian-video",
          state.errorCode ?? "TASK_FAILED",
          state.errorMessage ?? "视频任务失败",
          true,
        );
      }
      await sleep(config.pollIntervalMs);
      await this.queue.heartbeat(jobId);
    }
    throw new ProviderError(
      "bailian-video",
      "TASK_TIMEOUT",
      `视频任务超时：${taskId}`,
      true,
    );
  }

  private async download(url: string): Promise<Buffer> {
    // 供应商返回的 URL 只有 24 小时，必须立刻拉回本地再转存 OSS。
    return this.http.getBuffer(url);
  }

  private referenceUrls(
    config: VideoStudioConfig,
    storyboard: Storyboard,
  ): string[] {
    const used = new Set(storyboard.beats.flatMap((beat) => beat.characters));
    const keys: string[] = [];
    if (used.has("elly") && config.referenceKeys.elly) {
      keys.push(config.referenceKeys.elly);
    }
    if (used.has("polly") && config.referenceKeys.polly) {
      keys.push(config.referenceKeys.polly);
    }
    return keys.map((key) => this.store.signedUrl(key, 24 * 3600));
  }

  private async resolveVoices(
    config: VideoStudioConfig,
  ): Promise<Record<VideoVoiceRole, string>> {
    if (config.ttsMode === "system") return config.systemVoices;
    const rows = await this.prisma.adventureVideoVoice.findMany({
      where: { role: { in: VOICE_ROLES } },
    });
    const ready = new Map(
      rows
        .filter((row) => row.status === "ready")
        .map((row) => [row.role, row.voiceId]),
    );
    if (!VOICE_ROLES.every((role) => ready.has(role))) {
      throw new ProviderError(
        "voice",
        "VOICE_NOT_READY",
        "复刻音色未就绪",
        false,
      );
    }
    return {
      elly: ready.get("elly")!,
      polly: ready.get("polly")!,
      narrator: ready.get("narrator")!,
    };
  }

  private config(): VideoStudioConfig {
    const config = this.configService.get<VideoStudioConfig>("video");
    if (!config) throw new Error("video 配置未加载");
    return config;
  }
}
