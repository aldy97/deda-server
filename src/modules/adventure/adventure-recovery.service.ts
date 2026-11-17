import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AdventureEpisode, AdventureSegment, Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  AdventureCircuitBreaker,
  BreakerState,
} from "./adventure-circuit-breaker.service";
import {
  ADVENTURE_ENGINE_FAILURE_LIMIT,
  ADVENTURE_RECOVERY_ALERT_MARKER,
  ADVENTURE_RECOVERY_DEFAULTS,
  ADVENTURE_RECOVERY_ENV,
  ADVENTURE_SWEEP_HISTORY_LIMIT,
  AdventureFailureReport,
  EngineFailureRecord,
} from "./adventure.constants";
import { adventureDateKey } from "./adventure-date.util";
import {
  AdventureService,
  EpisodeContent,
  PlayableSegment,
  parseEpisodePayload,
} from "./adventure.service";

/** 巡检读到的行形状：进度/daily 都带 episode，一次查询取全，避免 N+1 */
type ProgressWithEpisode = Prisma.AdventureProgressGetPayload<{
  include: { episode: true };
}>;
type DailyWithEpisode = Prisma.AdventureDailyRecordGetPayload<{
  include: { episode: true };
}>;

/**
 * 「今天」的日键。刻意经由 Date.now() 取时钟而不是 new Date()：本服务其余的时间
 * 判定（挂起超时、引擎失败窗口、巡检耗时）全部基于 Date.now()，两处时钟必须同源。
 * 分家的后果很具体——detector 6 会拿真实日历日去判定「跨天」，而同一次巡检里
 * 「挂起多久」用的却是另一个时钟；测试里 mock 了 Date.now() 也管不住这一处。
 * 生产语义零变化：Date.now() 与 new Date() 读的是同一个墙钟。
 */
function todayKey(): string {
  return adventureDateKey(new Date(Date.now()));
}

/** 巡检关心的进度状态：只有「还在飞」的行可能病态，终态行一律不碰。 */
const ACTIVE_PROGRESS_STATUSES = ["in_progress", "awaiting_reply"];

/** 进度终态：与引擎的 CLOSED_PROGRESS_STATUSES 同义 */
const TERMINAL_PROGRESS_STATUSES = ["completed", "abandoned"];

/** 已被收走、引擎会重新分配的进度状态 */
const REASSIGNABLE_PROGRESS_STATUSES = ["abandoned", "failed_over"];

/** 病态类型。每个 code 都对应一条「为什么这样处置最安全」的论证，见各 detector。 */
export type RecoveryCode =
  | "STALE_AWAITING_REPLY"
  | "AWAITING_NON_INTERACTION"
  | "VERSION_ROW_MISSING"
  | "VERSION_PAYLOAD_UNUSABLE"
  | "SEGMENT_ORDER_OVERFLOW"
  | "DAILY_PROGRESS_STATE_CONFLICT"
  | "RETIRED_STALE_DAILY"
  | "SEGMENT_TABLE_DRIFT"
  | "DAILY_WITHOUT_PLAYABLE_PROGRESS";

export interface RepairRecord {
  code: RecoveryCode;
  deviceId: string;
  episodeId: string;
  dailyRecordId: string | null;
  progressId: string | null;
  target: "progress" | "daily";
  from: string;
  to: string;
  detail: string;
}

export interface AlertRecord {
  code: RecoveryCode;
  deviceId: string | null;
  episodeId: string;
  progressId?: string | null;
  dailyRecordId?: string | null;
  detail: string;
}

export interface SweepReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** kill switch 关闭时为 true，此时不扫库、不修任何东西 */
  skipped: boolean;
  reason: string | null;
  scanned: { progresses: number; dailyRecords: number; episodes: number };
  repairs: RepairRecord[];
  alerts: AlertRecord[];
  errors: string[];
}

export interface RecoveryHealthSnapshot {
  breaker: BreakerState;
  config: {
    enabled: boolean;
    sweepIntervalMs: number;
    staleAwaitMs: number;
    staleAwaitAction: StaleAwaitAction;
    breakerWindowMs: number;
    breakerThreshold: number;
    breakerTrippedTtlSeconds: number;
  };
  sweeps: SweepReport[];
  engineFailures: EngineFailureRecord[];
}

type StaleAwaitAction = "off" | "alert" | "exit";

