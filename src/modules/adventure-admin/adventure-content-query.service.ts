import { Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AdventureEpisode,
  AdventureEpisodeVersion,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  ADVENTURE_CHARACTER_KEYS,
  ADVENTURE_INTERACTION_TYPES,
  ADVENTURE_SEASON,
  AdventureCharacterKey,
  EpisodeContentDraft,
  EpisodeIdentity,
  REPLY_WAITING_INTERACTION_TYPES,
  businessKey,
} from "./adventure-content.types";
import {
  LintContext,
  LintReport,
  LintThresholds,
  DEFAULT_LINT_THRESHOLDS,
  lintEpisode,
} from "./adventure-linter";
import {
  BundleEpisode,
  SegmentDiff,
  diffEpisodes,
  toBundleEpisode,
} from "./adventure-bundle";
import {
  DEFAULT_SIMULATION_THRESHOLDS,
  SimulationResult,
  SimulationThresholds,
  simulateEpisode,
} from "./adventure-simulator";

/**
 * 冒险内容读侧。
 *
 * 这里不做任何写入，存在的意义是让 admin 在动手之前先看见真相：
 * 一集今天有多少孩子在玩、有多少设备被锁在旧版本、版本谱系长什么样、
 * 现在编辑的草稿是基于哪一个版本。破坏性操作的确认弹窗全靠这些数字，
 * 所以「影响面」是读侧的一等公民，不是附带信息。
 *
 * 内容一律经 `toBundleEpisode` 的白名单补全后再返回：表单拿到的每一段字段齐全，
 * 不会出现 undefined 空洞，也不会把历史脏字段透传给前端。
 */

export const SEGMENT_KINDS = ["narration", "interaction"] as const;

/** 进度终态：这些设备已经不在播，统计「被锁在旧版本」时必须排除。 */
const CLOSED_PROGRESS_STATUSES = ["completed", "abandoned"];

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface ContentAdminProfileCapabilities {
  season: number;
  characterKeys: AdventureCharacterKey[];
  interactionTypes: string[];
  replyWaitingInteractionTypes: string[];
  segmentKinds: string[];
  lintThresholds: LintThresholds;
  simulationThresholds: SimulationThresholds;
  /** authoring / readonly，来自 CONTENT_ADMIN_PROFILE；缺省按 readonly 处理（fail-safe） */
  profile: string;
  authoring: boolean;
}

