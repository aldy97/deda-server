import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { AdventureEpisodeVersion, Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AdventureAuditService, AuditActor } from "./adventure-audit.service";
import {
  AdventureContentQueryService,
  EpisodeImpact,
  contentFromPayload,
  episodeIdentity,
} from "./adventure-content-query.service";
import {
  EpisodeContentDraft,
  EpisodeIdentity,
  businessKey,
} from "./adventure-content.types";
import { LintReport } from "./adventure-linter";
import { episodeContentHash, toBundleEpisode } from "./adventure-bundle";

/**
 * 冒险内容写侧。三条不可让步的原则：
 *
 * 1. **没有硬删除。** 本服务不存在任何 delete 路径：retire 是墓碑，discard 是状态位，
 *    版本历史只增不改。任何环境（含 staging）都如此——「测试环境无所谓」是数据
 *    事故最常见的起点，而业务键永久占用是这套安全性的明码标价。
 *
 * 2. **已发布的内容不可原地修改。** 孩子可能正玩到一半，也可能明天接着玩。
 *    所以每次发布都产生新版本快照，进度行锁在自己那一版上（见 AdventureProgress.episodeVersionId）。
 *    「回滚」不是把历史改回去，而是把旧快照复制成一个新版本再发布，历史始终线性。
 *
 * 3. **破坏性动作必须先过闸。** 手输业务键 + 不少于 8 字的理由 + 影响面数字，
 *    且内容变更与审计写入必须同事务：审计写不进去，内容就不许改。
 */

/** 理由下限。审计的意义在于半年后还能看懂，「改一下」等于没写。 */
export const MIN_REASON_CHARS = 8;
export const MAX_REASON_CHARS = 300;

/**
 * 身份与儿童安全类错误：连草稿都不许落库。
 * 其余（缺文本、段号断档、选项不全……）属于「写到一半」，允许存草稿，只拦发布。
 */
export const DRAFT_BLOCKING_CODES = [
  "SEASON_UNSUPPORTED",
  "UNKNOWN_CHARACTER_KEY",
  "INVALID_EPISODE_NUMBER",
  "BUSINESS_KEY_TAKEN",
  "FORBIDDEN_WORD",
];

/** 可以作为回滚目标的版本状态：草稿与已废弃的都不是「曾经上线过」的内容。 */
const REVERTABLE_VERSION_STATUSES = ["published", "superseded"];

/**
 * retire 时可以收走的进度状态。
 * completed / abandoned 是终态，不许覆盖；failed_over 已被故障自愈收走，也不重复处理。
 */
const RETIRE_ABANDONABLE_STATUSES = ["in_progress", "awaiting_reply", "exited"];

export interface MutationOptions {
  reason?: string | null;
  /** 破坏性操作的确认文本，必须原样等于业务键 */
  confirmText?: string | null;
  /** 乐观锁基线：编辑器从 getEpisode 拿到的 baseVersionId */
  baseVersionId?: string | null;
  /** 明知有人在改也要覆盖（UI 上是一个单独的红色按钮） */
  force?: boolean;
}

export interface LintSummary {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface CreateEpisodeResult {
  episodeId: string;
  versionId: string;
  version: number;
  businessKey: string;
  contentHash: string;
  lint: LintReport;
}

export interface SaveDraftResult extends CreateEpisodeResult {
  created: boolean;
}

export interface PublishResult {
  episodeId: string;
  versionId: string;
  version: number;
  businessKey: string;
  contentHash: string;
  segmentCount: number;
  lint: LintReport;
  impact: EpisodeImpact;
  /** null = 自检本身失败（已记日志）；[] = 无漂移 */
  selfCheckDrift: string[] | null;
}

export interface RevertResult {
  episodeId: string;
  versionId: string;
  newVersion: number;
  businessKey: string;
  revertedToVersionId: string;
  revertedToVersion: number;
  /** 回滚不会动未发布的草稿；为 true 时 UI 必须提醒创作者草稿还在 */
  draftStillPending: boolean;
  lint: LintReport;
  impact: EpisodeImpact;
  selfCheckDrift: string[] | null;
}

export interface RetireResult {
  episodeId: string;
  businessKey: string;
  retiredAt: Date;
  impact: EpisodeImpact;
  staleDailyCount: number;
  abandonedProgressCount: number;
  message: string;
}

export interface RestoreResult {
  episodeId: string;
  businessKey: string;
  abandonedProgressNotRestored: number;
  message: string;
}

export interface DiscardDraftResult {
  episodeId: string;
  businessKey: string;
  discardedVersionId: string;
  version: number;
}

export interface DiscardEpisodeResult {
  episodeId: string;
  businessKey: string;
  discardedDraftCount: number;
  message: string;
}

/** 存进 AdventureEpisodeVersion.payload 的形状，与迁移回填的历史行保持一致。 */
interface EpisodePayload {
  title: string;
  recap: string | null;
  segments: EpisodeContentDraft["segments"];
}

type VersionRow = AdventureEpisodeVersion;

@Injectable()
export class AdventureContentService {
  private readonly logger = new Logger(AdventureContentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdventureAuditService,
    private readonly query: AdventureContentQueryService,
  ) {}

