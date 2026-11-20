import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import {
  ADVENTURE_CHOICE_LLM_DEFAULTS,
  ADVENTURE_CHOICE_LLM_ENV,
  ADVENTURE_ENGINE_FAILURE_MARKER,
  ADVENTURE_EXIT_TEXT,
  ADVENTURE_TEST_ENV,
  ADVENTURE_TEST_STORY_NOT_ASSIGNED_TEXT,
  ADVENTURE_TEST_STORY_TRIGGER,
  AdventureFailurePhase,
  AdventureFailureReport,
  isAdventureExitRequest,
} from "./adventure.constants";
import { adventureDateKey } from "./adventure-date.util";
import {
  matchChoiceDeterministic,
  parseChoiceVerdict,
} from "./adventure-match";
import {
  AdventureDailyRecord,
  AdventureEpisode,
  AdventureProgress,
  Prisma,
} from "@prisma/client";

export interface AdventureReply {
  /** 依序播报文本（接话/兜底/原文段） */
  texts: string[];
  action: "narrate" | "await_reply" | "completed" | "exit";
  /** 本轮交互处置结果；开集/续播等非交互回复为 undefined。 */
  result?: "answered" | "off_topic" | "fallback" | "exit" | "timeout";
  /**
   * 本轮处置发生在哪个交互点：类型 + 段 order。
   * result 事件由四种交互类型共用（two_choice / open_question /
   * repeat_after_me / reward），报表要算「二选一的兜底率」必须能把分母
   * 限定在 two_choice 上，所以把类型一起盖到事件里。非交互回复为 undefined。
   */
  interaction?: { type: string; order: number };
  /**
   * 二选一命中信息：命中了第几个选项、判定来源（确定性/LLM）、
   * 该选项的作者内部 key、所在段 order、以及命中时锁定的版本快照 id。
   * 用于报表做「哪一段/哪个选项/哪个版本」的归因；不含任何儿童数据。
   */
  matchedChoice?: {
    index: number;
    source: "deterministic" | "llm";
    /** 被选中选项的作者内部 key（稳定 ID）；payload 缺 key 时为 null */
    key: string | null;
    /** interaction.order，报表用它 join 回内容 payload 取选项文案 */
    segmentOrder: number;
    /** progress.episodeVersionId；为空表示走 segments 物化表而非版本快照 */
    episodeVersionId: string | null;
  };
}

interface InteractionChoice {
  key: string;
  text: string;
  reply: string;
}

/**
 * 播放用段落。来源有二：adventure_segments 表（当前发布版本的物化副本），
 * 或孩子被锁定的 AdventureEpisodeVersion.payload 快照。两者结构一致，
 * 引擎只认这个最小形状，不依赖行 id 与时间戳。
 */
export interface PlayableSegment {
  order: number;
  kind: string;
  text: string;
  interactionType?: string | null;
  options?: unknown;
  fallbackText?: string | null;
  rewardStar?: boolean;
}

export interface EpisodeContent {
  recap: string | null;
  segments: PlayableSegment[];
}

/** 沉默超时：引导词最后一个 chunk ack 后 10s 无上行则兜底续播 */
const REPLY_TIMEOUT_MS = 10000;

/**
 * 允许被「不想玩了」接管的进度状态（词表见 ADVENTURE_EXIT_KEYWORDS）。
 *
 * 终态一律不在其中：completed / abandoned 是「任何路径都不得覆盖」的进度终态，
 * failed_over 是这一集已被自愈收走。这三种情况下念「之后再一起继续冒险」是假承诺，
 * 所以不接管，让这句话掉回正常的意图路由。
 */
const EXITABLE_PROGRESS_STATUSES = ["in_progress", "awaiting_reply", "exited"];

/** 进度终态：选集时永久排除，且任何路径都不得覆盖 */
const CLOSED_PROGRESS_STATUSES = ["completed", "abandoned"];

/** 已被收走、不再续玩的进度：落到选集重新分配（区别于 exited 的当日可续玩） */
const REASSIGNABLE_PROGRESS_STATUSES = ["abandoned", "failed_over"];

/** 版本快照缓存上限；payload 不可变，故只做容量淘汰，永不失效 */
const VERSION_CACHE_LIMIT = 200;

/**
 * 把版本 payload 解析成可播段落。任何字段缺失或类型不符都降级为安全默认值，
 * 形状彻底不可用时返回 null，由调用方回落 segments 表。
 */
export function parseEpisodePayload(payload: unknown): EpisodeContent | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const raw = payload as { recap?: unknown; segments?: unknown };
  if (!Array.isArray(raw.segments)) {
    return null;
  }
  const segments: PlayableSegment[] = [];
  for (const item of raw.segments) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    const order = Number(row.order);
    const text = typeof row.text === "string" ? row.text : "";
    if (!Number.isFinite(order) || !text) {
      continue;
    }
    segments.push({
      order,
      kind: typeof row.kind === "string" ? row.kind : "narration",
      text,
      interactionType:
        typeof row.interactionType === "string" ? row.interactionType : null,
      options: row.options ?? null,
      fallbackText:
        typeof row.fallbackText === "string" ? row.fallbackText : null,
      // 旧版本快照里的 exitText 刻意不读：退出话术已全局统一，见 ADVENTURE_EXIT_TEXT
      rewardStar: row.rewardStar === true,
    });
  }
  segments.sort((a, b) => a.order - b.order);
  return {
    recap: typeof raw.recap === "string" ? raw.recap : null,
    segments,
  };
}

/** 设备角色决定选集与互动接话人设；未知旧数据回落 Elly。 */
const CHARACTER_PERSONAS: Record<string, string> = {
  elly: "小象 Elly：听风原野的居民，性格温暖好奇，说话轻声细语，喜欢用「呀」「呢」结尾，爱鼓励孩子。",
  polly:
    "小马 Polly：听风原野的居民，性格开朗勇敢，说话活泼简洁，喜欢邀请孩子一起尝试，也爱鼓励孩子。",
};

/**
 * 冒险引擎：故事是数据不是 prompt。
 * 状态机推进、旁白原文直出；小模型仅在开放交互点/首次跑题引回时接话。
 * 主线推进权永远在引擎，孩子的回答只影响接话句，不改变故事走向。
 */