export interface EpisodeListFilter {
  characterKey?: string;
  published?: boolean;
  includeRetired?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface EpisodeSummary {
  id: string;
  characterKey: string;
  season: number;
  episodeNumber: number;
  businessKey: string;
  title: string;
  recap: string | null;
  published: boolean;
  retiredAt: Date | null;
  currentVersionId: string | null;
  currentVersion: number | null;
  publishedAt: Date | null;
  hasDraft: boolean;
  draftVersionId: string | null;
  draftVersion: number | null;
  draftUpdatedAt: Date | null;
  draftUpdatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 一次 retire 到底会影响多少孩子。确认弹窗必须先展示这些数字。 */
export interface EpisodeImpact {
  /** 今日已分配且仍在播的设备：retire 不会打断它们 */
  devicesPlayingToday: number;
  /** 跨天陈旧的在播设备：retire 会把它们收走，下次开机换一集 */
  devicesStaleCrossDay: number;
  /** 仍被锁在旧版本快照上的在播设备：说明历史发布确实造成了并行版本 */
  devicesPinnedToOlderVersions: number;
  totalDevicesEverStarted: number;
  publishedVersionCount: number;
}

export interface VersionSummary {
  id: string;
  version: number;
  status: string;
  contentHash: string | null;
  changeNote: string | null;
  createdBy: string;
  createdByName: string;
  publishedAt: Date | null;
  publishedBy: string | null;
  supersededById: string | null;
  createdAt: Date;
  updatedAt: Date;
  title: string;
  segmentCount: number;
  /** 是否为 episode.currentVersionId 指向的那一版 */
  isCurrent: boolean;
}

export interface EpisodeDetail {
  summary: EpisodeSummary;
  /** 编辑器应加载的内容：草稿优先，其次当前发布版，最后是空壳 */
  content: EpisodeContentDraft;
  contentSource: "draft" | "published" | "empty";
  /** 乐观锁基线：保存草稿时必须原样带回，变了说明有人抢先改过 */
  baseVersionId: string | null;
  lint: LintReport;
  impact: EpisodeImpact;
}

export interface VersionDetail {
  meta: VersionSummary;
  content: EpisodeContentDraft;
}

export interface VersionDiffSide {
  versionId: string;
  version: number;
  status: string;
  businessKey: string;
  episode: BundleEpisode;
}

export interface VersionDiffResult {
  left: VersionDiffSide;
  right: VersionDiffSide;
  titleChanged: boolean;
  recapChanged: boolean;
  added: SegmentDiff[];
  removed: SegmentDiff[];
  changed: SegmentDiff[];
  segmentDiffs: SegmentDiff[];
}

export interface CheckContentIdentity extends EpisodeIdentity {
  forPublish?: boolean;
}

@Injectable()
export class AdventureContentQueryService {
  private readonly profile: string;
  private readonly lintOverrides: Partial<LintThresholds>;
  private readonly simulationOverrides: Partial<SimulationThresholds>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    // 缺省 readonly：环境变量漏配时宁可让写操作被拒，也不能让 prod 意外可写
    this.profile =
      this.configService.get<string>("CONTENT_ADMIN_PROFILE") === "authoring"
        ? "authoring"
        : "readonly";
    this.lintOverrides = {
      maxInteractionTextChars: this.number(
        "ADVENTURE_LINT_MAX_INTERACTION_CHARS",
        DEFAULT_LINT_THRESHOLDS.maxInteractionTextChars,
      ),
      maxNarrationTextChars: this.number(
        "ADVENTURE_LINT_MAX_NARRATION_CHARS",
        DEFAULT_LINT_THRESHOLDS.maxNarrationTextChars,
      ),
      maxTitleChars: this.number(
        "ADVENTURE_LINT_MAX_TITLE_CHARS",
        DEFAULT_LINT_THRESHOLDS.maxTitleChars,
      ),
      maxStarsPerEpisode: this.number(
        "ADVENTURE_LINT_MAX_STARS_PER_EPISODE",
        DEFAULT_LINT_THRESHOLDS.maxStarsPerEpisode,
      ),
      minChoiceKeyChars: this.number(
        "ADVENTURE_LINT_MIN_CHOICE_KEY_CHARS",
        DEFAULT_LINT_THRESHOLDS.minChoiceKeyChars,
      ),
      minChoiceTextChars: this.number(
        "ADVENTURE_LINT_MIN_CHOICE_TEXT_CHARS",
        DEFAULT_LINT_THRESHOLDS.minChoiceTextChars,
      ),
      forbiddenWords: this.wordList(
        "ADVENTURE_LINT_FORBIDDEN_WORDS",
        DEFAULT_LINT_THRESHOLDS.forbiddenWords,
      ),
    };
    this.simulationOverrides = {
      maxAwaitPoints: this.number(
        "ADVENTURE_SIM_MAX_AWAIT_POINTS",
        DEFAULT_SIMULATION_THRESHOLDS.maxAwaitPoints,
      ),
      maxSessionSeconds: this.number(
        "ADVENTURE_SIM_MAX_SESSION_SECONDS",
        DEFAULT_SIMULATION_THRESHOLDS.maxSessionSeconds,
      ),
    };
  }

  private number(key: string, fallback: number): number {
    return Number(this.configService.get<string>(key)) || fallback;
  }

  private wordList(key: string, fallback: string[]): string[] {
    const raw = this.configService.get<string>(key);
    if (!raw) {
      return fallback;
    }
    const words = raw
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return words.length > 0 ? words : fallback;
  }

  capabilities(): ContentAdminProfileCapabilities {
    return {
      season: ADVENTURE_SEASON,
      characterKeys: [...ADVENTURE_CHARACTER_KEYS],
      interactionTypes: [...ADVENTURE_INTERACTION_TYPES],
      replyWaitingInteractionTypes: [...REPLY_WAITING_INTERACTION_TYPES],
      segmentKinds: [...SEGMENT_KINDS],
      lintThresholds: { ...DEFAULT_LINT_THRESHOLDS, ...this.lintOverrides },
      simulationThresholds: {
        ...DEFAULT_SIMULATION_THRESHOLDS,
        ...this.simulationOverrides,
      },
      profile: this.profile,
      authoring: this.profile === "authoring",
    };
  }

  /** 与引擎 dateKey() 完全一致：服务器本地时区、零填充，可直接做字典序比较。 */
  dateKey(date = new Date()): string {
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${mm}-${dd}`;
  }

  async listEpisodes(
    filter: EpisodeListFilter = {},
  ): Promise<{ items: EpisodeSummary[]; total: number }> {
    const where: Prisma.AdventureEpisodeWhereInput = {
      season: ADVENTURE_SEASON,
    };
    if (
      filter.characterKey &&
      (ADVENTURE_CHARACTER_KEYS as readonly string[]).includes(
        filter.characterKey,
      )
    ) {
      where.characterKey = filter.characterKey;
    }
    if (typeof filter.published === "boolean") {
      where.published = filter.published;
    }
    if (!filter.includeRetired) {
      where.retiredAt = null;
    }
    const search = (filter.search ?? "").trim();
    if (search) {
      where.OR = [{ title: { contains: search } }];
      if (/^\d+$/.test(search)) {
        where.OR.push({ episodeNumber: Number(search) });
      }
    }

    const pageSize = boundedPageSize(filter.pageSize);
    const page = boundedPage(filter.page);
    const [rows, total] = await Promise.all([
      this.prisma.adventureEpisode.findMany({
        where,
        orderBy: [{ characterKey: "asc" }, { episodeNumber: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.adventureEpisode.count({ where }),
    ]);
    if (rows.length === 0) {
      return { items: [], total };
    }

    const versionRows = await this.prisma.adventureEpisodeVersion.findMany({
      where: {
        episodeId: { in: rows.map((row) => row.id) },
        status: { in: ["draft", "published"] },
      },
      orderBy: { version: "desc" },
    });
    const byEpisode = new Map<string, typeof versionRows>();
    for (const row of versionRows) {
      const bucket = byEpisode.get(row.episodeId) ?? [];
      bucket.push(row);
      byEpisode.set(row.episodeId, bucket);
    }

    const items = rows.map((episode) => {
      const versions = (byEpisode.get(episode.id) ?? []).filter(
        (row) => row.status === "draft" || row.status === "published",
      );
      const draft = versions.find((row) => row.status === "draft") ?? null;
      const published = versions.find((row) => row.status === "published");
      return toSummary(episode, draft, published ?? null);
    });
    return { items, total };
  }

  async getEpisode(episodeId: string): Promise<EpisodeDetail> {
    const episode = await this.loadEpisode(episodeId);
    const identity = episodeIdentity(episode);
    const draft = await this.prisma.adventureEpisodeVersion.findFirst({
      where: { episodeId, status: "draft" },
      orderBy: { version: "desc" },
    });
    const published = episode.currentVersionId
      ? await this.prisma.adventureEpisodeVersion.findUnique({
          where: { id: episode.currentVersionId },
        })
      : null;

    let content: EpisodeContentDraft;
    let contentSource: EpisodeDetail["contentSource"];
    let baseVersionId: string | null;
    if (draft) {
      content = contentFromPayload(identity, draft.payload);
      contentSource = "draft";
      baseVersionId = draft.id;
    } else if (published) {
      content = contentFromPayload(identity, published.payload);
      contentSource = "published";
      baseVersionId = published.id;
    } else {
      // 从未有过版本：用物化在 episode 行上的标题/回顾搭一个空壳，
      // 让编辑器打开就是可填的表单，而不是白屏。
      content = contentFromPayload(identity, {
        title: episode.title,
        recap: episode.recap,
        segments: [],
      });
      contentSource = "empty";
      baseVersionId = null;
    }

    const [lint, impact] = await Promise.all([
      this.lintFor(identity, content),
      this.impactFor(episode),
    ]);
    return {
      summary: toSummary(episode, draft, published),
      content,
      contentSource,
      baseVersionId,
      lint,
      impact,
    };
  }

  async listVersions(episodeId: string): Promise<VersionSummary[]> {
    const episode = await this.loadEpisode(episodeId);
    const rows = await this.prisma.adventureEpisodeVersion.findMany({
      where: { episodeId },
      orderBy: { version: "desc" },
    });
    return rows.map((row) => toVersionSummary(row, episode.currentVersionId));
  }

  async getVersion(
    episodeId: string,
    versionId: string,
  ): Promise<VersionDetail> {
    const episode = await this.loadEpisode(episodeId);
    const row = await this.loadVersion(episodeId, versionId);
    return {
      meta: toVersionSummary(row, episode.currentVersionId),
      content: contentFromPayload(episodeIdentity(episode), row.payload),
    };
  }

  async diffVersions(
    episodeId: string,
    leftVersionId: string,
    rightVersionId: string,
  ): Promise<VersionDiffResult> {
    const episode = await this.loadEpisode(episodeId);
    const identity = episodeIdentity(episode);
    const [left, right] = await Promise.all([
      this.loadVersion(episodeId, leftVersionId),
      this.loadVersion(episodeId, rightVersionId),
    ]);
    const leftEpisode = toBundleEpisode(
      identity,
      contentFromPayload(identity, left.payload),
    );
    const rightEpisode = toBundleEpisode(
      identity,
      contentFromPayload(identity, right.payload),
    );
    const diff = diffEpisodes(leftEpisode, rightEpisode);
    return {
      left: toDiffSide(left, identity, leftEpisode),
      right: toDiffSide(right, identity, rightEpisode),
      titleChanged: diff.titleChanged,
      recapChanged: diff.recapChanged,
      added: diff.segmentDiffs.filter((item) => item.change === "added"),
      removed: diff.segmentDiffs.filter((item) => item.change === "removed"),
      changed: diff.segmentDiffs.filter((item) => item.change === "modified"),
      segmentDiffs: diff.segmentDiffs,
    };
  }

  async retireImpact(episodeId: string): Promise<EpisodeImpact> {
    return this.impactFor(await this.loadEpisode(episodeId));
  }

  /** 实时校验：编辑器每次改动后调用，不写库。 */
  async checkContent(
    episodeId: string | null,
    content: EpisodeContentDraft,
    identity?: CheckContentIdentity,
  ): Promise<LintReport> {
    let resolvedIdentity = identity;
    let ownBusinessKey: string | undefined;
    if (episodeId) {
      const episode = await this.loadEpisode(episodeId);
      ownBusinessKey = businessKey(episodeIdentity(episode));
      if (!resolvedIdentity) {
        resolvedIdentity = episodeIdentity(episode);
      }
    }
    if (!resolvedIdentity) {
      return lintEpisode(
        { characterKey: "elly", season: ADVENTURE_SEASON, episodeNumber: 0 },
        content,
        {},
        this.lintOverrides,
      );
    }
    const context = await this.lintContextFor(
      resolvedIdentity.characterKey,
      resolvedIdentity.season,
      ownBusinessKey,
      resolvedIdentity.forPublish === true,
    );
    return lintEpisode(resolvedIdentity, content, context, this.lintOverrides);
  }

  /** 试播：纯计算，不查库，编辑器可以随便点。 */
  simulate(
    identity: EpisodeIdentity,
    content: EpisodeContentDraft,
  ): SimulationResult {
    return simulateEpisode(identity, content, this.simulationOverrides);
  }

  async loadEpisode(episodeId: string): Promise<AdventureEpisode> {
    const episode = await this.prisma.adventureEpisode.findUnique({
      where: { id: episodeId },
    });
    if (!episode) {
      throw new NotFoundException(`故事集不存在：${episodeId}`);
    }
    return episode;
  }

  private async loadVersion(episodeId: string, versionId: string) {
    const row = await this.prisma.adventureEpisodeVersion.findUnique({
      where: { id: versionId },
    });
    // 版本 id 是全局 uuid，但跨集访问等于越权读取别集内容，一律按不存在处理
    if (!row || row.episodeId !== episodeId) {
      throw new NotFoundException(
        `故事集 ${episodeId} 下不存在版本 ${versionId}`,
      );
    }
    return row;
  }

  private async lintContextFor(
    characterKey: string,
    season: number,
    ownBusinessKey: string | undefined,
    forPublish: boolean,
  ): Promise<LintContext> {
    const rows = await this.prisma.adventureEpisode.findMany({
      where: { characterKey, season },
      select: {
        characterKey: true,
        season: true,
        episodeNumber: true,
        published: true,
      },
    });
    return {
      takenBusinessKeys: rows.map((row) =>
        businessKey({
          characterKey: row.characterKey as AdventureCharacterKey,
          season: row.season,
          episodeNumber: row.episodeNumber,
        }),
      ),
      publishedEpisodeNumbers: rows
        .filter((row) => row.published)
        .map((row) => row.episodeNumber),
      ownBusinessKey,
      forPublish,
    };
  }

  private async lintFor(
    identity: EpisodeIdentity,
    content: EpisodeContentDraft,
  ): Promise<LintReport> {
    const context = await this.lintContextFor(
      identity.characterKey,
      identity.season,
      businessKey(identity),
      false,
    );
    return lintEpisode(identity, content, context, this.lintOverrides);
  }

  private async impactFor(episode: AdventureEpisode): Promise<EpisodeImpact> {
    const today = this.dateKey();
    const [playingToday, staleCrossDay, pinnedRows, totalStarted, versionRows] =
      await Promise.all([
        this.prisma.adventureDailyRecord.count({
          where: {
            episodeId: episode.id,
            status: "in_progress",
            assignedDate: today,
          },
        }),
        this.prisma.adventureDailyRecord.count({
          where: {
            episodeId: episode.id,
            status: "in_progress",
            assignedDate: { lt: today },
          },
        }),
        this.prisma.adventureProgress.findMany({
          where: { episodeId: episode.id, episodeVersionId: { not: null } },
          select: { deviceId: true, episodeVersionId: true, status: true },
        }),
        this.prisma.adventureProgress.count({
          where: { episodeId: episode.id },
        }),
        this.prisma.adventureEpisodeVersion.findMany({
          where: {
            episodeId: episode.id,
            status: { in: ["published", "superseded"] },
          },
          select: { id: true },
        }),
      ]);

    const devicesPinnedToOlderVersions = pinnedRows.filter(
      (row) =>
        !CLOSED_PROGRESS_STATUSES.includes(row.status) &&
        row.episodeVersionId !== episode.currentVersionId,
    ).length;

    return {
      devicesPlayingToday: playingToday,
      devicesStaleCrossDay: staleCrossDay,
      devicesPinnedToOlderVersions,
      totalDevicesEverStarted: totalStarted,
      publishedVersionCount: versionRows.length,
    };
  }
}

export function episodeIdentity(episode: AdventureEpisode): EpisodeIdentity {
  return {
    characterKey: episode.characterKey as AdventureCharacterKey,
    season: episode.season,
    episodeNumber: episode.episodeNumber,
  };
}

/** 版本 payload → 可编辑草稿。白名单补全，脏字段在这里被丢掉。 */
export function contentFromPayload(
  identity: EpisodeIdentity,
  payload: unknown,
): EpisodeContentDraft {
  const source = (payload ?? {}) as Partial<EpisodeContentDraft>;
  const normalized = toBundleEpisode(identity, {
    title: typeof source.title === "string" ? source.title : "",
    recap: source.recap ?? null,
    segments: Array.isArray(source.segments) ? source.segments : [],
  });
  return {
    title: normalized.title,
    recap: normalized.recap,
    segments: normalized.segments,
  };
}

type VersionRow = AdventureEpisodeVersion;

function toSummary(
  episode: AdventureEpisode,
  draft: VersionRow | null,
  published: VersionRow | null,
): EpisodeSummary {
  return {
    id: episode.id,
    characterKey: episode.characterKey,
    season: episode.season,
    episodeNumber: episode.episodeNumber,
    businessKey: businessKey(episodeIdentity(episode)),
    title: episode.title,
    recap: episode.recap,
    published: episode.published,
    retiredAt: episode.retiredAt,
    currentVersionId: episode.currentVersionId,
    currentVersion: published?.version ?? null,
    publishedAt: published?.publishedAt ?? null,
    hasDraft: !!draft,
    draftVersionId: draft?.id ?? null,
    draftVersion: draft?.version ?? null,
    draftUpdatedAt: draft?.updatedAt ?? null,
    draftUpdatedBy: draft?.createdByName ?? null,
    createdAt: episode.createdAt,
    updatedAt: episode.updatedAt,
  };
}

function toVersionSummary(
  row: VersionRow,
  currentVersionId: string | null,
): VersionSummary {
  const segments = Array.isArray(
    (row.payload as { segments?: unknown })?.segments,
  )
    ? (row.payload as { segments: unknown[] }).segments
    : [];
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    contentHash: row.contentHash,
    changeNote: row.changeNote,
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
    supersededById: row.supersededById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    title:
      typeof (row.payload as { title?: unknown })?.title === "string"
        ? (row.payload as { title: string }).title
        : "",
    segmentCount: segments.length,
    isCurrent: row.id === currentVersionId,
  };
}

function toDiffSide(
  row: VersionRow,
  identity: EpisodeIdentity,
  episode: BundleEpisode,
): VersionDiffSide {
  return {
    versionId: row.id,
    version: row.version,
    status: row.status,
    businessKey: businessKey(identity),
    episode,
  };
}

function boundedPageSize(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(value), MAX_PAGE_SIZE);
}

function boundedPage(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.floor(value);
}