  /**
   * 新建一集。落库的是 episode 行 + version 1 草稿，不是一个「空壳集」。
   * 业务键由 @@unique([characterKey, season, episodeNumber]) 兜底，
   * 并发抢同一个集号时会撞 P2002，这里翻译成 409 而不是把 Prisma 错误漏给前端。
   */
  async createEpisode(
    identity: EpisodeIdentity,
    content: EpisodeContentDraft,
    actor: AuditActor,
    options: MutationOptions = {},
  ): Promise<CreateEpisodeResult> {
    const reason = assertReason(options.reason);
    const report = await this.query.checkContent(null, content, identity);
    assertNoDraftBlocking(report);
    const key = businessKey(identity);
    const payload = buildPayload(identity, content);
    assertNoSegmentLoss(identity, content, report);
    const contentHash = payloadHash(identity, content);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const episode = await tx.adventureEpisode.create({
          data: {
            characterKey: identity.characterKey,
            season: identity.season,
            episodeNumber: identity.episodeNumber,
            // title / recap 是「当前发布版本的物化副本」，草稿阶段先写进去，
            // 列表页不必为了显示标题去 join 版本表。
            title: payload.title,
            recap: payload.recap,
            published: false,
          },
        });
        const version = await tx.adventureEpisodeVersion.create({
          data: {
            episodeId: episode.id,
            version: 1,
            status: "draft",
            payload: jsonOf(payload),
            contentHash,
            changeNote: reason,
            createdBy: actor.username,
            createdByName: actor.displayName,
          },
        });
        await this.audit.record(
          actor,
          {
            action: "create",
            entityType: "episode",
            episodeId: episode.id,
            episodeVersionId: version.id,
            businessKey: key,
            reason,
            detail: { version: 1, lint: summarize(report) },
          },
          tx,
        );
        return {
          episodeId: episode.id,
          versionId: version.id,
          version: 1,
          businessKey: key,
          contentHash,
          lint: report,
        };
      });
    } catch (error) {
      throwIfBusinessKeyTaken(error, key);
      throw error;
    }
  }

  /**
   * 保存草稿。每集同时只有一个草稿，草稿**可变**——否则每敲一个字就多一个版本行，
   * 版本历史会被淹掉，真正需要回滚时找不到落点。
   *
   * 乐观锁：编辑器把 getEpisode 返回的 baseVersionId 原样带回来；
   * 对不上说明别人已经改过，返回 409 并附上对方草稿的信息，由人来决定加载还是覆盖。
   * 不带 baseVersionId 表示调用方明确不参与并发保护（只有导入链路会这样）。
   */
  async saveDraft(
    episodeId: string,
    content: EpisodeContentDraft,
    actor: AuditActor,
    options: MutationOptions = {},
  ): Promise<SaveDraftResult> {
    const reason = assertReason(options.reason);
    const episode = await this.query.loadEpisode(episodeId);
    const identity = episodeIdentity(episode);
    const key = businessKey(identity);
    const report = await this.query.checkContent(episodeId, content);
    assertNoDraftBlocking(report);
    assertNoSegmentLoss(identity, content, report);
    const payload = buildPayload(identity, content);
    const contentHash = payloadHash(identity, content);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const versions = await tx.adventureEpisodeVersion.findMany({
          where: { episodeId },
          orderBy: { version: "desc" },
        });
        const draft = findDraft(versions);
        if (
          draft &&
          !options.force &&
          options.baseVersionId &&
          options.baseVersionId !== draft.id
        ) {
          throw new ConflictException({
            message: `这一集的草稿已经被 ${draft.createdByName} 改过（v${draft.version}）。请选「加载对方版本」或「覆盖我的改动」。`,
            code: "DRAFT_CONFLICT",
            currentDraft: {
              id: draft.id,
              version: draft.version,
              updatedBy: draft.createdByName,
              updatedAt: draft.updatedAt,
            },
          });
        }
        const nextVersion = versions.length > 0 ? versions[0].version + 1 : 1;
        const version = draft
          ? await tx.adventureEpisodeVersion.update({
              where: { id: draft.id },
              data: {
                status: "draft",
                payload: jsonOf(payload),
                contentHash,
                changeNote: reason,
                createdBy: actor.username,
                createdByName: actor.displayName,
              },
            })
          : await tx.adventureEpisodeVersion.create({
              data: {
                episodeId,
                version: nextVersion,
                status: "draft",
                payload: jsonOf(payload),
                contentHash,
                changeNote: reason,
                createdBy: actor.username,
                createdByName: actor.displayName,
              },
            });
        await this.audit.record(
          actor,
          {
            action: draft ? "update_draft" : "create_draft",
            entityType: "episode_version",
            episodeId,
            episodeVersionId: version.id,
            businessKey: key,
            reason,
            detail: {
              version: draft ? draft.version : nextVersion,
              forced: options.force === true,
              lint: summarize(report),
            },
          },
          tx,
        );
        return {
          episodeId,
          versionId: version.id,
          version: draft ? draft.version : nextVersion,
          businessKey: key,
          contentHash,
          created: !draft,
          lint: report,
        };
      });
    } catch (error) {
      throwIfBusinessKeyTaken(error, key);
      throw error;
    }
  }

  /**
   * 发布：草稿晋升为新的当前版本，旧版本转 superseded，segments 表按新内容重建。
   *
   * 不需要手输确认——发布不会改写任何孩子正在玩的内容：在播设备锁在自己的版本快照上，
   * 只有之后新分配的设备才会拿到新版本。但仍要求理由，且返回影响面数字。
   */
  async publish(
    episodeId: string,
    actor: AuditActor,
    options: MutationOptions = {},
  ): Promise<PublishResult> {
    const reason = assertReason(options.reason);
    const episode = await this.query.loadEpisode(episodeId);
    if (episode.retiredAt) {
      throw new BadRequestException({
        message:
          "这一集已 retire（下架），不能直接发布。请先「恢复上架」，确认它该重新面对孩子之后再发布。",
        code: "EPISODE_RETIRED",
      });
    }
    const identity = episodeIdentity(episode);
    const key = businessKey(identity);
    const versions = await this.prisma.adventureEpisodeVersion.findMany({
      where: { episodeId },
      orderBy: { version: "desc" },
    });
    const draft = findDraft(versions);
    if (!draft) {
      throw new BadRequestException({
        message:
          "没有可发布的草稿。已发布的版本不可原地修改，只能由草稿晋升——请先保存草稿。",
        code: "NO_DRAFT",
      });
    }
    const content = contentFromPayload(identity, draft.payload);
    const report = await this.query.checkContent(episodeId, content, {
      ...identity,
      forPublish: true,
    });
    assertPublishable(report, "这一集");
    const contentHash = payloadHash(identity, content);
    const segmentRows = toSegmentRows(episodeId, content);
    const previous = versions.find((row) => row.status === "published") ?? null;

    const published = await this.prisma.$transaction(async (tx) => {
      if (previous) {
        await tx.adventureEpisodeVersion.update({
          where: { id: previous.id },
          data: { status: "superseded", supersededById: draft.id },
        });
      }
      await tx.adventureEpisodeVersion.update({
        where: { id: draft.id },
        data: {
          status: "published",
          publishedAt: new Date(),
          publishedBy: actor.username,
          contentHash,
        },
      });
      await tx.adventureEpisode.update({
        where: { id: episodeId },
        data: {
          published: true,
          currentVersionId: draft.id,
          title: content.title,
          recap: content.recap,
        },
      });
      // deleteMany + createMany 在事务内：READ COMMITTED 下其他读者看不到中间态，
      // 且没有任何表外键引用 adventure_segments。
      await tx.adventureSegment.deleteMany({ where: { episodeId } });
      await tx.adventureSegment.createMany({ data: segmentRows });
      await this.audit.record(
        actor,
        {
          action: "publish",
          entityType: "episode_version",
          episodeId,
          episodeVersionId: draft.id,
          businessKey: key,
          reason,
          detail: {
            version: draft.version,
            previousVersionId: previous?.id ?? null,
            segmentCount: segmentRows.length,
            contentHash,
          },
        },
        tx,
      );
      return {
        episodeId,
        versionId: draft.id,
        version: draft.version,
        businessKey: key,
        contentHash,
        segmentCount: segmentRows.length,
        lint: report,
      };
    });

    const selfCheckDrift = await this.selfCheck(
      episodeId,
      content,
      actor,
      key,
      draft.id,
    );
    const impact = await this.query.retireImpact(episodeId);
    return { ...published, selfCheckDrift, impact };
  }

  /**
   * 快速回滚：把目标版本的快照复制成一个**新版本**并立刻发布。
   *
   * 一步完成（不先落草稿再发布），因为回滚是止血动作；但历史依然只增不改——
   * 目标版本一行都不动，当前版本转为 superseded。
   *
   * 允许对已 retire 的集回滚：那是「先回滚到已知良好版本，再决定要不要恢复上架」的应急路径。
   */
  async revert(
    episodeId: string,
    targetVersionId: string,
    actor: AuditActor,
    options: MutationOptions = {},
  ): Promise<RevertResult> {
    const reason = assertReason(options.reason);
    const episode = await this.query.loadEpisode(episodeId);
    const identity = episodeIdentity(episode);
    const key = businessKey(identity);
    assertConfirmText(options.confirmText, key);

    const target = await this.prisma.adventureEpisodeVersion.findUnique({
      where: { id: targetVersionId },
    });
    // 版本 id 是全局 uuid；跨集回滚等于拿别集的内容覆盖这一集，按不存在处理
    if (!target || target.episodeId !== episodeId) {
      throw new NotFoundException(
        `故事集 ${episodeId} 下不存在版本 ${targetVersionId}`,
      );
    }
    if (!REVERTABLE_VERSION_STATUSES.includes(target.status)) {
      throw new BadRequestException({
        message: `只有发布过的版本才能回滚；v${target.version} 的状态是 ${target.status}。`,
        code: "VERSION_NOT_REVERTABLE",
      });
    }
    const content = contentFromPayload(identity, target.payload);
    const report = await this.query.checkContent(episodeId, content, {
      ...identity,
      forPublish: true,
    });
    // 旧版本可能含有今天已被禁用的词或不合规的段；回滚不能成为绕过校验的后门
    assertPublishable(report, "回滚目标版本");

    const payload = buildPayload(identity, content);
    const contentHash = payloadHash(identity, content);
    const segmentRows = toSegmentRows(episodeId, content);
    const versions = await this.prisma.adventureEpisodeVersion.findMany({
      where: { episodeId },
      orderBy: { version: "desc" },
    });
    const draftStillPending = versions.some((row) => row.status === "draft");

    const reverted = await this.prisma.$transaction(async (tx) => {
      const txVersions = await tx.adventureEpisodeVersion.findMany({
        where: { episodeId },
        orderBy: { version: "desc" },
      });
      const maxVersion = txVersions.length > 0 ? txVersions[0].version : 0;
      const current =
        txVersions.find((row) => row.status === "published") ?? null;
      const created = await tx.adventureEpisodeVersion.create({
        data: {
          episodeId,
          version: maxVersion + 1,
          status: "published",
          payload: jsonOf(payload),
          contentHash,
          changeNote: reason,
          createdBy: actor.username,
          createdByName: actor.displayName,
          publishedAt: new Date(),
          publishedBy: actor.username,
        },
      });
      if (current) {
        await tx.adventureEpisodeVersion.update({
          where: { id: current.id },
          data: { status: "superseded", supersededById: created.id },
        });
      }
      await tx.adventureEpisode.update({
        where: { id: episodeId },
        data: {
          published: true,
          currentVersionId: created.id,
          title: content.title,
          recap: content.recap,
        },
      });
      await tx.adventureSegment.deleteMany({ where: { episodeId } });
      await tx.adventureSegment.createMany({ data: segmentRows });
      await this.audit.record(
        actor,
        {
          action: "revert",
          entityType: "episode_version",
          episodeId,
          episodeVersionId: created.id,
          businessKey: key,
          reason,
          detail: {
            revertedFromVersionId: current?.id ?? null,
            revertedToVersionId: target.id,
            revertedToVersion: target.version,
            newVersion: created.version,
            contentHash,
          },
        },
        tx,
      );
      return {
        episodeId,
        versionId: created.id,
        newVersion: maxVersion + 1,
        businessKey: key,
        revertedToVersionId: target.id,
        revertedToVersion: target.version,
        draftStillPending,
        lint: report,
      };
    });

    const selfCheckDrift = await this.selfCheck(
      episodeId,
      content,
      actor,
      key,
      reverted.versionId,
    );
    const impact = await this.query.retireImpact(episodeId);
    return { ...reverted, selfCheckDrift, impact };
  }

  /**
   * 下架（墓碑）。已发布的故事在任何环境都不允许删除，因为已经有孩子玩过它了：
   * 家长端报告、审计、进度行都还指着它。
   *
   * 今天在玩这一集的设备**完全不动**——它们锁在自己的版本快照上，会把手上这集玩完。
   * 只收走跨天陈旧的 in_progress：引擎的 findCurrentDaily 不带日期过滤，
   * 不收走的话这些孩子明天还会被钉在这一集上，而它已经下架了。
   */
  async retire(
    episodeId: string,
    actor: AuditActor,
    options: MutationOptions = {},
  ): Promise<RetireResult> {
    const reason = assertReason(options.reason);
    const episode = await this.query.loadEpisode(episodeId);
    const key = businessKey(episodeIdentity(episode));
    assertConfirmText(options.confirmText, key);
    if (!episode.published) {
      throw new BadRequestException({
        message:
          "只有已发布的故事才能 retire。从未发布过的请用「废弃整集」，语义不同。",
        code: "NOT_PUBLISHED",
      });
    }
    if (episode.retiredAt) {
      throw new ConflictException({
        message: "这一集已经 retire 过了，不需要重复下架。",
        code: "ALREADY_RETIRED",
        retiredAt: episode.retiredAt,
      });
    }
    const impact = await this.query.retireImpact(episodeId);
    const today = this.query.dateKey();

    return this.prisma.$transaction(async (tx) => {
      const staleDailies = await tx.adventureDailyRecord.findMany({
        where: {
          episodeId,
          status: "in_progress",
          assignedDate: { lt: today },
        },
        select: { id: true, deviceId: true },
      });
      const deviceIds = [...new Set(staleDailies.map((row) => row.deviceId))];
      const retiredAt = new Date();
      await tx.adventureEpisode.update({
        where: { id: episodeId },
        data: { retiredAt },
      });
      if (staleDailies.length > 0) {
        await tx.adventureDailyRecord.updateMany({
          where: { id: { in: staleDailies.map((row) => row.id) } },
          data: { status: "abandoned" },
        });
      }
      let abandonedProgressCount = 0;
      if (deviceIds.length > 0) {
        const updated = await tx.adventureProgress.updateMany({
          where: {
            episodeId,
            deviceId: { in: deviceIds },
            status: { in: RETIRE_ABANDONABLE_STATUSES },
          },
          data: { status: "abandoned" },
        });
        abandonedProgressCount = updated.count;
      }
      await this.audit.record(
        actor,
        {
          action: "retire",
          entityType: "episode",
          episodeId,
          businessKey: key,
          reason,
          detail: {
            impact,
            staleDailyCount: staleDailies.length,
            abandonedProgressCount,
          },
        },
        tx,
      );
      return {
        episodeId,
        businessKey: key,
        retiredAt,
        impact,
        staleDailyCount: staleDailies.length,
        abandonedProgressCount,
        message:
          `已下架。今天在玩这一集的 ${impact.devicesPlayingToday} 台设备不受影响，会玩完手上这一集；` +
          `${staleDailies.length} 条跨天陈旧进度已收走，这些设备下次开机会分到新的一集。`,
      };
    });
  }

  /**
   * 恢复上架。只清墓碑，**不恢复** retire 期间被 abandoned 的进度——
   * abandoned 是永久终态，那些设备下次会分到新的一集。
   * 这不是缺陷而是设计：把几天前的进度原地复活，会让孩子听到一段接不上的前情回顾。
   */
  async restore(
    episodeId: string,
    actor: AuditActor,
    options: MutationOptions = {},
  ): Promise<RestoreResult> {
    const reason = assertReason(options.reason);
    const episode = await this.query.loadEpisode(episodeId);
    if (!episode.retiredAt) {
      throw new BadRequestException({
        message: "这一集没有被 retire，无需恢复。",
        code: "NOT_RETIRED",
      });
    }
    const key = businessKey(episodeIdentity(episode));
    const abandonedProgressNotRestored =
      await this.prisma.adventureProgress.count({
        where: { episodeId, status: "abandoned" },
      });

    await this.prisma.$transaction(async (tx) => {
      await tx.adventureEpisode.update({
        where: { id: episodeId },
        data: { retiredAt: null },
      });
      await this.audit.record(
        actor,
        {
          action: "restore",
          entityType: "episode",
          episodeId,
          businessKey: key,
          reason,
          detail: { abandonedProgressNotRestored },
        },
        tx,
      );
    });

    return {
      episodeId,
      businessKey: key,
      abandonedProgressNotRestored,
      message:
        `已恢复上架。注意：retire 期间被收走的 ${abandonedProgressNotRestored} 条进度不会回来——` +
        "abandoned 是永久终态，这些设备下次会分到新的一集。",
    };
  }

  /**
   * 丢弃当前草稿。只有在这一集至少发布过一版时才允许：
   * 否则草稿就是这一集唯一的内容，丢完就只剩一个空壳，那属于「废弃整集」。
   */
  async discardDraft(
    episodeId: string,
    actor: AuditActor,
    options: MutationOptions = {},
  ): Promise<DiscardDraftResult> {
    const reason = assertReason(options.reason);
    const episode = await this.query.loadEpisode(episodeId);
    const key = businessKey(episodeIdentity(episode));

    return this.prisma.$transaction(async (tx) => {
      const versions = await tx.adventureEpisodeVersion.findMany({
        where: { episodeId },
        orderBy: { version: "desc" },
      });
      const draft = findDraft(versions);
      if (!draft) {
        throw new BadRequestException({
          message: "这一集没有待发布的草稿。",
          code: "NO_DRAFT",
        });
      }
      if (!hasPublishedVersion(versions)) {
        throw new BadRequestException({
          message:
            "这一集从未发布过，草稿是它唯一的内容。要放弃整集请用「废弃整集」。",
          code: "DRAFT_IS_ONLY_CONTENT",
        });
      }
      await tx.adventureEpisodeVersion.update({
        where: { id: draft.id },
        data: { status: "discarded" },
      });
      await this.audit.record(
        actor,
        {
          action: "discard_draft",
          entityType: "episode_version",
          episodeId,
          episodeVersionId: draft.id,
          businessKey: key,
          reason,
          detail: { version: draft.version },
        },
        tx,
      );
      return {
        episodeId,
        businessKey: key,
        discardedVersionId: draft.id,
        version: draft.version,
      };
    });
  }

  /**
   * 废弃整集（仅限从未发布过的）。
   *
   * 实现是墓碑而不是删除，所以**业务键永久占用**：同 IP、同季、同集号再也无法新建。
   * 这是「任何环境都不硬删」的必然代价，必须在确认弹窗里大声写明。
   */
  async discardEpisode(
    episodeId: string,
    actor: AuditActor,
    options: MutationOptions = {},
  ): Promise<DiscardEpisodeResult> {
    const reason = assertReason(options.reason);
    const episode = await this.query.loadEpisode(episodeId);
    const key = businessKey(episodeIdentity(episode));
    assertConfirmText(options.confirmText, key);
    if (episode.published) {
      throw new BadRequestException({
        message:
          "已发布过的故事不能废弃整集，请用 retire——已经有孩子玩过它了。",
        code: "EPISODE_WAS_PUBLISHED",
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const versions = await tx.adventureEpisodeVersion.findMany({
        where: { episodeId },
        orderBy: { version: "desc" },
      });
      if (hasPublishedVersion(versions)) {
        throw new BadRequestException({
          message: "这一集有发布过的版本，不能废弃整集，请用 retire。",
          code: "EPISODE_WAS_PUBLISHED",
        });
      }
      const discarded = await tx.adventureEpisodeVersion.updateMany({
        where: { episodeId, status: "draft" },
        data: { status: "discarded" },
      });
      await tx.adventureEpisode.update({
        where: { id: episodeId },
        data: { retiredAt: new Date(), published: false },
      });
      await this.audit.record(
        actor,
        {
          action: "discard",
          entityType: "episode",
          episodeId,
          businessKey: key,
          reason,
          detail: {
            discardedDraftCount: discarded.count,
            businessKeyPermanentlyTaken: key,
          },
        },
        tx,
      );
      return {
        episodeId,
        businessKey: key,
        discardedDraftCount: discarded.count,
        message:
          `已废弃。注意：任何环境都不做硬删除，业务键 ${key} 会永久占用，` +
          "同 IP、同季、同集号无法再新建。",
      };
    });
  }

  /**
   * 发布后自检：重读 segments 表，和刚发布的 payload 比对。
   *
   * **只告警，绝不回滚。** 事务已经提交，孩子端可能已经读到新内容；
   * 这时候回滚会造成「库里是旧的、孩子听到的是新的」这种更难查的不一致。
   * 漂移意味着有别的写入路径绕过了本服务，属于必须人工介入的事故。
   * 自检本身崩了也不能影响发布结果。
   */
  private async selfCheck(
    episodeId: string,
    content: EpisodeContentDraft,
    actor: AuditActor,
    businessKeyValue: string,
    versionId: string,
  ): Promise<string[] | null> {
    try {
      const rows = await this.prisma.adventureSegment.findMany({
        where: { episodeId },
        orderBy: { order: "asc" },
      });
      const drift = findSegmentDrift(rows, content);
      if (drift.length > 0) {
        this.logger.error(
          `发布自检发现内容漂移 episodeId=${episodeId} versionId=${versionId}: ${drift.join(
            "；",
          )}`,
        );
        await this.audit.record(actor, {
          action: "self_check_failed",
          entityType: "episode",
          episodeId,
          episodeVersionId: versionId,
          businessKey: businessKeyValue,
          detail: { drift },
        });
      }
      return drift;
    } catch (error) {
      this.logger.error(
        `发布自检执行失败（不影响已提交的发布）episodeId=${episodeId}: ${
          (error as Error)?.message
        }`,
      );
      return null;
    }
  }
}