@Injectable()
export class AdventureService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdventureService.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly versionCache = new Map<string, EpisodeContent>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private timeoutListener:
    | ((
        deviceInternalId: string,
        reply: AdventureReply,
      ) => void | Promise<void>)
    | null = null;
  private failureListener:
    ((report: AdventureFailureReport) => void | Promise<void>) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    // 内存定时器之外的持久化兜底，覆盖重启与漏触发。
    this.sweepTimer = setInterval(() => {
      void this.sweepTimeouts().catch((error) => {
        this.logger.error(
          `Adventure timeout sweep failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, 2000);
    this.sweepTimer.unref();
  }

  onModuleDestroy() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const deviceId of this.timers.keys()) {
      this.clearTimer(deviceId);
    }
    this.versionCache.clear();
  }

  /** vendor 层注册：超时兜底产生回复时的回调（负责 chunk 上传与落库） */
  registerTimeoutListener(
    listener: (
      deviceInternalId: string,
      reply: AdventureReply,
    ) => void | Promise<void>,
  ) {
    this.timeoutListener = listener;
  }

  /** 日期口径与自愈巡检共用同一个实现，见 adventure-date.util.ts */
  /**
   * 自愈巡检注册：引擎兜底（换集）被触发时的上报回调。
   * 用监听器而不是直接注入 RecoveryService，是为了避免
   * 「RecoveryService → AdventureService → RecoveryService」的 DI 环，
   * 与既有 registerTimeoutListener 同一个惯用法。
   */
  registerFailureListener(
    listener: (report: AdventureFailureReport) => void | Promise<void>,
  ) {
    this.failureListener = listener;
  }

  private dateKey(date = new Date()): string {
    return adventureDateKey(date);
  }

  /** 今日是否已经完成任意一集；这是所有冒险入口的确定性门禁。 */
  /** 测试冒险故事环境总闸：非字面 "true" 一律视为关（prod 永远不可用）。 */
  isTestStoryEnabled(): boolean {
    return (
      this.configService.get<string>(ADVENTURE_TEST_ENV.enabled) === "true"
    );
  }

  async isCompletedToday(deviceInternalId: string): Promise<boolean> {
    const record = await this.prisma.adventureDailyRecord.findFirst({
      where: {
        deviceId: deviceInternalId,
        status: "completed",
        completedDate: this.dateKey(),
      },
      select: { id: true },
    });
    return !!record;
  }

  private findCurrentDaily(deviceInternalId: string) {
    return this.prisma.adventureDailyRecord.findFirst({
      where: { deviceId: deviceInternalId, status: "in_progress" },
      orderBy: { assignedAt: "desc" },
    });
  }

  private async findCurrentAdventure(deviceInternalId: string): Promise<{
    daily: AdventureDailyRecord;
    progress: AdventureProgress;
  } | null> {
    const daily = await this.findCurrentDaily(deviceInternalId);
    if (!daily) {
      return null;
    }
    const progress = await this.prisma.adventureProgress.findUnique({
      where: {
        deviceId_episodeId: {
          deviceId: deviceInternalId,
          episodeId: daily.episodeId,
        },
      },
    });
    return progress ? { daily, progress } : null;
  }

  private loadSegments(episodeId: string) {
    return this.prisma.adventureSegment.findMany({
      where: { episodeId },
      orderBy: { order: "asc" },
    });
  }

  /**
   * 读取某个版本快照的可播内容。版本行不可变，命中即缓存。
   * 版本行缺失或 payload 结构损坏时返回 null，由调用方回落 segments 表——
   * 内容层的任何意外都不允许让孩子那一轮沉默。
   */
  private async resolveVersionContent(
    versionId: string | null | undefined,
  ): Promise<EpisodeContent | null> {
    if (!versionId) {
      return null;
    }
    const cached = this.versionCache.get(versionId);
    if (cached) {
      return cached;
    }
    const row = await this.prisma.adventureEpisodeVersion.findUnique({
      where: { id: versionId },
      select: { id: true, episodeId: true, version: true, payload: true },
    });
    if (!row) {
      this.logger.warn(
        `Adventure version row missing, falling back to segment table: versionId=${versionId}`,
      );
      return null;
    }
    const content = parseEpisodePayload(row.payload);
    if (!content) {
      this.logger.warn(
        `Adventure version payload unusable, falling back to segment table: versionId=${versionId} episodeId=${row.episodeId} version=${row.version}`,
      );
      return null;
    }
    if (this.versionCache.size >= VERSION_CACHE_LIMIT) {
      const oldest = this.versionCache.keys().next().value;
      if (oldest) {
        this.versionCache.delete(oldest);
      }
    }
    this.versionCache.set(versionId, content);
    return content;
  }

  /**
   * 该进度应播放的段落。孩子被锁定的版本优先，保证 admin 发布新版本后，
   * 玩到一半的孩子仍听完自己那一版（段数变少不会被误判完集，交互点不会被换型）。
   * 无锁定（历史进度）或快照不可用时读 segments 表，与既有行为一致。
   */
  private async loadSegmentsForPlay(
    progress: Pick<AdventureProgress, "episodeId" | "episodeVersionId">,
  ): Promise<PlayableSegment[]> {
    const pinned = await this.resolveVersionContent(progress.episodeVersionId);
    if (pinned) {
      return pinned.segments;
    }
    return this.loadSegments(progress.episodeId);
  }

  /** 新分配一集的开场前情回顾：优先当前版本 payload，回落 episode 行的物化副本。 */
  private async resolveRecap(episode: AdventureEpisode): Promise<string[]> {
    return this.resolveRecapFor(episode, episode.currentVersionId);
  }

  /** 指定版本快照的开场前情回顾（测试冒险故事可播草稿快照的 recap）。 */
  private async resolveRecapFor(
    episode: AdventureEpisode,
    episodeVersionId: string | null,
  ): Promise<string[]> {
    const content = await this.resolveVersionContent(episodeVersionId);
    const recap = content?.recap ?? episode.recap;
    return recap ? [recap] : [];
  }

  /**
   * 选出该设备下一集：跳过已完成与已 retire 的集，也跳过被 abandoned 收走的集。
   * failed_over 不算完成——内容修好后同一集仍可重新分配。
   * 未发布的集是内容硬边界：宁可停播，也不跳过它去播后面的集。
   */
  private async selectNextEpisode(
    deviceInternalId: string,
    excludeEpisodeId?: string,
  ): Promise<AdventureEpisode | null> {
    const characterKey = await this.getCharacterKey(deviceInternalId);
    const [episodes, progresses] = await Promise.all([
      this.prisma.adventureEpisode.findMany({
        where: { characterKey, season: 1 },
        orderBy: { episodeNumber: "asc" },
      }),
      this.prisma.adventureProgress.findMany({
        where: {
          deviceId: deviceInternalId,
          episode: { characterKey, season: 1 },
        },
        select: { episodeId: true, status: true },
      }),
    ]);
    const closedEpisodeIds = new Set(
      progresses
        .filter((progress) =>
          CLOSED_PROGRESS_STATUSES.includes(progress.status),
        )
        .map((progress) => progress.episodeId),
    );
    if (excludeEpisodeId) {
      closedEpisodeIds.add(excludeEpisodeId);
    }
    const episode = episodes.find(
      (item) => !closedEpisodeIds.has(item.id) && !item.retiredAt,
    );
    if (!episode || !episode.published) {
      return null;
    }
    return episode;
  }

  /**
   * 为目标集准备进度行。不存在则新建；曾以 failed_over / exited 收走的行原地重置，
   * 避免撞 @@unique([deviceId, episodeId])。终态（completed / abandoned）只告警不覆盖。
   */
  private async assignProgress(
    tx: Prisma.TransactionClient,
    deviceInternalId: string,
    episode: AdventureEpisode,
  ): Promise<AdventureProgress> {
    const existing = await tx.adventureProgress.findUnique({
      where: {
        deviceId_episodeId: {
          deviceId: deviceInternalId,
          episodeId: episode.id,
        },
      },
    });
    if (!existing) {
      return tx.adventureProgress.create({
        data: {
          deviceId: deviceInternalId,
          episodeId: episode.id,
          status: "in_progress",
          episodeVersionId: episode.currentVersionId,
        },
      });
    }
    if (CLOSED_PROGRESS_STATUSES.includes(existing.status)) {
      this.logger.warn(
        `Refusing to overwrite terminal adventure progress: deviceId=${deviceInternalId} episodeId=${episode.id} status=${existing.status}`,
      );
      return existing;
    }
    return tx.adventureProgress.update({
      where: { id: existing.id },
      data: {
        status: "in_progress",
        nextSegmentOrder: 0,
        stars: 0,
        offTopicCount: 0,
        waitingSince: null,
        completedAt: null,
        episodeVersionId: episode.currentVersionId,
      },
    });
  }

  /** 跨天陈旧的 daily 行收口为 failed_over，再为今天新开一行（受唯一约束不能复用旧行）。 */
  private async closeStaleDailyAndOpenToday(
    tx: Prisma.TransactionClient,
    deviceInternalId: string,
    staleDailyId: string,
    episodeId: string,
    today: string,
  ): Promise<AdventureDailyRecord> {
    await tx.adventureDailyRecord.update({
      where: { id: staleDailyId },
      data: { status: "failed_over" },
    });
    return tx.adventureDailyRecord.create({
      data: {
        deviceId: deviceInternalId,
        episodeId,
        assignedDate: today,
        status: "in_progress",
      },
    });
  }

  /**
   * 取今天这一行 daily：有则复用改指，无则新建。
   *
   * @@unique([deviceId, assignedDate]) 决定一个设备一天只能有一行，而
   * findCurrentDaily 只看 status=in_progress。于是当今天那行已经被收走
   * （retire → abandoned、故障 → failed_over）或进度行丢失时，
   * 「查不到在飞的 daily」+「无条件 create」会直接撞唯一约束抛错，
   * 而且这是永久卡死：那行 daily 不会自己消失，孩子从此再也进不去冒险。
   * 复用语义与 recoverToNextEpisode 的 reuseDaily 一致。
   */
  private async openOrReuseTodayDaily(
    tx: Prisma.TransactionClient,
    deviceInternalId: string,
    episodeId: string,
    opts?: { allowCompletedOverwrite?: boolean },
  ): Promise<AdventureDailyRecord> {
    const today = this.dateKey();
    const existing = await tx.adventureDailyRecord.findUnique({
      where: {
        deviceId_assignedDate: {
          deviceId: deviceInternalId,
          assignedDate: today,
        },
      },
    });
    if (!existing) {
      return tx.adventureDailyRecord.create({
        data: {
          deviceId: deviceInternalId,
          episodeId,
          assignedDate: today,
          status: "in_progress",
        },
      });
    }
    if (existing.status === "completed") {
      if (opts?.allowCompletedOverwrite) {
        // 测试冒险故事：同一天反复重玩要覆盖完集状态，否则第二次「测试冒险故事」
        // 会被完集记录挡住。
        return tx.adventureDailyRecord.update({
          where: { id: existing.id },
          data: {
            episodeId,
            status: "in_progress",
            completedAt: null,
            completedDate: null,
          },
        });
      }
      // 不可达：isCompletedToday 已在上游拦住。真到了这里说明每日额度判定
      // 出了意外，此时宁可本轮不写库，也不能把孩子的完集记录改成 in_progress。
      this.logger.warn(
        `Refusing to overwrite completed daily record: deviceId=${deviceInternalId} dailyId=${existing.id} assignedDate=${today}`,
      );
      return existing;
    }
    return tx.adventureDailyRecord.update({
      where: { id: existing.id },
      data: { episodeId, status: "in_progress" },
    });
  }

  private async getCharacterKey(deviceInternalId: string): Promise<string> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceInternalId },
      select: { characterKey: true },
    });
    return device?.characterKey || "elly";
  }

  /**
   * 测试冒险故事开跑：清等待定时器 → 事务内复用/改指当日 daily 行（允许覆盖完集）、
   * 无条件把进度重置到第 0 段、写带时间戳后缀的 assigned/started 事件（重玩不撞
   * eventKey 唯一约束）。与正常开集路径分家：测试播放不走每日一集门禁、不走顺序选集。
   */
  private async openTestRun(
    deviceInternalId: string,
    episode: AdventureEpisode,
    episodeVersionId: string | null,
  ): Promise<{ daily: AdventureDailyRecord; progress: AdventureProgress }> {
    this.clearTimer(deviceInternalId);
    return this.prisma.$transaction(async (tx) => {
      const daily = await this.openOrReuseTodayDaily(
        tx,
        deviceInternalId,
        episode.id,
        { allowCompletedOverwrite: true },
      );
      const progress = await this.resetProgressForTest(
        tx,
        deviceInternalId,
        episode,
        episodeVersionId,
      );
      const run = Date.now();
      await tx.adventureEvent.create({
        data: {
          eventKey: `daily:${daily.id}:assigned:${run}`,
          deviceId: deviceInternalId,
          episodeId: episode.id,
          dailyRecordId: daily.id,
          eventType: "daily_assigned",
        },
      });
      await tx.adventureEvent.create({
        data: {
          eventKey: `daily:${daily.id}:started:${run}`,
          deviceId: deviceInternalId,
          episodeId: episode.id,
          dailyRecordId: daily.id,
          eventType: "started",
        },
      });
      return { daily, progress };
    });
  }

  /**
   * 测试冒险故事的进度重置：无条件回到第 0 段。与 assignProgress 的区别是它
   * 覆盖终态（completed/exited/failed_over），因为测试要的是可重复的从头到尾体验。
   */
  private async resetProgressForTest(
    tx: Prisma.TransactionClient,
    deviceInternalId: string,
    episode: AdventureEpisode,
    episodeVersionId: string | null,
  ): Promise<AdventureProgress> {
    return tx.adventureProgress.upsert({
      where: {
        deviceId_episodeId: {
          deviceId: deviceInternalId,
          episodeId: episode.id,
        },
      },
      create: {
        deviceId: deviceInternalId,
        episodeId: episode.id,
        status: "in_progress",
        episodeVersionId,
        nextSegmentOrder: 0,
      },
      update: {
        status: "in_progress",
        episodeVersionId,
        nextSegmentOrder: 0,
        stars: 0,
        offTopicCount: 0,
        waitingSince: null,
        completedAt: null,
      },
    });
  }

  /**
   * 开集/续玩。每天只能完成一集；未完成集跨天仍保留，完集日计入当天额度。
   * 集顺序只用于个人进度，不要求剧情连续，也不因其他孩子进度而改变。
   */
  /**
   * 开集/续玩入口。任何内部异常都在这里被兜住：先尝试平移到下一集，
   * 平移失败则返回 null 让上层继续降级。异常绝不允许冒到对话入口——
   * 对孩子来说，一个 500 和一段沉默是同一件事。
   */
  async startToday(
    deviceInternalId: string,
    explicitlyRequested = false,
  ): Promise<AdventureReply | null> {
    try {
      return await this.startTodayInternal(
        deviceInternalId,
        explicitlyRequested,
      );
    } catch (error) {
      return this.handleEngineFailure(deviceInternalId, "start_today", error);
    }
  }

  /**
   * 测试冒险故事的语音入口（两条对话链路共用）：固定触发词「测试冒险故事」，
   * 命中即从第 0 段播放该设备下发的集；未下发返回确定性话术；不是触发词或
   * 环境未开启返回 null，由链路层落回正常意图路由。任何异常都返回 null 落回
   * 正常链路，绝不让这一轮静音。
   */
  async tryTestStoryTrigger(
    deviceInternalId: string,
    asrText: string | null | undefined,
  ): Promise<AdventureReply | null> {
    if (!this.isTestStoryEnabled()) {
      return null;
    }
    if ((asrText ?? "").trim() !== ADVENTURE_TEST_STORY_TRIGGER) {
      return null;
    }
    try {
      const reply = await this.playTestEpisode(deviceInternalId);
      if (reply) {
        return reply;
      }
      return {
        texts: [ADVENTURE_TEST_STORY_NOT_ASSIGNED_TEXT],
        action: "narrate",
      };
    } catch (error) {
      this.logger.error(
        `Test story trigger failed, degrading to normal flow for device=${deviceInternalId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** 播放下发的测试集：读 device 字段 → 锁定版本 → 从第 0 段重开。未下发返回 null。 */
  async playTestEpisode(
    deviceInternalId: string,
  ): Promise<AdventureReply | null> {
    if (!this.isTestStoryEnabled()) {
      return null;
    }
    const device = await this.prisma.device.findUnique({
      where: { id: deviceInternalId },
      select: {
        testAdventureEpisodeId: true,
        testAdventureEpisodeVersionId: true,
      },
    });
    const episodeId = device?.testAdventureEpisodeId;
    if (!episodeId) {
      return null;
    }
    const episode = await this.prisma.adventureEpisode.findUnique({
      where: { id: episodeId },
    });
    if (!episode) {
      return null;
    }
    const episodeVersionId =
      device.testAdventureEpisodeVersionId ?? episode.currentVersionId ?? null;
    const { daily, progress } = await this.openTestRun(
      deviceInternalId,
      episode,
      episodeVersionId,
    );
    const segments = await this.loadSegmentsForPlay(progress);
    const prefix = await this.resolveRecapFor(episode, episodeVersionId);
    return this.playFrom(progress, segments, prefix, daily);
  }

  private async startTodayInternal(
    deviceInternalId: string,
    explicitlyRequested = false,
  ): Promise<AdventureReply | null> {
    if (await this.isCompletedToday(deviceInternalId)) {
      return null;
    }

    const current = await this.findCurrentAdventure(deviceInternalId);
    // abandoned（admin retire 收走）与 failed_over（故障自愈收走）都不再续玩，落到选集重新分配。
    if (
      current &&
      !REASSIGNABLE_PROGRESS_STATUSES.includes(current.progress.status)
    ) {
      const { daily, progress } = current;
      if (progress.status === "exited" && !explicitlyRequested) {
        return null;
      }
      if (progress.status === "exited") {
        await this.prisma.adventureEvent.create({
          data: {
            eventKey: `daily:${daily.id}:resumed:${Date.now()}`,
            deviceId: deviceInternalId,
            episodeId: daily.episodeId,
            dailyRecordId: daily.id,
            eventType: "resumed",
          },
        });
      }
      // 中断续玩：只恢复已分配的同一集，不重播 recap。
      // 等待互动时退出，nextSegmentOrder 已指向交互点之后；恢复需退回该未回答交互点。
      const resumeProgress =
        progress.status === "exited"
          ? {
              ...progress,
              nextSegmentOrder: Math.max(0, progress.nextSegmentOrder - 1),
            }
          : progress;
      const segments = await this.loadSegmentsForPlay(progress);
      return this.playFrom(resumeProgress, segments, [], daily);
    }

    const episode = await this.selectNextEpisode(deviceInternalId);
    // 未发布的下一集是内容边界：停止，不跳过它播后面的集。
    if (!episode) {
      return null;
    }

    const { daily, progress } = await this.prisma.$transaction(async (tx) => {
      const daily = await this.openOrReuseTodayDaily(
        tx,
        deviceInternalId,
        episode.id,
      );
      const progress = await this.assignProgress(tx, deviceInternalId, episode);
      await tx.adventureEvent.create({
        data: {
          eventKey: `daily:${daily.id}:assigned`,
          deviceId: deviceInternalId,
          episodeId: episode.id,
          dailyRecordId: daily.id,
          eventType: "daily_assigned",
        },
      });
      await tx.adventureEvent.create({
        data: {
          eventKey: `daily:${daily.id}:started`,
          deviceId: deviceInternalId,
          episodeId: episode.id,
          dailyRecordId: daily.id,
          eventType: "started",
        },
      });
      return { daily, progress };
    });
    const segments = await this.loadSegmentsForPlay(progress);
    const prefix = await this.resolveRecap(episode);
    return this.playFrom(progress, segments, prefix, daily);
  }

  /**
   * 从 nextSegmentOrder 起连播旁白，直到交互点（等待）或完集。
   * reward 型交互点：播完即发星光并继续，不进入等待。
   */
  private async playFrom(
    progress: AdventureProgress,
    segments: PlayableSegment[],
    prefix: string[],
    daily: AdventureDailyRecord,
  ): Promise<AdventureReply> {
    const texts = [...prefix];
    let order = progress.nextSegmentOrder;
    let stars = progress.stars;

    for (const segment of segments) {
      if (segment.order < order) {
        continue;
      }
      texts.push(segment.text);
      order = segment.order + 1;

      if (segment.kind !== "interaction") {
        continue;
      }
      if (segment.interactionType === "reward") {
        if (segment.rewardStar) {
          stars += 1;
        }
        continue; // 奖励原语不需要孩子回答
      }

      // 先进入等待态；上传方在最后一个 chunk ack 后调用 markPromptPlaybackComplete。
      await this.prisma.adventureProgress.update({
        where: { id: progress.id },
        data: {
          nextSegmentOrder: order,
          status: "awaiting_reply",
          waitingSince: null,
          stars,
          offTopicCount: 0,
        },
      });
      return { texts, action: "await_reply" };
    }

    // 没有更多交互点：完集（或续玩时仅剩旁白）
    const isDone = order >= segments.length;
    this.clearTimer(progress.deviceId);
    if (isDone) {
      const completedAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        await tx.adventureProgress.update({
          where: { id: progress.id },
          data: {
            nextSegmentOrder: order,
            status: "completed",
            waitingSince: null,
            stars,
            completedAt,
          },
        });
        await tx.adventureDailyRecord.update({
          where: { id: daily.id },
          data: {
            status: "completed",
            completedAt,
            completedDate: this.dateKey(completedAt),
          },
        });
        await tx.adventureEvent.upsert({
          where: { eventKey: `daily:${daily.id}:completed` },
          update: {},
          create: {
            eventKey: `daily:${daily.id}:completed`,
            deviceId: progress.deviceId,
            episodeId: progress.episodeId,
            dailyRecordId: daily.id,
            eventType: "completed",
            segmentOrder: order,
            payload: { stars },
          },
        });
      });
    } else {
      await this.prisma.adventureProgress.update({
        where: { id: progress.id },
        data: {
          nextSegmentOrder: order,
          status: "in_progress",
          waitingSince: null,
          stars,
        },
      });
    }
    return { texts, action: isDone ? "completed" : "narrate" };
  }

  /** 引导词最后一个 chunk 已 ack：从此时开始计算孩子的 10s 回答窗口。 */
  async markPromptPlaybackComplete(deviceInternalId: string): Promise<void> {
    const current = await this.findCurrentAdventure(deviceInternalId);
    if (!current || current.progress.status !== "awaiting_reply") {
      return;
    }
    const { progress } = current;
    await this.prisma.adventureProgress.update({
      where: { id: progress.id },
      data: { waitingSince: new Date() },
    });
    this.scheduleTimeout(deviceInternalId);
  }

  /** 当前等待回答的交互点（已播，order = nextSegmentOrder - 1）；非交互段一律不认。 */
  private currentInteraction(
    progress: AdventureProgress,
    segments: PlayableSegment[],
  ) {
    return segments.find(
      (s) =>
        s.order === progress.nextSegmentOrder - 1 && s.kind === "interaction",
    );
  }

  /**
   * 孩子回话：明确拒绝在任何阶段都接管（见 exitAdventure），其余四类处置只在
   * 交互等待态生效；非等待态返回 null（不接管上行）。
   */
  /** 孩子回话入口。兜底口径同 startToday。 */
  async handleChildReply(
    deviceInternalId: string,
    asrText: string,
  ): Promise<AdventureReply | null> {
    try {
      return await this.handleChildReplyInternal(deviceInternalId, asrText);
    } catch (error) {
      return this.handleEngineFailure(deviceInternalId, "handle_reply", error);
    }
  }

  private async handleChildReplyInternal(
    deviceInternalId: string,
    asrText: string,
  ): Promise<AdventureReply | null> {
    const current = await this.findCurrentAdventure(deviceInternalId);
    if (!current) {
      return null;
    }
    const { daily, progress } = current;

    // 明确拒绝优先于一切判定，且与状态机停在哪一格无关：等回答时、旁白还在播时、
    // 甚至已经退出过又喊一次，都只念同一句全局话术。放在最前面是因为它绝不能被
    // 后面的分支吃掉——二选一匹配、跑题引回、开放提问接话都不该先于「孩子说不玩了」。
    if (isAdventureExitRequest(asrText)) {
      return this.exitAdventure(deviceInternalId, progress);
    }

    if (progress.status !== "awaiting_reply") {
      return null;
    }
    this.clearTimer(deviceInternalId);

    const segments = await this.loadSegmentsForPlay(progress);
    const interaction = this.currentInteraction(progress, segments);
    if (!interaction) {
      return null;
    }

    if (interaction.interactionType === "two_choice") {
      return this.withInteractionMeta(
        await this.handleTwoChoice(
          deviceInternalId,
          daily,
          progress,
          segments,
          interaction,
          asrText,
        ),
        interaction,
      );
    }
    if (interaction.interactionType === "repeat_after_me") {
      // 跟读以鼓励为主、完全不判定：孩子说任何话——漏词、发音不准、甚至完全无关——
      // 都算成功，一律播 praise 并推进主线。刻意不比对目标句：跟读的目标是让孩子
      // 开口，不是考发音；判失败只会打击孩子，且跟读没有剧情约束要求它必须命中。
      const options = interaction.options as unknown as {
        praise?: string;
      } | null;
      const praise = options?.praise || "说得真好！给你鼓掌！";
      const reply = await this.playFrom(progress, segments, [praise], daily);
      return this.withInteractionMeta(
        { ...reply, result: "answered" },
        interaction,
      );
    }
    // open_question：小模型接话（含正常/跑题/超前发挥），失败降级兜底
    const bridge = await this.generateBridge(
      deviceInternalId,
      interaction,
      asrText,
      "open_question",
    );
    const reply = await this.playFrom(progress, segments, [bridge], daily);
    return this.withInteractionMeta(
      { ...reply, result: "answered" },
      interaction,
    );
  }

  /**
   * 把交互点的类型与段号盖到回复上，供 recordPresented 写进 result 事件。
   * 四种交互类型共用同一批 result 事件名，不带类型就无法把「二选一兜底率」
   * 的分母从开放提问里摘出来。interaction 为空（超时路径拿不到当前段）时原样返回。
   */
  private withInteractionMeta(
    reply: AdventureReply,
    interaction: PlayableSegment | null | undefined,
  ): AdventureReply {
    if (!interaction) {
      return reply;
    }
    return {
      ...reply,
      interaction: {
        type: interaction.interactionType ?? "unknown",
        order: interaction.order,
      },
    };
  }

  /**
   * 温柔退出：任何阶段都念同一句全局话术，进度落 exited（当日可续玩）。
   *
   * 三点刻意的取舍：
   * 1. **不看当前停在旁白还是互动段。** 孩子打断旁白说「不想玩了」和在互动点说，
   *    对他是同一件事，引擎不该因为状态机停在哪一格而给出不同回应。
   * 2. **终态不接管。** completed / abandoned / failed_over 返回 null：既不覆盖终态，
   *    也不念一句做不到的承诺，这句话交回正常意图路由。
   * 3. **已退出时幂等。** 只重复那句话，不再写库——否则 updatedAt 被无意义刷动，
   *    看板上「最后活动时间」会变成孩子喊退出的时间；也绝不触发 resume。
   */
  private async exitAdventure(
    deviceInternalId: string,
    progress: AdventureProgress,
  ): Promise<AdventureReply | null> {
    if (!EXITABLE_PROGRESS_STATUSES.includes(progress.status)) {
      return null;
    }
    // 等待中的 10s 沉默超时必须取消：孩子已经走了，定时器不该再追一句兜底话术
    this.clearTimer(deviceInternalId);
    if (progress.status !== "exited") {
      await this.prisma.adventureProgress.update({
        where: { id: progress.id },
        data: { status: "exited", waitingSince: null },
      });
    }
    return {
      texts: [ADVENTURE_EXIT_TEXT],
      action: "exit",
      result: "exit",
    };
  }

  private isChoiceLlmEnabled(): boolean {
    const raw = this.configService.get<string>(
      ADVENTURE_CHOICE_LLM_ENV.enabled,
    ) as string | undefined;
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return ADVENTURE_CHOICE_LLM_DEFAULTS.enabled;
    }
    const normalized = String(raw).trim().toLowerCase();
    return normalized !== "false" && normalized !== "0";
  }

  /** 小模型二选一兜底判定，失败返回 index=null 降级给上层走旧跑题逻辑 */
  private async judgeAndRedirect(
    deviceInternalId: string,
    interaction: PlayableSegment,
    asrText: string,
    choices: InteractionChoice[],
  ): Promise<{ index: number | null; redirectText: string }> {
    try {
      const characterKey = await this.getCharacterKey(deviceInternalId);
      const characterPersona =
        CHARACTER_PERSONAS[characterKey] || CHARACTER_PERSONAS.elly;
      const result = await this.llmService.complete({
        scene: "adventure_interaction",
        deviceId: deviceInternalId,
        messages: this.llmService.buildAdventureChoiceMatchPrompt({
          characterPersona,
          segmentText: interaction.text,
          choiceA: choices[0]?.text ?? "",
          choiceB: choices[1]?.text ?? "",
          childReply: asrText,
        }),
        model: this.llmService.smallModelName,
        maxTokens: 160,
        timeoutMs: 3500,
      });
      return parseChoiceVerdict(result.text, choices.length);
    } catch (error) {
      this.logger.warn(
        `Adventure choice LLM failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { index: null, redirectText: "" };
    }
  }

  private async handleTwoChoice(
    deviceInternalId: string,
    daily: AdventureDailyRecord,
    progress: AdventureProgress,
    segments: PlayableSegment[],
    interaction: PlayableSegment,
    asrText: string,
  ): Promise<AdventureReply> {
    const options = interaction.options as unknown as {
      choices?: InteractionChoice[];
    } | null;
    const choices = options?.choices || [];
    const hitIndex = matchChoiceDeterministic(choices, asrText);
    const matched = hitIndex !== null ? choices[hitIndex] : undefined;

    if (matched) {
      if (interaction.rewardStar) {
        progress.stars += 1;
      }
      const reply = await this.playFrom(
        progress,
        segments,
        [matched.reply],
        daily,
      );
      return {
        ...reply,
        result: "answered",
        matchedChoice: {
          index: hitIndex,
          source: "deterministic",
          key: choices[hitIndex]?.key ?? null,
          segmentOrder: interaction.order,
          episodeVersionId: progress.episodeVersionId ?? null,
        },
      };
    }

    // LLM 兜底判定（开关打开时）：确定性匹配未命中，调一次小模型再试
    if (this.isChoiceLlmEnabled()) {
      const verdict = await this.judgeAndRedirect(
        deviceInternalId,
        interaction,
        asrText,
        choices,
      );

      if (verdict.index !== null) {
        const matchedChoice = choices[verdict.index];
        if (interaction.rewardStar) {
          progress.stars += 1;
        }
        const reply = await this.playFrom(
          progress,
          segments,
          [matchedChoice.reply],
          daily,
        );
        return {
          ...reply,
          result: "answered",
          matchedChoice: {
            index: verdict.index!,
            source: "llm",
            key: choices[verdict.index!]?.key ?? null,
            segmentOrder: interaction.order,
            episodeVersionId: progress.episodeVersionId ?? null,
          },
        };
      }

      if (progress.offTopicCount === 0) {
        const redirect =
          verdict.redirectText ||
          interaction.fallbackText ||
          "没关系，我们继续吧。";
        await this.prisma.adventureProgress.update({
          where: { id: progress.id },
          data: { offTopicCount: 1, waitingSince: null },
        });
        return {
          texts: [redirect],
          action: "await_reply",
          result: "off_topic",
        };
      }

      const reply = await this.playFrom(
        progress,
        segments,
        [interaction.fallbackText || "没关系，我们继续吧。"],
        daily,
      );
      return { ...reply, result: "fallback" };
    }

    // 首次跑题（开关关闭时）：小模型接住 + 轻引回一次，仍停在该交互点，不推进主线
    if (progress.offTopicCount === 0) {
      const redirect = await this.generateBridge(
        deviceInternalId,
        interaction,
        asrText,
        "redirect",
      );
      await this.prisma.adventureProgress.update({
        where: { id: progress.id },
        data: { offTopicCount: 1, waitingSince: null },
      });
      return { texts: [redirect], action: "await_reply", result: "off_topic" };
    }

    // 第二次跑题（开关关闭时）：预生成兜底话术推进，不再引回、不调 LLM
    const reply = await this.playFrom(
      progress,
      segments,
      [interaction.fallbackText || "没关系，我们继续吧。"],
      daily,
    );
    return { ...reply, result: "fallback" };
  }

  /** 小模型接话；失败降级为兜底话术，保证绝不卡死 */
  private async generateBridge(
    deviceInternalId: string,
    interaction: PlayableSegment,
    asrText: string,
    kind: "open_question" | "redirect",
  ): Promise<string> {
    try {
      const characterKey = await this.getCharacterKey(deviceInternalId);
      const characterPersona =
        CHARACTER_PERSONAS[characterKey] || CHARACTER_PERSONAS.elly;
      const result = await this.llmService.complete({
        scene: "adventure_interaction",
        deviceId: deviceInternalId,
        messages: this.llmService.buildAdventureInteractionPrompt({
          characterPersona,
          segmentText: interaction.text,
          childReply: asrText,
          kind,
        }),
        model: this.llmService.smallModelName,
        maxTokens: 80,
      });
      return result.text || interaction.fallbackText || "我们继续吧。";
    } catch (error) {
      this.logger.warn(
        `Adventure bridge LLM failed, fallback used: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return interaction.fallbackText || "没关系，我们继续吧。";
    }
  }

  /**
   * 10s 沉默超时检查：到点未收到该设备上行则兜底续播。
   * 终点判定 = 我方收到 vendor:text:in 的时间（由调用方先取消等待）。
   */
  /** 沉默超时入口。兜底口径同 startToday。 */
  async checkTimeout(deviceInternalId: string): Promise<AdventureReply | null> {
    try {
      return await this.checkTimeoutInternal(deviceInternalId);
    } catch (error) {
      return this.handleEngineFailure(deviceInternalId, "check_timeout", error);
    }
  }

  private async checkTimeoutInternal(
    deviceInternalId: string,
  ): Promise<AdventureReply | null> {
    const current = await this.findCurrentAdventure(deviceInternalId);
    if (
      !current ||
      current.progress.status !== "awaiting_reply" ||
      !current.progress.waitingSince
    ) {
      return null;
    }
    const { daily, progress } = current;
    if (Date.now() - progress.waitingSince.getTime() < REPLY_TIMEOUT_MS) {
      return null; // 未超时：竞态下以先到的上行为准
    }

    const segments = await this.loadSegmentsForPlay(progress);
    const interaction = this.currentInteraction(progress, segments);
    const fallback = interaction?.fallbackText || "没关系，我们继续吧。";
    this.clearTimer(deviceInternalId);
    const reply = await this.playFrom(progress, segments, [fallback], daily);
    return this.withInteractionMeta(
      { ...reply, result: "timeout" },
      interaction,
    );
  }

  /**
   * 引擎异常的统一兜底：记日志 → 尝试平移到下一集 → 上报（无论成败）。
   *
   * 平移自身也失败时返回 null，上层据此继续降级（自由创作 → L0 兜底话术）。
   * 这条链路自己绝不再抛错：兜底代码抛错等于把最后一道防线也拆了。
   */
  private async handleEngineFailure(
    deviceInternalId: string,
    phase: AdventureFailurePhase,
    error: unknown,
  ): Promise<AdventureReply | null> {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.error(
      `${ADVENTURE_ENGINE_FAILURE_MARKER} phase=${phase} deviceId=${deviceInternalId}: ${reason}`,
    );
    let reply: AdventureReply | null = null;
    try {
      reply = await this.recoverToNextEpisode(deviceInternalId, reason);
    } catch (recoverError) {
      this.logger.error(
        `${ADVENTURE_ENGINE_FAILURE_MARKER} recovery also failed phase=${phase} ` +
          `deviceId=${deviceInternalId}: ${
            recoverError instanceof Error
              ? recoverError.message
              : String(recoverError)
          }`,
      );
    }
    await this.emitFailure({
      deviceInternalId,
      phase,
      reason,
      recovered: !!reply,
      at: new Date().toISOString(),
    });
    return reply;
  }

  /** 上报给自愈巡检（熔断计数 + 面板）。尽力而为，绝不影响本轮回复。 */
  private async emitFailure(report: AdventureFailureReport): Promise<void> {
    if (!this.failureListener) {
      return;
    }
    try {
      await this.failureListener(report);
    } catch (error) {
      this.logger.warn(
        `Adventure failure listener threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 故障自愈：当日这一集确认无法继续（内容损坏、状态病态、未知异常）时，
   * 把孩子平移到下一集，绝不让孩子面对沉默。
   *
   * 边界：
   * - 今天已经完成过一集 → 不做任何事（每日额度是硬门禁，兜底不得绕过它）；
   * - 当前没有在飞的冒险 → 不做任何事；
   * - 没有可接管的下一集 → 返回 null 由上层落到自由对话，而不是抛错；
   * - 单轮最多平移一次，不递归（下一集又坏则交给上层兜底话术）。
   *
   * 旧集进度标 failed_over 而非 abandoned：内容修好后同一集仍可重新分配给孩子。
   * 当日 daily 行受 @@unique([deviceId, assignedDate]) 约束，必须复用改指下一集；
   * 跨天的陈旧 daily 先标 failed_over 收口，再为今天新建一行。
   */
  async recoverToNextEpisode(
    deviceInternalId: string,
    reason: string,
  ): Promise<AdventureReply | null> {
    if (await this.isCompletedToday(deviceInternalId)) {
      return null;
    }
    const current = await this.findCurrentAdventure(deviceInternalId);
    if (!current) {
      return null;
    }
    const { daily, progress } = current;
    const fromEpisodeId = progress.episodeId;

    const next = await this.selectNextEpisode(deviceInternalId, fromEpisodeId);
    if (!next) {
      this.logger.warn(
        `Adventure recovery found no next episode: deviceId=${deviceInternalId} reason=${reason} fromEpisodeId=${fromEpisodeId}`,
      );
      return null;
    }

    const today = this.dateKey();
    const reuseDaily = daily.assignedDate === today;
    this.clearTimer(deviceInternalId);

    const { daily: targetDaily, progress: nextProgress } =
      await this.prisma.$transaction(async (tx) => {
        await tx.adventureProgress.update({
          where: { id: progress.id },
          data: { status: "failed_over", waitingSince: null },
        });
        const targetDaily = reuseDaily
          ? await tx.adventureDailyRecord.update({
              where: { id: daily.id },
              data: { episodeId: next.id, status: "in_progress" },
            })
          : await this.closeStaleDailyAndOpenToday(
              tx,
              deviceInternalId,
              daily.id,
              next.id,
              today,
            );
        await tx.adventureEvent.create({
          data: {
            eventKey: `daily:${targetDaily.id}:reassigned:${next.id}:${Date.now()}`,
            deviceId: deviceInternalId,
            episodeId: next.id,
            dailyRecordId: targetDaily.id,
            eventType: "reassigned_after_failure",
            payload: {
              reason,
              fromEpisodeId,
              toEpisodeId: next.id,
              reusedDaily: reuseDaily,
              staleDailyId: reuseDaily ? null : daily.id,
            },
          },
        });
        const nextProgress = await this.assignProgress(
          tx,
          deviceInternalId,
          next,
        );
        return { daily: targetDaily, progress: nextProgress };
      });

    this.logger.warn(
      `Adventure recovered to next episode: deviceId=${deviceInternalId} reason=${reason} from=${fromEpisodeId} to=${next.id} reusedDaily=${reuseDaily}`,
    );
    const segments = await this.loadSegmentsForPlay(nextProgress);
    const prefix = await this.resolveRecap(next);
    return this.playFrom(nextProgress, segments, prefix, targetDaily);
  }

  /** 播报完成后追加审计事件；ASR 与播报全文只保留在 Message。
   * @param userMessageId 用户消息 ID，用于 choice_matched 事件关联孩子原话（payload 仅含 index/source/key，不存原话本身）。 */
  async recordPresented(
    deviceInternalId: string,
    turnId: string,
    reply: AdventureReply,
    userMessageId?: string,
  ): Promise<void> {
    const daily = await this.prisma.adventureDailyRecord.findFirst({
      where: { deviceId: deviceInternalId },
      orderBy: { assignedAt: "desc" },
    });
    if (!daily) {
      return;
    }
    const base = {
      deviceId: deviceInternalId,
      episodeId: daily.episodeId,
      dailyRecordId: daily.id,
      turnId,
    };
    await this.prisma.adventureEvent.upsert({
      where: { eventKey: `turn:${turnId}:segments_presented` },
      update: {},
      create: {
        ...base,
        eventKey: `turn:${turnId}:segments_presented`,
        eventType: "segments_presented",
        payload: { action: reply.action, textCount: reply.texts.length },
      },
    });
    if (reply.result) {
      await this.prisma.adventureEvent.upsert({
        where: { eventKey: `turn:${turnId}:result:${reply.result}` },
        update: {},
        create: {
          ...base,
          eventKey: `turn:${turnId}:result:${reply.result}`,
          eventType: reply.result,
          // result 事件由四种交互类型共用，带上类型与段号报表才能把
          // 「二选一兜底率」的分母从开放提问里摘出来。
          segmentOrder: reply.interaction?.order ?? null,
          ...(reply.interaction
            ? { payload: { interactionType: reply.interaction.type } }
            : {}),
        },
      });
    }
    if (reply.matchedChoice) {
      await this.prisma.adventureEvent.upsert({
        where: { eventKey: `turn:${turnId}:choice_matched` },
        update: { messageId: userMessageId ?? null },
        create: {
          ...base,
          eventKey: `turn:${turnId}:choice_matched`,
          eventType: "choice_matched",
          messageId: userMessageId ?? null,
          episodeVersionId: reply.matchedChoice.episodeVersionId,
          segmentOrder: reply.matchedChoice.segmentOrder,
          payload: {
            index: reply.matchedChoice.index,
            source: reply.matchedChoice.source,
            key: reply.matchedChoice.key,
          },
        },
      });
    }
  }

  /** 今日完成后，记录一次被门禁拦截的冒险入口及实际路由。 */
  async recordEntryBlocked(
    deviceInternalId: string,
    targetMode: string,
  ): Promise<void> {
    const daily = await this.prisma.adventureDailyRecord.findFirst({
      where: {
        deviceId: deviceInternalId,
        status: "completed",
        completedDate: this.dateKey(),
      },
      orderBy: { completedAt: "desc" },
    });
    if (!daily) {
      return;
    }
    const suffix = `${targetMode}:${Date.now()}`;
    const base = {
      deviceId: deviceInternalId,
      episodeId: daily.episodeId,
      dailyRecordId: daily.id,
      payload: { targetMode },
    };
    await this.prisma.adventureEvent.create({
      data: {
        ...base,
        eventKey: `daily:${daily.id}:entry_blocked:${suffix}`,
        eventType: "entry_blocked_completed",
      },
    });
    await this.prisma.adventureEvent.create({
      data: {
        ...base,
        eventKey: `daily:${daily.id}:routed_other_mode:${suffix}`,
        eventType: "routed_other_mode",
      },
    });
  }

  /** 重启恢复/漏网兜底：扫描所有超时等待记录并补触发 */
  async sweepTimeouts(): Promise<
    Array<{ deviceId: string; reply: AdventureReply }>
  > {
    const stale = await this.prisma.adventureProgress.findMany({
      where: {
        status: "awaiting_reply",
        waitingSince: {
          lte: new Date(Date.now() - REPLY_TIMEOUT_MS),
        },
      },
    });
    const recovered: Array<{ deviceId: string; reply: AdventureReply }> = [];
    for (const record of stale) {
      // 逐设备隔离：一台设备的病态数据不得让其余设备的超时恢复集体饿死。
      try {
        const reply = await this.checkTimeout(record.deviceId);
        if (reply) {
          recovered.push({ deviceId: record.deviceId, reply });
          await this.timeoutListener?.(record.deviceId, reply);
        }
      } catch (error) {
        this.logger.error(
          `Adventure timeout sweep skipped device ${record.deviceId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return recovered;
  }

  private scheduleTimeout(deviceInternalId: string) {
    this.clearTimer(deviceInternalId);
    const timer = setTimeout(async () => {
      try {
        const reply = await this.checkTimeout(deviceInternalId);
        if (reply && this.timeoutListener) {
          await this.timeoutListener(deviceInternalId, reply);
        }
      } catch (error) {
        this.logger.error(
          `Adventure timeout fired failed for ${deviceInternalId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }, REPLY_TIMEOUT_MS);
    // 不阻塞进程退出（测试与停机友好）
    timer.unref();
    this.timers.set(deviceInternalId, timer);
  }

  private clearTimer(deviceInternalId: string) {
    const timer = this.timers.get(deviceInternalId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(deviceInternalId);
    }
  }
}
