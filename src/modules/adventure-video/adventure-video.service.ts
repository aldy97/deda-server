import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
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
import type { CreateVideoJobDto, VideoJobQueryDto } from "./dto/video-job.dto";
import { ASSET_STORE, type AssetStore } from "./ports/media.ports";

const TEASER_SECONDS = 60;
const ESTIMATED_IMAGE_COUNT = 3;
const VOICE_ROLES: VideoVoiceRole[] = ["elly", "polly", "narrator"];

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
    return job;
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
    if (!["queued", "running"].includes(job.status)) {
      fail("JOB_NOT_CANCELABLE", "只有排队中或运行中的作业可以取消。");
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