/** 版本快照的三种解析结果；缺行与坏 payload 要分开报，处置建议不同 */
type VersionEntry =
  | { kind: "missing" }
  | { kind: "unusable" }
  | { kind: "ok"; content: EpisodeContent };

type ResolvedSegments = {
  segments: PlayableSegment[];
  issue: { code: RecoveryCode; detail: string } | null;
};

/**
 * 冒险自愈巡检（L4 兜底）。
 *
 * 它解决的问题：引擎的兜底都发生在「孩子开口那一刻」，可如果状态已经坏到
 * 连那一刻都走不通（等待态指向一个不再是互动点的段落、daily 与 progress 打架、
 * retire 之后跨天的 daily 永久卡在 in_progress），孩子面对的就是无限沉默，
 * 而后台什么也看不见。巡检把这些静默病态找出来、修成「下次孩子开口就能自然
 * 恢复」的状态，并留下可观测记录。
 *
 * 安全边界（比修得全更重要）：
 * - **绝不改写内容**。内容真相只由 admin 的发布/回滚动作产生；巡检自动改内容
 *   等于在无人监督时换掉孩子正在听的故事。
 * - **绝不调用 recoverToNextEpisode**。那会在孩子不在场时静默烧掉当日分配，
 *   甚至把 daily 跑成 completed、吃掉孩子今天的额度。巡检只把病态标成
 *   exited / abandoned / failed_over 这类「下次开口自然恢复」的状态。
 * - **每台设备、每个 detector 各自 try/catch**：一台坏了不影响其他台。
 * - **一次巡检最多向熔断器记一次失败**：上百台设备同时病态时，
 *   逐台记会瞬间打爆阈值，告警就失去了信息量。
 * - 不写 adventureEvent：那张表的 deviceId/episodeId/dailyRecordId 都是非空
 *   且带 FK，而 detector 手上不一定有 dailyRecordId；宁可少一条持久记录，
 *   也不为了留痕去造一个假的关联 id。记录走日志固定标记 + 内存环形缓冲。
 */