function assertReason(reason?: string | null): string {
  const text = (reason ?? "").trim();
  if (text.length < MIN_REASON_CHARS) {
    throw new BadRequestException({
      message: `变更理由不能少于 ${MIN_REASON_CHARS} 个字：半年后别人（包括你自己）只能靠审计看懂当时为什么这么改。`,
      code: "REASON_REQUIRED",
    });
  }
  if (text.length > MAX_REASON_CHARS) {
    throw new BadRequestException({
      message: `变更理由不能超过 ${MAX_REASON_CHARS} 个字。`,
      code: "REASON_TOO_LONG",
    });
  }
  return text;
}

function assertConfirmText(
  confirmText: string | null | undefined,
  key: string,
): void {
  if ((confirmText ?? "").trim() !== key) {
    throw new BadRequestException({
      message: `确认文本不匹配。这一操作会影响正在玩的孩子，请原样输入业务键：${key}`,
      code: "CONFIRM_TEXT_MISMATCH",
      expected: key,
    });
  }
}

function assertNoDraftBlocking(report: LintReport): void {
  const blocking = report.errors.filter((issue) =>
    DRAFT_BLOCKING_CODES.includes(issue.code),
  );
  if (blocking.length === 0) {
    return;
  }
  throw new BadRequestException({
    message: blocking.map((issue) => issue.message).join("；"),
    code: "CONTENT_REJECTED",
    lint: report,
  });
}

