import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type AdventureVideoJob } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import type { AuditActor } from "@/modules/adventure-admin/adventure-audit.service";
import { assertReason } from "@/modules/adventure-admin/adventure-content.service";
import {
  buildVoiceSetVersion,
  type VideoStudioConfig,
  type VideoVoiceRole,
} from "@/config/video.config";
import {
  estimateTeaserCostCents,
  isSupportedResolution,
} from "./pricing/video-pricing";
import type {
  ApproveStoryboardDto,
  CreateVideoJobDto,
  StoryboardDraftDto,
  StoryboardRevoiceDto,
  StoryboardValidateDto,
  VideoJobQueryDto,
} from "./dto/video-job.dto";
import { ASSET_STORE, type AssetStore } from "./ports/media.ports";
import { packClipsByEstimate } from "./storyboard/clip-packing";
import {
  StoryboardValidationError,
  validateStoryboard,
} from "./storyboard/storyboard.validator";
import {
  computeVoiceTextHash,
  estimateBeatSeconds,
  STORYBOARD_MAX_TOTAL_SECONDS,
  STORYBOARD_MIN_TOTAL_SECONDS,
  type Storyboard,
  type StoryboardBeat,
  type StoryboardPayload,
} from "./storyboard/storyboard.types";
import { ClipPlanError, planClips } from "./worker/clip-planner";

const TEASER_SECONDS = 60;
const ESTIMATED_IMAGE_COUNT = 3;
const VOICE_ROLES: VideoVoiceRole[] = ["elly", "polly", "narrator"];

type VideoJobRecord = AdventureVideoJob;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const JOB_LIST_SELECT = {
  id: true,
  episodeId: true,
  episodeVersionId: true,
  businessKey: true,
  contentHash: true,
  kind: true,
  status: true,
  stage: true,
  aspect: true,
  resolution: true,
  renderer: true,
  ttsMode: true,
  voiceSetVersion: true,
  estimatedCostCents: true,
  actualCostCents: true,
  errorCode: true,
  errorMessage: true,
  attempts: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  assets: {
    where: { kind: "final_video" },
    select: { objectKey: true, bytes: true, durationSec: true },
    take: 1,
  },
} satisfies Prisma.AdventureVideoJobSelect;

function fail(code: string, message: string, extra: object = {}): never {
  throw new BadRequestException({ code, message, ...extra });
}

/** 预估 TTS 字符数：只数 payload 里的旁白/引导词，不数选项与兜底。 */
export function payloadCharCount(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const segments = (payload as { segments?: unknown }).segments;
  if (!Array.isArray(segments)) return 0;
  return segments.reduce((sum: number, item: unknown) => {
    const text = (item as { text?: unknown })?.text;
    return sum + (typeof text === "string" ? text.length : 0);
  }, 0);
}