@Injectable()
export class AdventureRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdventureRecoveryService.name);
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly sweepHistory: SweepReport[] = [];
  private readonly engineFailures: EngineFailureRecord[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly adventureService: AdventureService,
    private readonly breaker: AdventureCircuitBreaker,
  ) {}

  onModuleInit(): void {
    if (!this.isEnabled()) {
      this.logger.warn(
        `${ADVENTURE_RECOVERY_ENV.enabled} is off: adventure recovery sweep disabled`,
      );
      return;
    }
    this.adventureService.registerFailureListener(async (report) => {
      await this.handleEngineFailure(report);
    });
    const intervalMs = this.resolveNumber(
      ADVENTURE_RECOVERY_ENV.sweepIntervalMs,
      ADVENTURE_RECOVERY_DEFAULTS.sweepIntervalMs,
    );
    // 刻意不在启动瞬间先跑一次：多副本同时重启会造成一波无意义的并发扫描，
    // 等一个周期再跑，病态最多晚 intervalMs 被发现，代价可接受。
    this.sweepTimer = setInterval(() => {
      void this.sweepBrokenProgress().catch((error: unknown) => {
        this.logger.error(
          `Adventure recovery sweep crashed: ${this.describe(error)}`,
        );
      });
    }, intervalMs);
    this.sweepTimer.unref();
    this.logger.log(
      `Adventure recovery sweep started, intervalMs=${intervalMs}`,
    );
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** 引擎兜底失败上报：记入缓冲 + 计数到熔断器。尽力而为，绝不影响主链路。 */
  private async handleEngineFailure(
    report: AdventureFailureReport,
  ): Promise<void> {
    try {
      this.engineFailures.unshift({
        deviceId: report.deviceInternalId,
        phase: report.phase,
        reason: report.reason,
        recovered: report.recovered,
        at: report.at,
      });
      if (this.engineFailures.length > ADVENTURE_ENGINE_FAILURE_LIMIT) {
        this.engineFailures.length = ADVENTURE_ENGINE_FAILURE_LIMIT;
      }
      await this.breaker.recordFailure(
        `engine:${report.phase}:${report.reason}`.slice(0, 160),
      );
    } catch (error) {
      this.logger.warn(
        `Adventure engine failure reporting degraded: ${this.describe(error)}`,
      );
    }
  }

  async sweepBrokenProgress(): Promise<SweepReport> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    if (!this.isEnabled()) {
      const skipped: SweepReport = {
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
        skipped: true,
        reason: `${ADVENTURE_RECOVERY_ENV.enabled}=false：巡检已被 kill switch 关闭，未扫库、未修改任何状态`,
        scanned: { progresses: 0, dailyRecords: 0, episodes: 0 },
        repairs: [],
        alerts: [],
        errors: [],
      };
      this.pushHistory(skipped);
      return skipped;
    }

    const repairs: RepairRecord[] = [];
    const alerts: AlertRecord[] = [];
    const errors: string[] = [];
    // 同一次巡检内去重：内容级问题（版本缺行、段落漂移）只报一次，
    // 否则 100 个孩子 pin 同一个坏版本就会刷出 100 条一模一样的告警。
    const notified = new Set<string>();
    const repairedProgressIds = new Set<string>();
    let progresses: ProgressWithEpisode[] = [];
    let dailyRecords: DailyWithEpisode[] = [];

    try {
      progresses = await this.prisma.adventureProgress.findMany({
        where: { status: { in: ACTIVE_PROGRESS_STATUSES } },
        include: { episode: true },
      });
      dailyRecords = await this.prisma.adventureDailyRecord.findMany({
        where: { status: "in_progress" },
        include: { episode: true },
      });
    } catch (error) {
      errors.push(`扫描查询失败：${this.describe(error)}`);
      return this.finish(startedAt, startedAtMs, repairs, alerts, errors, {
        progresses: 0,
        dailyRecords: 0,
        episodes: 0,
      });
    }

    const versionCache = new Map<string, VersionEntry>();
    for (const progress of progresses) {
      try {
        await this.inspectProgress(
          progress,
          versionCache,
          notified,
          repairedProgressIds,
          repairs,
          alerts,
        );
      } catch (error) {
        errors.push(
          `progress ${progress.id} device=${progress.deviceId}：${this.describe(
            error,
          )}`,
        );
      }
    }

    const episodes = new Map<string, AdventureEpisode>();
    for (const progress of progresses) {
      if (progress.episode && !episodes.has(progress.episodeId)) {
        episodes.set(progress.episodeId, progress.episode);
      }
    }
    for (const episode of episodes.values()) {
      try {
        await this.inspectSegmentDrift(episode, alerts);
      } catch (error) {
        errors.push(
          `episode ${episode.id} 漂移比较失败：${this.describe(error)}`,
        );
      }
    }

    for (const daily of dailyRecords) {
      try {
        await this.inspectDaily(daily, repairedProgressIds, repairs, alerts);
      } catch (error) {
        errors.push(
          `daily ${daily.id} device=${daily.deviceId}：${this.describe(error)}`,
        );
      }
    }

    this.logAlerts(alerts);
    return this.finish(
      startedAt,
      startedAtMs,
      repairs,
      alerts,
      errors,
      {
        progresses: progresses.length,
        dailyRecords: dailyRecords.length,
        episodes: episodes.size,
      },
      repairedProgressIds,
    );
  }

  /** 面板用：熔断状态 + 生效阈值 + 最近巡检（新→旧）+ 最近引擎失败。 */
  async getHealthSnapshot(): Promise<RecoveryHealthSnapshot> {
    return {
      breaker: await this.breaker.getState(),
      config: {
        enabled: this.isEnabled(),
        sweepIntervalMs: this.resolveNumber(
          ADVENTURE_RECOVERY_ENV.sweepIntervalMs,
          ADVENTURE_RECOVERY_DEFAULTS.sweepIntervalMs,
        ),
        staleAwaitMs: this.resolveNumber(
          ADVENTURE_RECOVERY_ENV.staleAwaitMs,
          ADVENTURE_RECOVERY_DEFAULTS.staleAwaitMs,
        ),
        staleAwaitAction: this.staleAwaitAction(),
        breakerWindowMs: this.resolveNumber(
          ADVENTURE_RECOVERY_ENV.breakerWindowMs,
          ADVENTURE_RECOVERY_DEFAULTS.breakerWindowMs,
        ),
        breakerThreshold: this.resolveNumber(
          ADVENTURE_RECOVERY_ENV.breakerThreshold,
          ADVENTURE_RECOVERY_DEFAULTS.breakerThreshold,
        ),
        breakerTrippedTtlSeconds: this.resolveNumber(
          ADVENTURE_RECOVERY_ENV.breakerTrippedTtlSeconds,
          ADVENTURE_RECOVERY_DEFAULTS.breakerTrippedTtlSeconds,
        ),
      },
      sweeps: [...this.sweepHistory],
      engineFailures: [...this.engineFailures],
    };
  }

  /** 手动清除熔断标记（admin 动作，写操作，不豁免只读门禁） */
  async resetBreaker(): Promise<void> {
    await this.breaker.reset();
  }

  // ---------------------------------------------------------------- detectors

  /**
   * 进度行层面的病态（detector 1–4）。
   * 顺序刻意是「越界 → 等待态错位 → 陈旧等待」：越界是更硬的病，
   * 一旦处置就不再对同一行叠加第二次修改。
   */
  private async inspectProgress(
    progress: ProgressWithEpisode,
    versionCache: Map<string, VersionEntry>,
    notified: Set<string>,
    repairedProgressIds: Set<string>,
    repairs: RepairRecord[],
    alerts: AlertRecord[],
  ): Promise<void> {
    const resolved = await this.resolveSegments(
      progress,
      versionCache,
      notified,
    );
    if (resolved.issue) {
      alerts.push({
        code: resolved.issue.code,
        deviceId: null,
        episodeId: progress.episodeId,
        progressId: progress.id,
        detail: resolved.issue.detail,
      });
    }
    const segments = resolved.segments;

    if (progress.nextSegmentOrder > segments.length) {
      const detail =
        `nextSegmentOrder=${progress.nextSegmentOrder} 越过段落末尾` +
        `（可播 ${segments.length} 段），episodeId=${progress.episodeId}`;
      if (progress.status === "awaiting_reply") {
        // 等待态越界：孩子永远等不到下一句，也不会再有任何东西推进它。
        // 改判 exited 让状态与事实一致，孩子当日再开口即可从原处续玩。
        await this.repairProgress(
          progress,
          "exited",
          "SEGMENT_ORDER_OVERFLOW",
          detail,
          repairedProgressIds,
          repairs,
        );
      }
      // 在播态越界不修：playFrom 的 isDone 判定会自然把它收成 completed，
      // 巡检抢跑反而可能把一次正常完集改写成中断。
      alerts.push({
        code: "SEGMENT_ORDER_OVERFLOW",
        deviceId: progress.deviceId,
        episodeId: progress.episodeId,
        progressId: progress.id,
        detail,
      });
      return;
    }

    if (progress.status !== "awaiting_reply") {
      return;
    }

    const target = segments.find(
      (segment) => segment.order === progress.nextSegmentOrder - 1,
    );
    if (!target || target.kind !== "interaction") {
      // 等待态却指着一个不是互动点的位置：孩子的回答会被 currentInteraction
      // 判成 null，掉进自由对话，冒险永久卡在原地且谁都看不见。
      const detail =
        `等待互动但 order=${progress.nextSegmentOrder - 1} 是 ` +
        `${target ? target.kind : "不存在的段落"}，episodeId=${progress.episodeId}`;
      await this.repairProgress(
        progress,
        "exited",
        "AWAITING_NON_INTERACTION",
        detail,
        repairedProgressIds,
        repairs,
      );
      alerts.push({
        code: "AWAITING_NON_INTERACTION",
        deviceId: progress.deviceId,
        episodeId: progress.episodeId,
        progressId: progress.id,
        detail,
      });
      return;
    }

    const action = this.staleAwaitAction();
    if (action === "off" || progress.waitingSince) {
      return;
    }
    const staleMs = this.resolveNumber(
      ADVENTURE_RECOVERY_ENV.staleAwaitMs,
      ADVENTURE_RECOVERY_DEFAULTS.staleAwaitMs,
    );
    const age = Date.now() - new Date(progress.updatedAt).getTime();
    if (!Number.isFinite(age) || age < staleMs) {
      return;
    }
    const detail =
      `等待互动 ${Math.round(age / 1000)}s 且 waitingSince 为空（阈值 ${staleMs}ms），` +
      `episodeId=${progress.episodeId}`;
    if (action === "exit") {
      await this.repairProgress(
        progress,
        "exited",
        "STALE_AWAITING_REPLY",
        detail,
        repairedProgressIds,
        repairs,
      );
    }
    alerts.push({
      code: "STALE_AWAITING_REPLY",
      deviceId: progress.deviceId,
      episodeId: progress.episodeId,
      progressId: progress.id,
      detail,
    });
  }

  /**
   * daily 行层面的病态（detector 5、6、8）。
   * findCurrentDaily 没有日期过滤，所以一行状态打架的 in_progress daily
   * 会被引擎一直捞到，是「孩子再也进不去冒险」的常见根因。
   */
  private async inspectDaily(
    daily: DailyWithEpisode,
    repairedProgressIds: Set<string>,
    repairs: RepairRecord[],
    alerts: AlertRecord[],
  ): Promise<void> {
    const progress = await this.prisma.adventureProgress.findUnique({
      where: {
        deviceId_episodeId: {
          deviceId: daily.deviceId,
          episodeId: daily.episodeId,
        },
      },
    });

    if (!progress) {
      alerts.push({
        code: "DAILY_WITHOUT_PLAYABLE_PROGRESS",
        deviceId: daily.deviceId,
        episodeId: daily.episodeId,
        dailyRecordId: daily.id,
        detail:
          "daily 在飞但进度行不存在；孩子下次开口时 startToday 会复用当日 daily 行并重建进度",
      });
      return;
    }

    // detector 5：两行状态打架。以 progress 为准收口 daily——
    // progress 是引擎唯一推进的对象，daily 只是额度账本。
    if (TERMINAL_PROGRESS_STATUSES.includes(progress.status)) {
      const data: Prisma.AdventureDailyRecordUpdateInput = {
        status: progress.status,
      };
      if (progress.status === "completed" && progress.completedAt) {
        // 完集日必须取 progress 的实际完集时间：写成今天会让昨天完集的孩子
        // 今天被 isCompletedToday 挡在门外，白丢一天额度。
        data.completedAt = progress.completedAt;
        data.completedDate = adventureDateKey(progress.completedAt);
      }
      await this.prisma.adventureDailyRecord.update({
        where: { id: daily.id },
        data,
      });
      repairs.push({
        code: "DAILY_PROGRESS_STATE_CONFLICT",
        deviceId: daily.deviceId,
        episodeId: daily.episodeId,
        dailyRecordId: daily.id,
        progressId: progress.id,
        target: "daily",
        from: daily.status,
        to: String(data.status),
        detail: `daily 仍为 ${daily.status}，但进度已是 ${progress.status}`,
      });
      return;
    }

    // detector 8：daily 在飞但进度已被收走（failed_over / abandoned）。
    // 只告警不改：引擎下次 startToday 会复用当日 daily 行并重新分配，
    // 巡检在这里改状态反而可能与那次分配打架。
    if (REASSIGNABLE_PROGRESS_STATUSES.includes(progress.status)) {
      alerts.push({
        code: "DAILY_WITHOUT_PLAYABLE_PROGRESS",
        deviceId: daily.deviceId,
        episodeId: daily.episodeId,
        dailyRecordId: daily.id,
        progressId: progress.id,
        detail: `daily 在飞但进度已被收走（${progress.status}）；孩子下次开口时引擎会重新分配`,
      });
      return;
    }

    // detector 6：retire 的跨天遗留。retire() 刻意不打断当日在播的孩子
    //（对的设计），但第二天这些行就成了永久卡点——孩子会一直重听已下架的集，
    // 而且 daily 卡在 in_progress 会挡住新分配。语义与 retire() 保持一致：
    // abandoned（永不重新分配），而不是 failed_over（内容修好还能回来）。
    const episode = daily.episode;
    if (daily.assignedDate < todayKey() && episode?.retiredAt) {
      await this.prisma.adventureDailyRecord.update({
        where: { id: daily.id },
        data: { status: "abandoned" },
      });
      repairs.push({
        code: "RETIRED_STALE_DAILY",
        deviceId: daily.deviceId,
        episodeId: daily.episodeId,
        dailyRecordId: daily.id,
        progressId: progress.id,
        target: "daily",
        from: daily.status,
        to: "abandoned",
        detail: `集已于 ${new Date(episode.retiredAt).toISOString()} 下架，${daily.assignedDate} 分配的 daily 仍卡在 in_progress`,
      });
      if (!repairedProgressIds.has(progress.id)) {
        await this.prisma.adventureProgress.update({
          where: { id: progress.id },
          data: { status: "abandoned", waitingSince: null },
        });
        repairedProgressIds.add(progress.id);
        repairs.push({
          code: "RETIRED_STALE_DAILY",
          deviceId: daily.deviceId,
          episodeId: daily.episodeId,
          dailyRecordId: daily.id,
          progressId: progress.id,
          target: "progress",
          from: progress.status,
          to: "abandoned",
          detail: "同步收走进度，避免孩子被重新分配回已下架的集",
        });
      }
    }
  }

  /** detector 7：物化副本与当前发布版漂移。只告警——重建副本是发布动作的职责。 */
  private async inspectSegmentDrift(
    episode: AdventureEpisode,
    alerts: AlertRecord[],
  ): Promise<void> {
    const versionId = episode.currentVersionId;
    if (!versionId) {
      return; // 从未发布过的草稿集：没有「应该一致」的基准
    }
    const row = await this.prisma.adventureEpisodeVersion.findUnique({
      where: { id: versionId },
      select: { id: true, payload: true },
    });
    if (!row) {
      return; // 版本行缺失由 detector 3 负责，这里不重复报
    }
    const content = parseEpisodePayload(row.payload);
    if (!content) {
      return; // payload 损坏同样归 detector 3
    }
    const rows = await this.prisma.adventureSegment.findMany({
      where: { episodeId: episode.id },
      orderBy: { order: "asc" },
    });
    const diff = this.diffSegments(content.segments, rows);
    if (diff) {
      alerts.push({
        code: "SEGMENT_TABLE_DRIFT",
        deviceId: null,
        episodeId: episode.id,
        detail: `adventure_segments 与发布版 v${row.id} 不一致：${diff}。仅影响未 pin 版本的历史进度`,
      });
    }
  }

  // ------------------------------------------------------------------ helpers

  private async repairProgress(
    progress: ProgressWithEpisode,
    to: string,
    code: RecoveryCode,
    detail: string,
    repairedProgressIds: Set<string>,
    repairs: RepairRecord[],
  ): Promise<void> {
    if (repairedProgressIds.has(progress.id)) {
      return; // 同一次巡检内一行只修一次
    }
    await this.prisma.adventureProgress.update({
      where: { id: progress.id },
      data: { status: to, waitingSince: null },
    });
    repairedProgressIds.add(progress.id);
    repairs.push({
      code,
      deviceId: progress.deviceId,
      episodeId: progress.episodeId,
      dailyRecordId: null,
      progressId: progress.id,
      target: "progress",
      from: progress.status,
      to,
      detail,
    });
  }

  private async resolveSegments(
    progress: ProgressWithEpisode,
    versionCache: Map<string, VersionEntry>,
    notified: Set<string>,
  ): Promise<ResolvedSegments> {
    const versionId: string | null = progress.episodeVersionId;
    if (!versionId) {
      return {
        segments: await this.loadTableSegments(progress.episodeId),
        issue: null,
      };
    }
    let entry = versionCache.get(versionId);
    if (!entry) {
      const row = await this.prisma.adventureEpisodeVersion.findUnique({
        where: { id: versionId },
        select: { id: true, payload: true },
      });
      if (!row) {
        entry = { kind: "missing" };
      } else {
        const content = parseEpisodePayload(row.payload);
        entry = content ? { kind: "ok", content } : { kind: "unusable" };
      }
      versionCache.set(versionId, entry);
    }
    if (entry.kind === "ok") {
      return { segments: entry.content.segments, issue: null };
    }
    // 引擎在这种情况下已经优雅回落到 segments 表，孩子照常能听。
    // 所以只告警：**改写 pin 会让孩子中途换版本，那比漂移严重得多**。
    const code: RecoveryCode =
      entry.kind === "missing"
        ? "VERSION_ROW_MISSING"
        : "VERSION_PAYLOAD_UNUSABLE";
    const detail =
      entry.kind === "missing"
        ? `进度锁定的版本行不存在（versionId=${versionId}），已回落 segments 表`
        : `进度锁定的版本 payload 不可解析（versionId=${versionId}），已回落 segments 表`;
    const issue = notified.has(`${code}:${versionId}`)
      ? null
      : { code, detail };
    if (issue) {
      notified.add(`${code}:${versionId}`);
    }
    return {
      segments: await this.loadTableSegments(progress.episodeId),
      issue,
    };
  }

  private async loadTableSegments(
    episodeId: string,
  ): Promise<PlayableSegment[]> {
    const rows = await this.prisma.adventureSegment.findMany({
      where: { episodeId },
      orderBy: { order: "asc" },
    });
    return rows.map((row: AdventureSegment) => ({
      order: row.order,
      kind: row.kind,
      text: row.text,
      interactionType: row.interactionType,
      options: row.options,
      fallbackText: row.fallbackText,
      exitText: row.exitText,
      rewardStar: row.rewardStar,
    }));
  }

  /** 段落漂移比较：先比段数，再逐位比 order/kind/text。返回一句话摘要或 null。 */
  private diffSegments(
    published: PlayableSegment[],
    rows: AdventureSegment[],
  ): string | null {
    if (published.length !== rows.length) {
      return `段数 ${rows.length} ≠ 发布版 ${published.length}`;
    }
    for (let i = 0; i < published.length; i++) {
      const expected = published[i];
      const actual = rows[i];
      if (Number(actual.order) !== expected.order) {
        return `第 ${i} 段 order ${actual.order} ≠ ${expected.order}`;
      }
      if (String(actual.kind) !== expected.kind) {
        return `order=${expected.order} kind ${actual.kind} ≠ ${expected.kind}`;
      }
      if (String(actual.text ?? "") !== expected.text) {
        return `order=${expected.order} text 与发布版不一致`;
      }
    }
    return null;
  }

  /**
   * 告警按 code 聚合成一行日志：一台设备一条会把日志刷爆，
   * 而固定标记 ADVENTURE_RECOVERY_ALERT 是日志告警规则的抓取点，不能省。
   */
  private logAlerts(alerts: AlertRecord[]): void {
    if (alerts.length === 0) return;
    const byCode = new Map<RecoveryCode, number>();
    for (const alert of alerts) {
      byCode.set(alert.code, (byCode.get(alert.code) ?? 0) + 1);
    }
    const summary = [...byCode.entries()]
      .map(([code, count]) => `${code}=${count}`)
      .join(" ");
    this.logger.warn(
      `${ADVENTURE_RECOVERY_ALERT_MARKER} total=${alerts.length} ${summary}`,
    );
  }

  private async finish(
    startedAt: string,
    startedAtMs: number,
    repairs: RepairRecord[],
    alerts: AlertRecord[],
    errors: string[],
    scanned: { progresses: number; dailyRecords: number; episodes: number },
    repairedProgressIds?: Set<string>,
  ): Promise<SweepReport> {
    const finishedAtMs = Date.now();
    const report: SweepReport = {
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      skipped: false,
      reason: null,
      scanned,
      repairs,
      alerts,
      errors,
    };
    this.pushHistory(report);
    if (repairs.length > 0) {
      // 一次巡检只记一次：熔断阈值描述的是「系统层面出事了」，
      // 不是「有多少台设备出事」。
      try {
        await this.breaker.recordFailure(
          `sweep repaired ${repairs.length} row(s): ` +
            [...new Set(repairs.map((repair) => repair.code))].join(","),
        );
      } catch (error) {
        // 熔断器只是观测面：它挂了不该让巡检结果丢失，也不该算巡检错误
        this.logger.warn(
          `Breaker recording after sweep failed: ${this.describe(error)}`,
        );
      }
    }
    if (repairedProgressIds && repairedProgressIds.size > 0) {
      this.logger.warn(
        `Adventure recovery repaired ${repairedProgressIds.size} progress row(s) and ${repairs.length} record(s) in total`,
      );
    }
    for (const error of errors) {
      this.logger.error(`Adventure recovery sweep error: ${error}`);
    }
    return report;
  }

  private pushHistory(report: SweepReport): void {
    this.sweepHistory.unshift(report);
    if (this.sweepHistory.length > ADVENTURE_SWEEP_HISTORY_LIMIT) {
      this.sweepHistory.length = ADVENTURE_SWEEP_HISTORY_LIMIT;
    }
  }

  private staleAwaitAction(): StaleAwaitAction {
    const raw = this.configService.get<string>(
      ADVENTURE_RECOVERY_ENV.staleAwaitAction,
    ) as string | undefined;
    const normalized = String(raw ?? "")
      .trim()
      .toLowerCase();
    if (normalized === "alert" || normalized === "exit") {
      return normalized;
    }
    return ADVENTURE_RECOVERY_DEFAULTS.staleAwaitAction;
  }

  private isEnabled(): boolean {
    const raw = this.configService.get<string>(
      ADVENTURE_RECOVERY_ENV.enabled,
    ) as string | undefined;
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return ADVENTURE_RECOVERY_DEFAULTS.enabled;
    }
    const normalized = String(raw).trim().toLowerCase();
    return normalized !== "false" && normalized !== "0";
  }

  private resolveNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key) as string | undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