/**
 * 规范化会丢掉空文本段（对外来 bundle 是对的，对草稿不是）。
 * 草稿存一次就少一段等于编辑器吃字，所以这里把静默丢段变成一次明确的报错。
 */
function assertNoSegmentLoss(
  identity: EpisodeIdentity,
  content: EpisodeContentDraft,
  report: LintReport,
): void {
  const incoming = Array.isArray(content?.segments)
    ? content.segments.length
    : 0;
  const kept = toBundleEpisode(identity, content).segments.length;
  if (kept === incoming) {
    return;
  }
  throw new BadRequestException({
    message: `有 ${
      incoming - kept
    } 段因为缺文本、段号非法或段落类型非法而无法保存。草稿不会偷偷吃掉你写的段落——请先补齐标红的段。`,
    code: "SEGMENT_WOULD_BE_DROPPED",
    lint: report,
  });
}

function assertPublishable(report: LintReport, subject: string): void {
  if (report.ok) {
    return;
  }
  throw new BadRequestException({
    message: `${subject}未通过发布校验：${report.errors
      .map((issue) => issue.message)
      .join("；")}`,
    code: "PUBLISH_BLOCKED",
    lint: report,
  });
}

function throwIfBusinessKeyTaken(error: unknown, key: string): void {
  if (
    error &&
    typeof error === "object" &&
    (error as { code?: string }).code === "P2002"
  ) {
    throw new ConflictException({
      message: `业务键 ${key} 已被占用：同 IP、同季、同集号只能有一集。`,
      code: "BUSINESS_KEY_TAKEN",
      businessKey: key,
    });
  }
}