@Injectable()
export class AdventureVideoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject(ASSET_STORE) private readonly store: AssetStore,
  ) {}

  get config(): VideoStudioConfig {
    const value = this.configService.get<VideoStudioConfig>("video");
    if (!value) {
      throw new ServiceUnavailableException({
        code: "VIDEO_CONFIG_MISSING",
        message:
          "短视频配置未加载，请检查 ConfigModule 是否注册了 video 配置。",
      });
    }
    return value;
  }

  private assertEnabled(): VideoStudioConfig {
    const config = this.config;
    if (!config.enabled) {
      throw new ServiceUnavailableException({
        code: "VIDEO_STUDIO_DISABLED",
        message: "短视频工作台在本环境未开启（ADVENTURE_VIDEO_ENABLED）。",
      });
    }
    return config;
  }

  async capabilities() {
    const config = this.config;
    const cloned = await this.loadClonedVoices();
    return {
      enabled: config.enabled,
      ttsMode: config.ttsMode,
      aspect: config.aspect,
      resolution: config.resolution,
      durationSec: TEASER_SECONDS,
      budgetCny: config.budgetCents / 100,
      voicesReady: config.ttsMode === "system" || cloned !== null,
      voiceRoles: VOICE_ROLES,
      reviewRequired: true,
      reviewWritable: true,
    };
  }

  async create(episodeId: string, dto: CreateVideoJobDto, actor: AuditActor) {
    const config = this.assertEnabled();
    const reason = assertReason(dto.reason);
    const resolution = dto.resolution ?? config.resolution;
    if (!isSupportedResolution(resolution)) {
      fail("UNSUPPORTED_RESOLUTION", `不支持的分辨率：${resolution}`);
    }
    const aspect = dto.aspect ?? config.aspect;
    if (aspect !== config.aspect) {
      fail(
        "UNSUPPORTED_ASPECT",
        `本期只支持 ${config.aspect} 竖屏，收到 ${aspect}`,
      );
    }

    const existing = await this.prisma.adventureVideoJob.findUnique({
      where: { requestId: dto.requestId },
    });
    if (existing) {
      if (existing.episodeId !== episodeId) {
        fail("REQUEST_ID_CONFLICT", "requestId 已被另一集占用，请刷新后重试。");
      }
      return { job: existing, reused: true };
    }

    const episode = await this.prisma.adventureEpisode.findUnique({
      where: { id: episodeId },
    });
    if (!episode) {
      throw new NotFoundException({
        code: "EPISODE_NOT_FOUND",
        message: "故事集不存在。",
      });
    }
    if (episode.retiredAt) {
      fail("EPISODE_RETIRED", "这一集已下架，不能生成短视频。");
    }
    if (!episode.published || !episode.currentVersionId) {
      fail("EPISODE_NOT_PUBLISHED", "只有已发布的故事才能生成故事短片。");
    }
    if (dto.episodeVersionId !== episode.currentVersionId) {
      fail(
        "VERSION_NOT_CURRENT",
        "只能对当前发布版本生成故事短片；历史版本请先回滚发布后再试。",
      );
    }

    const version = await this.prisma.adventureEpisodeVersion.findUnique({
      where: { id: episode.currentVersionId },
    });
    if (!version || version.status !== "published") {
      fail(
        "VERSION_NOT_PUBLISHED",
        "当前版本指针指向的快照不是 published 状态，请先检查内容工作台。",
      );
    }

    const voiceSetVersion = await this.resolveVoiceSetVersion(config);
    const ttsChars = payloadCharCount(version.payload);
    const estimate = estimateTeaserCostCents({
      durationSec: TEASER_SECONDS,
      resolution,
      ttsChars,
      ttsMode: config.ttsMode,
      imageCount: ESTIMATED_IMAGE_COUNT,
    });
    if (estimate.totalCents > config.budgetCents) {
      fail(
        "BUDGET_EXCEEDED",
        `预估 ${(estimate.totalCents / 100).toFixed(2)} 元，超过单支预算 ${(
          config.budgetCents / 100
        ).toFixed(2)} 元。请调整分辨率或预算配置。`,
        {
          estimatedCostCents: estimate.totalCents,
          budgetCents: config.budgetCents,
        },
      );
    }

    const businessKey = `${episode.characterKey}/${episode.season}/${episode.episodeNumber}`;
    const contentHash = version.contentHash ?? `version:${version.id}`;

    try {
      const job = await this.prisma.$transaction(async (tx) => {
        const created = await tx.adventureVideoJob.create({
          data: {
            episodeId,
            episodeVersionId: version.id,
            businessKey,
            contentHash,
            kind: "teaser",
            status: "queued",
            stage: "queued",
            aspect,
            resolution,
            renderer: "wan3.0-video",
            ttsMode: config.ttsMode,
            voiceSetVersion,
            requestId: dto.requestId,
            estimatedCostCents: estimate.totalCents,
            createdBy: actor.username,
            createdByName: actor.displayName,
          },
        });
        await tx.adventureContentAuditLog.create({
          data: {
            action: "video_generate",
            entityType: "episode_version",
            episodeId,
            episodeVersionId: version.id,
            businessKey,
            actorUsername: actor.username,
            actorDisplayName: actor.displayName,
            profile: actor.profile,
            reason,
            detail: {
              jobId: created.id,
              aspect,
              resolution,
              ttsMode: config.ttsMode,
              estimatedCostCents: estimate.totalCents,
              ttsChars,
            },
          },
        });
        return created;
      });
      return { job, reused: false };
    } catch (error) {
      // 并发同一个 requestId：唯一索引兜底，返回先到的那条。
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const raced = await this.prisma.adventureVideoJob.findUnique({
          where: { requestId: dto.requestId },
        });
        if (raced) return { job: raced, reused: true };
      }
      throw error;
    }
  }

  async list(query: VideoJobQueryDto = {}) {
    const limit = query.limit ?? 20;
    const where: Prisma.AdventureVideoJobWhereInput = {};
    if (query.episodeId) where.episodeId = query.episodeId;
    if (query.status) where.status = query.status;
    const items = await this.prisma.adventureVideoJob.findMany({
      where,
      select: JOB_LIST_SELECT,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return {
      items: items.map((item) => ({
        ...item,
        finalObjectKey: item.assets[0]?.objectKey ?? null,
        finalDurationSec: item.assets[0]?.durationSec ?? null,
        assets: undefined,
      })),
    };
  }

  async get(jobId: string) {
    const job = await this.prisma.adventureVideoJob.findUnique({
      where: { id: jobId },
      include: {
        shots: { orderBy: { order: "asc" } },
        assets: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!job) {
      throw new NotFoundException({
        code: "JOB_NOT_FOUND",
        message: "作业不存在。",
      });
    }
    const version = await this.prisma.adventureEpisodeVersion.findUnique({
      where: { id: job.episodeVersionId },
      select: { payload: true },
    });
    const payload = (version?.payload ?? {}) as unknown as StoryboardPayload;
    const storyboard = (job.storyboard ?? null) as unknown as Storyboard | null;
    const audioAssets = job.assets.filter((asset) => asset.kind === "audio");
    const audioByOrder = new Map<
      number,
      { order: number; durationSec: number; audioUrl: string | null }
    >();
    for (const asset of audioAssets) {
      const matched = /beat-(\d+)\.wav$/.exec(asset.objectKey);
      if (!matched) continue;
      const order = Number.parseInt(matched[1], 10);
      audioByOrder.set(order, {
        order,
        durationSec: asset.durationSec ?? 0,
        audioUrl: this.safeSignedUrl(asset.objectKey),
      });
    }
    const voiceBeats = [...audioByOrder.values()].sort(
      (left, right) => left.order - right.order,
    );
    const voiceReady = job.voiceTextHash !== null && job.voiceTotalSec !== null;
    const textMatches =
      storyboard !== null &&
      job.voiceTextHash !== null &&
      computeVoiceTextHash(storyboard.beats, job.voiceSetVersion) ===
        job.voiceTextHash;
    const estimate = storyboard
      ? {
          totalSec: storyboard.beats.reduce(
            (sum, beat) => sum + estimateBeatSeconds(beat.text),
            0,
          ),
          chars: storyboard.totalTextChars,
          clips: storyboard.clips.length,
        }
      : null;
    const voiceTotalSec = job.voiceTotalSec;
    const canApprove =
      job.status === "awaiting_review" &&
      voiceReady &&
      textMatches &&
      voiceTotalSec !== null &&
      voiceTotalSec >= STORYBOARD_MIN_TOTAL_SECONDS &&
      voiceTotalSec <= STORYBOARD_MAX_TOTAL_SECONDS;
    return {
      ...job,
      review: {
        revision: job.storyboardRevision,
        sourceSegments: Array.isArray(payload.segments)
          ? payload.segments.map((segment) => ({
              kind: segment.kind ?? null,
              text: segment.text ?? "",
            }))
          : [],
        estimate,
        voice: {
          ready: voiceReady,
          totalSec: voiceTotalSec,
          textMatches,
          beats: voiceBeats,
        },
        canApprove,
      },
    };
  }

  async validateStoryboardDraft(jobId: string, dto: StoryboardValidateDto) {
    const job = await this.requireReviewable(jobId);
    return this.buildDraft(job, dto.storyboard);
  }

  async saveStoryboard(
    jobId: string,
    dto: StoryboardDraftDto,
    actor: AuditActor,
  ) {
    const job = await this.requireReviewable(jobId);
    this.assertRevision(job.storyboardRevision, dto.expectedRevision);
    const draft = await this.buildDraft(job, dto.storyboard);
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.adventureVideoJob.update({
        where: { id: job.id },
        data: {
          storyboard: draft.storyboard as unknown as Prisma.InputJsonValue,
          storyboardRevision: { increment: 1 },
          storyboardApprovedAt: null,
          storyboardApprovedBy: null,
        },
      });
      await tx.adventureContentAuditLog.create({
        data: {
          action: "video_storyboard_edit",
          entityType: "episode_version",
          episodeId: job.episodeId,
          episodeVersionId: job.episodeVersionId,
          businessKey: job.businessKey,
          actorUsername: actor.username,
          actorDisplayName: actor.displayName,
          profile: actor.profile,
          reason: dto.reason ?? null,
          detail: {
            jobId: job.id,
            revision: next.storyboardRevision,
            chars: draft.estimate.chars,
            estimatedSec: Number(draft.estimate.totalSec.toFixed(2)),
          },
        },
      });
      return next;
    });
    return {
      job: updated,
      storyboard: draft.storyboard,
      revision: updated.storyboardRevision,
      estimate: draft.estimate,
    };
  }

  async revoiceStoryboard(
    jobId: string,
    dto: StoryboardRevoiceDto,
    actor: AuditActor,
  ) {
    const job = await this.requireReviewable(jobId);
    this.assertRevision(job.storyboardRevision, dto.expectedRevision);
    if (!job.storyboard) {
      fail("STORYBOARD_MISSING", "当前作业没有可重新配音的分镜。");
    }
    const reason = assertReason(dto.reason);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.adventureVideoAsset.deleteMany({
        where: { jobId: job.id, kind: "audio" },
      });
      const next = await tx.adventureVideoJob.update({
        where: { id: job.id },
        data: {
          status: "queued",
          stage: "queued",
          storyboardApprovedAt: null,
          storyboardApprovedBy: null,
          voiceTextHash: null,
          voiceTotalSec: null,
          heartbeatAt: null,
          startedAt: null,
          finishedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      await tx.adventureContentAuditLog.create({
        data: {
          action: "video_storyboard_revoice",
          entityType: "episode_version",
          episodeId: job.episodeId,
          episodeVersionId: job.episodeVersionId,
          businessKey: job.businessKey,
          actorUsername: actor.username,
          actorDisplayName: actor.displayName,
          profile: actor.profile,
          reason,
          detail: { jobId: job.id, revision: job.storyboardRevision },
        },
      });
      return next;
    });
    return { job: updated };
  }

  async regenerateStoryboard(
    jobId: string,
    dto: StoryboardRevoiceDto,
    actor: AuditActor,
  ) {
    const job = await this.requireReviewable(jobId);
    const reason = assertReason(dto.reason);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.adventureVideoAsset.deleteMany({
        where: { jobId: job.id, kind: "audio" },
      });
      const next = await tx.adventureVideoJob.update({
        where: { id: job.id },
        data: {
          storyboard: Prisma.JsonNull,
          storyboardRevision: { increment: 1 },
          storyboardApprovedAt: null,
          storyboardApprovedBy: null,
          voiceTextHash: null,
          voiceTotalSec: null,
          status: "queued",
          stage: "queued",
          heartbeatAt: null,
          startedAt: null,
          finishedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      await tx.adventureContentAuditLog.create({
        data: {
          action: "video_storyboard_regenerate",
          entityType: "episode_version",
          episodeId: job.episodeId,
          episodeVersionId: job.episodeVersionId,
          businessKey: job.businessKey,
          actorUsername: actor.username,
          actorDisplayName: actor.displayName,
          profile: actor.profile,
          reason,
          detail: { jobId: job.id, revision: next.storyboardRevision },
        },
      });
      return next;
    });
    return { job: updated };
  }

  async approveStoryboard(
    jobId: string,
    dto: ApproveStoryboardDto,
    actor: AuditActor,
  ) {
    const job = await this.requireReviewable(jobId);
    this.assertRevision(job.storyboardRevision, dto.expectedRevision);
    const reason = assertReason(dto.reason);
    const storyboard = (job.storyboard ?? null) as unknown as Storyboard | null;
    if (!storyboard) {
      fail("STORYBOARD_MISSING", "当前作业没有可审批的分镜。");
    }
    const version = await this.prisma.adventureEpisodeVersion.findUnique({
      where: { id: job.episodeVersionId },
      select: { payload: true },
    });
    const payload = (version?.payload ?? {}) as unknown as StoryboardPayload;
    const normalized = this.validateOrThrow(storyboard, payload, job);
    const currentHash = computeVoiceTextHash(
      normalized.beats,
      job.voiceSetVersion,
    );
    if (!job.voiceTextHash || job.voiceTextHash !== currentHash) {
      throw new ConflictException({
        code: "VOICE_STALE",
        message: "文案已修改但音频未重新生成，请先重新配音再审批。",
      });
    }
    const audioAssets = await this.prisma.adventureVideoAsset.findMany({
      where: { jobId: job.id, kind: "audio" },
      orderBy: { createdAt: "desc" },
    });
    const durationByOrder = new Map<number, number>();
    for (const asset of audioAssets) {
      const matched = /beat-(\d+)\.wav$/.exec(asset.objectKey);
      if (!matched) continue;
      const order = Number.parseInt(matched[1], 10);
      if (!durationByOrder.has(order) && asset.durationSec !== null) {
        durationByOrder.set(order, asset.durationSec);
      }
    }
    let plan: ReturnType<typeof planClips>;
    try {
      plan = planClips(
        normalized.beats.map((beat) => {
          const duration = durationByOrder.get(beat.order);
          if (duration === undefined) {
            throw new ConflictException({
              code: "VOICE_ASSET_MISSING",
              message: `beat ${beat.order} 的音频不存在，请重新配音。`,
            });
          }
          return {
            beatOrder: beat.order,
            text: beat.text,
            audioDurationSec: duration,
            optional: beat.optional,
          };
        }),
      );
    } catch (error) {
      if (error instanceof ClipPlanError) {
        if (error.code === "OVER_BUDGET") {
          const actualSec =
            normalized.beats.reduce(
              (sum, beat) => sum + (durationByOrder.get(beat.order) ?? 0),
              0,
            ) +
            normalized.beats.length * 0.35;
          throw new ConflictException({
            code: "VOICE_TOO_LONG",
            message: `实测旁白 ${actualSec.toFixed(1)} 秒，超过 ${STORYBOARD_MAX_TOTAL_SECONDS} 秒，请删减后重新配音。`,
            actualSec,
          });
        }
        throw new ConflictException({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
    if (plan.totalSec < STORYBOARD_MIN_TOTAL_SECONDS) {
      throw new ConflictException({
        code: "VOICE_TOO_SHORT",
        message: `实测旁白 ${plan.totalSec.toFixed(1)} 秒，低于 ${STORYBOARD_MIN_TOTAL_SECONDS} 秒，请补文案后重新配音。`,
        actualSec: plan.totalSec,
      });
    }
    if (plan.totalSec > STORYBOARD_MAX_TOTAL_SECONDS) {
      throw new ConflictException({
        code: "VOICE_TOO_LONG",
        message: `实测旁白 ${plan.totalSec.toFixed(1)} 秒，超过 ${STORYBOARD_MAX_TOTAL_SECONDS} 秒，请删减后重新配音。`,
        actualSec: plan.totalSec,
      });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.adventureVideoJob.update({
        where: { id: job.id },
        data: {
          storyboard: normalized as unknown as Prisma.InputJsonValue,
          status: "queued",
          stage: "queued",
          storyboardApprovedAt: new Date(),
          storyboardApprovedBy: actor.username,
          heartbeatAt: null,
          startedAt: null,
          finishedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      await tx.adventureContentAuditLog.create({
        data: {
          action: "video_storyboard_approve",
          entityType: "episode_version",
          episodeId: job.episodeId,
          episodeVersionId: job.episodeVersionId,
          businessKey: job.businessKey,
          actorUsername: actor.username,
          actorDisplayName: actor.displayName,
          profile: actor.profile,
          reason,
          detail: {
            jobId: job.id,
            revision: job.storyboardRevision,
            actualSec: Number(plan.totalSec.toFixed(2)),
            droppedBeatOrders: plan.droppedBeatOrders,
          },
        },
      });
      return next;
    });
    return {
      job: updated,
      plan: {
        totalSec: plan.totalSec,
        droppedBeatOrders: plan.droppedBeatOrders,
      },
    };
  }

  /**
   * 成片播放地址：私有桶，按需现签，不把 URL 落库。
   * 没有成片（还在跑/失败）返回 404；OSS 未配置返回 503，前端按可操作提示展示。
   */
  async previewUrl(jobId: string) {
    const job = await this.prisma.adventureVideoJob.findUnique({
      where: { id: jobId },
      select: { id: true },
    });
    if (!job) {
      throw new NotFoundException({
        code: "JOB_NOT_FOUND",
        message: "作业不存在。",
      });
    }
    const asset = await this.prisma.adventureVideoAsset.findFirst({
      where: { jobId, kind: "final_video" },
      orderBy: { createdAt: "desc" },
    });
    if (!asset) {
      throw new NotFoundException({
        code: "PREVIEW_NOT_READY",
        message: "还没有成片。",
      });
    }
    try {
      return {
        url: this.store.signedUrl(asset.objectKey),
        expiresInSec: this.config.oss.signedUrlTtlSec,
      };
    } catch (error) {
      throw new ServiceUnavailableException({
        code: "OSS_NOT_CONFIGURED",
        message:
          error instanceof Error
            ? error.message
            : "OSS 未配置，无法生成播放地址。",
      });
    }
  }

  /** 下载地址与播放地址分开：跨域 `<a download>` 会被浏览器忽略，必须由 OSS 返回 attachment。 */
  async downloadUrl(jobId: string) {
    const job = await this.prisma.adventureVideoJob.findUnique({
      where: { id: jobId },
      select: { id: true, businessKey: true },
    });
    if (!job) {
      throw new NotFoundException({
        code: "JOB_NOT_FOUND",
        message: "作业不存在。",
      });
    }
    const asset = await this.prisma.adventureVideoAsset.findFirst({
      where: { jobId, kind: "final_video" },
      orderBy: { createdAt: "desc" },
    });
    if (!asset) {
      throw new NotFoundException({
        code: "PREVIEW_NOT_READY",
        message: "还没有成片。",
      });
    }
    const filename = `${job.businessKey.replace(/[^A-Za-z0-9_-]+/g, "-")}-story.mp4`;
    try {
      return {
        url: this.store.signedUrl(asset.objectKey, undefined, {
          "content-disposition": `attachment; filename="${filename}"`,
        }),
        expiresInSec: this.config.oss.signedUrlTtlSec,
        filename,
      };
    } catch (error) {
      throw new ServiceUnavailableException({
        code: "OSS_NOT_CONFIGURED",
        message:
          error instanceof Error
            ? error.message
            : "OSS 未配置，无法生成下载地址。",
      });
    }
  }

  async retry(jobId: string, actor: AuditActor, reasonInput?: string) {
    this.assertEnabled();
    const reason = assertReason(reasonInput);
    const job = await this.prisma.adventureVideoJob.findUnique({
      where: { id: jobId },
    });
    if (!job) {
      throw new NotFoundException({
        code: "JOB_NOT_FOUND",
        message: "作业不存在。",
      });
    }
    if (job.status !== "failed" && job.status !== "canceled") {
      fail("JOB_NOT_RETRYABLE", "只有失败或已取消的作业可以重试。");
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.adventureVideoJob.update({
        where: { id: jobId },
        data: {
          status: "queued",
          stage: "queued",
          errorCode: null,
          errorMessage: null,
          heartbeatAt: null,
          startedAt: null,
          finishedAt: null,
          attempts: { increment: 1 },
        },
      });
      await tx.adventureContentAuditLog.create({
        data: {
          action: "video_retry",
          entityType: "episode_version",
          episodeId: job.episodeId,
          episodeVersionId: job.episodeVersionId,
          businessKey: job.businessKey,
          actorUsername: actor.username,
          actorDisplayName: actor.displayName,
          profile: actor.profile,
          reason,
          detail: { jobId, previousAttempts: job.attempts },
        },
      });
      return next;
    });
    return { job: updated };
  }

  async cancel(jobId: string, actor: AuditActor, reasonInput?: string) {
    this.assertEnabled();
    const reason = assertReason(reasonInput);
    const job = await this.prisma.adventureVideoJob.findUnique({
      where: { id: jobId },
    });
    if (!job) {
      throw new NotFoundException({
        code: "JOB_NOT_FOUND",
        message: "作业不存在。",
      });
    }
    if (!["queued", "running", "awaiting_review"].includes(job.status)) {
      fail("JOB_NOT_CANCELABLE", "只有排队中、运行中或待审核的作业可以取消。");
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.adventureVideoJob.update({
        where: { id: jobId },
        data: {
          status: "canceled",
          stage: "canceled",
          finishedAt: new Date(),
        },
      });
      await tx.adventureContentAuditLog.create({
        data: {
          action: "video_cancel",
          entityType: "episode_version",
          episodeId: job.episodeId,
          episodeVersionId: job.episodeVersionId,
          businessKey: job.businessKey,
          actorUsername: actor.username,
          actorDisplayName: actor.displayName,
          profile: actor.profile,
          reason,
          detail: { jobId, previousStatus: job.status },
        },
      });
      return next;
    });
    return { job: updated };
  }

  private async requireReviewable(jobId: string): Promise<VideoJobRecord> {
    const job = await this.prisma.adventureVideoJob.findUnique({
      where: { id: jobId },
    });
    if (!job) {
      throw new NotFoundException({
        code: "JOB_NOT_FOUND",
        message: "作业不存在。",
      });
    }
    if (job.status !== "awaiting_review") {
      throw new ConflictException({
        code: "JOB_NOT_REVIEWABLE",
        message: "只有待审核状态的作业可以编辑或审批分镜。",
      });
    }
    return job;
  }

  private assertRevision(current: number, expected: number): void {
    if (current !== expected) {
      throw new ConflictException({
        code: "STORYBOARD_CONFLICT",
        message: "分镜已被其他人修改，请刷新后重试。",
        currentRevision: current,
      });
    }
  }

  private async buildDraft(
    job: VideoJobRecord,
    raw: unknown,
  ): Promise<{
    storyboard: Storyboard;
    estimate: { totalSec: number; chars: number; clips: number };
  }> {
    const existing = (job.storyboard ?? null) as unknown as Storyboard | null;
    if (!existing) {
      fail("STORYBOARD_MISSING", "当前作业还没有分镜，请先重新生成。");
    }
    if (!isRecord(raw)) {
      fail("STORYBOARD_TYPE", "storyboard 必须是对象");
    }
    const rawBeats = raw.beats;
    if (!Array.isArray(rawBeats)) {
      fail("STORYBOARD_BEATS", "beats 必须是数组", { path: "beats" });
    }
    if (rawBeats.length !== existing.beats.length) {
      fail(
        "STORYBOARD_STRUCTURE_LOCKED",
        "beat 数量与顺序已锁定；结构不对请点「重新生成分镜」。",
        { path: "beats" },
      );
    }
    const beats = existing.beats.map((beat, index) => {
      const input = isRecord(rawBeats[index]) ? rawBeats[index] : null;
      if (!input) {
        fail("STORYBOARD_TYPE", `beats[${index}] 必须是对象`, {
          path: `beats[${index}]`,
        });
      }
      if (input.order !== index) {
        fail(
          "STORYBOARD_STRUCTURE_LOCKED",
          `beats[${index}].order 必须保持为 ${index}`,
          { path: `beats[${index}].order` },
        );
      }
      if (
        input.speaker !== beat.speaker ||
        !sameJson(input.characters, beat.characters) ||
        !sameJson(input.sourceSegmentOrders, beat.sourceSegmentOrders)
      ) {
        fail(
          "STORYBOARD_STRUCTURE_LOCKED",
          "只允许改文案/画面/情绪/optional；说话角色、角色集合与原文溯源已锁定。",
          { path: `beats[${index}]` },
        );
      }
      return {
        ...beat,
        text: input.text,
        emotion: input.emotion,
        shot: input.shot,
        visualPrompt: input.visualPrompt,
        optional: input.optional,
      } as unknown as StoryboardBeat;
    });
    const version = await this.prisma.adventureEpisodeVersion.findUnique({
      where: { id: job.episodeVersionId },
      select: { payload: true },
    });
    const payload = (version?.payload ?? {}) as unknown as StoryboardPayload;
    const clips = packClipsByEstimate(
      beats.map((beat) => ({
        order: beat.order,
        text: typeof beat.text === "string" ? beat.text : "",
      })),
    );
    const storyboard = this.validateOrThrow(
      { stylePrompt: raw.stylePrompt, beats, clips },
      payload,
      job,
    );
    return {
      storyboard,
      estimate: {
        totalSec: storyboard.beats.reduce(
          (sum, beat) => sum + estimateBeatSeconds(beat.text),
          0,
        ),
        chars: storyboard.totalTextChars,
        clips: storyboard.clips.length,
      },
    };
  }

  private validateOrThrow(
    input: unknown,
    payload: StoryboardPayload,
    job: Pick<
      VideoJobRecord,
      | "businessKey"
      | "episodeVersionId"
      | "contentHash"
      | "aspect"
      | "resolution"
    >,
  ): Storyboard {
    try {
      return validateStoryboard(
        input,
        payload,
        {
          title: payload.title ?? "故事短片",
          businessKey: job.businessKey,
          episodeVersionId: job.episodeVersionId,
          contentHash: job.contentHash,
          aspect: job.aspect,
          resolution: job.resolution,
        },
        {
          forbiddenWords: this.config.lintForbiddenWords,
        },
      );
    } catch (error) {
      if (error instanceof StoryboardValidationError) {
        throw new BadRequestException({
          code: error.code,
          message: error.message,
          path: error.path,
        });
      }
      throw error;
    }
  }

  private safeSignedUrl(objectKey: string): string | null {
    try {
      return this.store.signedUrl(objectKey, 3600);
    } catch {
      return null;
    }
  }

  /**
   * 复刻模式必须三条音色齐全且 ready；系统模式直接用配置里的试跑音色。
   * 缺音色时 job 在创建阶段就失败，不消耗任何视频调用费用。
   */
  private async resolveVoiceSetVersion(
    config: VideoStudioConfig,
  ): Promise<string> {
    if (config.ttsMode === "system") {
      return buildVoiceSetVersion("system", config.systemVoices);
    }
    const cloned = await this.loadClonedVoices();
    if (!cloned) {
      fail(
        "VOICE_NOT_READY",
        "复刻音色尚未就绪：请先跑 scripts/clone-adventure-video-voices.ts 并确认三条角色音色状态为 ready。",
      );
    }
    return buildVoiceSetVersion("cloned", cloned);
  }

  private async loadClonedVoices(): Promise<Record<
    VideoVoiceRole,
    string
  > | null> {
    const rows = await this.prisma.adventureVideoVoice.findMany({
      where: { role: { in: VOICE_ROLES } },
    });
    const ready = new Map(
      rows
        .filter((row) => row.status === "ready")
        .map((row) => [row.role, row.voiceId]),
    );
    if (!VOICE_ROLES.every((role) => ready.has(role))) return null;
    return {
      elly: ready.get("elly")!,
      polly: ready.get("polly")!,
      narrator: ready.get("narrator")!,
    };
  }
}