function buildPayload(
  identity: EpisodeIdentity,
  content: EpisodeContentDraft,
): EpisodePayload {
  const normalized = toBundleEpisode(identity, content);
  return {
    title: normalized.title,
    recap: normalized.recap,
    segments: normalized.segments,
  };
}

function payloadHash(identity: EpisodeIdentity, content: EpisodeContentDraft) {
  return episodeContentHash(toBundleEpisode(identity, content));
}

function toSegmentRows(episodeId: string, content: EpisodeContentDraft) {
  return content.segments.map((segment) => ({
    episodeId,
    order: segment.order,
    kind: segment.kind,
    text: segment.text,
    interactionType: segment.interactionType ?? null,
    options: jsonOf(segment.options ?? null),
    fallbackText: segment.fallbackText ?? null,
    exitText: segment.exitText ?? null,
    rewardStar: segment.rewardStar === true,
  }));
}

/**
 * 只比会真正影响播放的字段：段数、order、kind、文本、交互类型。
 * 输出逐字段的可读描述——这条信息会进日志和审计，必须让值班的人一眼看懂差在哪。
 */
function findSegmentDrift(
  rows: Array<{
    order?: number;
    kind?: string;
    text?: string;
    interactionType?: string | null;
  }>,
  content: EpisodeContentDraft,
): string[] {
  const drift: string[] = [];
  const expectedSegments = content.segments ?? [];
  if (rows.length !== expectedSegments.length) {
    drift.push(
      `段数不一致：库里 ${rows.length} 段，刚发布的内容 ${expectedSegments.length} 段`,
    );
  }
  const longest = Math.max(rows.length, expectedSegments.length);
  for (let index = 0; index < longest; index++) {
    const actual = rows[index];
    const expected = expectedSegments[index];
    // 段数差异上面已经报过，缺的一侧不再逐字段刷屏
    if (!actual || !expected) {
      continue;
    }
    const fields: Array<[string, unknown, unknown]> = [
      ["order", actual.order, expected.order],
      ["kind", actual.kind, expected.kind],
      ["text", actual.text, expected.text],
      [
        "interactionType",
        actual.interactionType ?? null,
        expected.interactionType ?? null,
      ],
    ];
    for (const [field, actualValue, expectedValue] of fields) {
      if (String(actualValue) !== String(expectedValue)) {
        drift.push(
          `第 ${index} 段 ${field} 不一致：库里=${String(
            actualValue,
          )}，刚发布的内容=${String(expectedValue)}`,
        );
      }
    }
  }
  return drift;
}

function findDraft(versions: VersionRow[]): VersionRow | null {
  return versions.find((row) => row.status === "draft") ?? null;
}

function hasPublishedVersion(versions: VersionRow[]): boolean {
  return versions.some(
    (row) => row.status === "published" || row.status === "superseded",
  );
}

function summarize(report: LintReport): LintSummary {
  return {
    ok: report.ok,
    errors: report.errors.map((issue) => issue.code),
    warnings: report.warnings.map((issue) => issue.code),
  };
}

function jsonOf(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
