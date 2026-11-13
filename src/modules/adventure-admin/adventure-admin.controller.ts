import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import {
  AdventureAuditService,
  AuditActor,
  AuditListFilter,
} from "./adventure-audit.service";
import {
  AdventureContentQueryService,
  CheckContentIdentity,
  EpisodeListFilter,
} from "./adventure-content-query.service";
import {
  AdventureContentService,
  MutationOptions,
  assertReason,
} from "./adventure-content.service";
import {
  AdventureRecoveryService,
  SweepReport,
} from "@/modules/adventure/adventure-recovery.service";
import {
  AdventureTransferService,
  ExportSelector,
  ImportOptions,
} from "./adventure-transfer.service";
import { ADVENTURE_SEASON, EpisodeIdentity } from "./adventure-content.types";
import { resolveContentAdminProfile } from "./content-admin-profile";
import { ContentAdminExceptionFilter } from "./filters/content-admin-exception.filter";
import {
  ContentAdminGuard,
  ContentReadOnly,
} from "./guards/content-admin.guard";
import {
  AuditListQueryDto,
  CreateEpisodeDto,
  EpisodeIdentityDto,
  EpisodeListQueryDto,
  ExportDto,
  ImportApplyDto,
  ImportPreviewDto,
  LintDto,
  MutationDto,
  PublishDto,
  RevertDto,
  SaveDraftDto,
  SimulateDto,
  VersionDiffQueryDto,
} from "./dto/adventure-admin.dto";

/**
 * 冒险内容管理台（Adventure Studio）HTTP 入口。
 *
 * 路由挂在 `analytics/adventure-admin` 下面，不是新开一个顶级前缀：dashboard 的
 * vite proxy 与 nginx 已经整段转发 `/analytics`，这样看板前后端**零配置改动**
 * 就能用，也少一处「新前缀忘了加白名单」的部署事故面。
 *
 * 这一层刻意很薄，只做三件事：
 * 1. 把 actor 从 JWT 里取出来（审计表的全部意义在于「谁干的」，所以缺 username 直接拒）；
 * 2. 决定**每条路由认哪些字段**（见 picked 的 key 列表）——由路由决定而不是由客户端决定，
 *    这样「restore 不吃 confirmText」这类语义写死在服务端，前端多传也不会生效；
 * 3. 把 query 的空串 / 非法日期清干净，避免把 ""、Invalid Date 一路带进 Prisma。
 *
 * 所有业务规则（理由字数、确认文本、乐观锁、lint 门槛、retire 的当日豁免）都在
 * adventure-content.service / adventure-transfer.service 里，controller 不复述，
 * 以免出现第二套真相。
 */

interface RequestWithContentAdmin extends Request {
  user?: {
    adminId?: string;
    username?: string;
    displayName?: string;
    scope?: string;
    scopes?: string[];
  };
}

function trimToNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 恢复动作在审计表里的归属：它不针对某一集，所以 businessKey 固定、episodeId 留空。 */
const RECOVERY_ENTITY_TYPE = "recovery";
const RECOVERY_BUSINESS_KEY = "adventure/recovery";
/** detail 是 Json 列，一次大规模巡检不该往里塞几百 KB。 */
const RECOVERY_AUDIT_DETAIL_LIMIT = 50;

/**
 * 巡检报告的审计摘要。repairs/alerts 的条数随设备数增长，所以截断存放，
 * 但同时保留总数——读审计的人要能看出「还有多少没展开」，而不是以为只有这些。
 */
function summarizeSweep(report: SweepReport) {
  return {
    startedAt: report?.startedAt ?? null,
    finishedAt: report?.finishedAt ?? null,
    durationMs: report?.durationMs ?? null,
    skipped: report?.skipped ?? false,
    skipReason: report?.reason ?? null,
    scanned: report?.scanned ?? null,
    repairCount: report?.repairs?.length ?? 0,
    alertCount: report?.alerts?.length ?? 0,
    errorCount: report?.errors?.length ?? 0,
    repairs: (report?.repairs ?? []).slice(0, RECOVERY_AUDIT_DETAIL_LIMIT),
    alerts: (report?.alerts ?? []).slice(0, RECOVERY_AUDIT_DETAIL_LIMIT),
  };
}

@ApiTags("analytics-adventure-admin")
@ApiBearerAuth()
@UseGuards(ContentAdminGuard)
@UseFilters(ContentAdminExceptionFilter)
@Controller("analytics/adventure-admin")
export class AdventureAdminController {
  private readonly logger = new Logger(AdventureAdminController.name);

  constructor(
    private readonly query: AdventureContentQueryService,
    private readonly content: AdventureContentService,
    private readonly transfer: AdventureTransferService,
    private readonly audit: AdventureAuditService,
    private readonly configService: ConfigService,
    private readonly recovery: AdventureRecoveryService,
  ) {}

  @Get("capabilities")
  @ApiOperation({
    summary:
      "能力清单：季节/IP/交互原语枚举、lint 与试播阈值、当前环境是否可写（authoring）",
  })
  async capabilities() {
    return this.query.capabilities();
  }

  @Get("episodes")
  @ApiOperation({ summary: "冒险故事集列表（分页 + 按 IP/发布态/关键词过滤）" })
  async listEpisodes(@Query() dto: EpisodeListQueryDto) {
    return this.query.listEpisodes(
      this.picked(dto, [
        "characterKey",
        "published",
        "includeRetired",
        "search",
        "page",
        "pageSize",
      ]) as EpisodeListFilter,
    );
  }

  @Post("episodes")
  @ApiOperation({
    summary:
      "新建一集（只落草稿，不发布）：身份三元组决定业务键，业务键永久占用",
  })
  async createEpisode(
    @Body() dto: CreateEpisodeDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    return this.content.createEpisode(
      this.identityOf(dto?.identity),
      dto.content,
      this.actor(req),
      this.picked(dto, ["reason"]) as MutationOptions,
    );
  }

  @Get("episodes/:episodeId")
  @ApiOperation({
    summary:
      "单集详情：草稿优先的内容 + 内容来源 + baseVersionId（乐观锁基线）+ lint + 影响面",
  })
  async getEpisode(@Param("episodeId") episodeId: string) {
    return this.query.getEpisode(episodeId);
  }

  @Post("episodes/:episodeId/draft")
  @ApiOperation({
    summary:
      "存草稿。带 baseVersionId 参与乐观锁；别人已经改过时返回 409 DRAFT_CONFLICT",
  })
  async saveDraft(
    @Param("episodeId") episodeId: string,
    @Body() dto: SaveDraftDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    return this.content.saveDraft(
      episodeId,
      dto.content,
      this.actor(req),
      this.picked(dto, ["reason", "baseVersionId", "force"]) as MutationOptions,
    );
  }

  @Post("episodes/:episodeId/publish")
  @ApiOperation({
    summary:
      "发布草稿：生成新的 published 快照并切换 currentVersion，孩子侧立刻按新版本 pin",
  })
  async publish(
    @Param("episodeId") episodeId: string,
    @Body() dto: PublishDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    return this.content.publish(
      episodeId,
      this.actor(req),
      this.picked(dto, ["reason"]) as MutationOptions,
    );
  }

  @Post("episodes/:episodeId/revert")
  @ApiOperation({
    summary:
      "快速回滚到某个已发布快照（生成新版本，不改历史）；需手输业务键确认",
  })
  async revert(
    @Param("episodeId") episodeId: string,
    @Body() dto: RevertDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    const targetVersionId = trimToNull(dto?.targetVersionId);
    if (!targetVersionId) {
      throw new BadRequestException({
        message:
          "缺少 targetVersionId：回滚必须指明回到哪个快照，不接受「回上一版」这种相对语义。",
        code: "TARGET_VERSION_REQUIRED",
      });
    }
    return this.content.revert(
      episodeId,
      targetVersionId,
      this.actor(req),
      this.picked(dto, ["reason", "confirmText"]) as MutationOptions,
    );
  }

  @Post("episodes/:episodeId/retire")
  @ApiOperation({
    summary:
      "下架（retire）：墓碑而非删除。跨天未完成的进度收尾为 abandoned，当日在播的完全不动",
  })
  async retire(
    @Param("episodeId") episodeId: string,
    @Body() dto: MutationDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    return this.content.retire(
      episodeId,
      this.actor(req),
      this.picked(dto, ["reason", "confirmText"]) as MutationOptions,
    );
  }

  @Post("episodes/:episodeId/restore")
  @ApiOperation({
    summary: "恢复上架：只撤销墓碑，不会把当初收尾成 abandoned 的进度拉回来",
  })
  async restore(
    @Param("episodeId") episodeId: string,
    @Body() dto: MutationDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    return this.content.restore(
      episodeId,
      this.actor(req),
      this.picked(dto, ["reason"]) as MutationOptions,
    );
  }

  @Post("episodes/:episodeId/discard-draft")
  @ApiOperation({ summary: "丢弃当前未发布草稿，回到已发布快照" })
  async discardDraft(
    @Param("episodeId") episodeId: string,
    @Body() dto: MutationDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    return this.content.discardDraft(
      episodeId,
      this.actor(req),
      this.picked(dto, ["reason"]) as MutationOptions,
    );
  }

  @Post("episodes/:episodeId/discard")
  @ApiOperation({
    summary:
      "作废从未发布过的一集（墓碑 + 丢弃草稿）。业务键永久占用，不能复用同一集号",
  })
  async discardEpisode(
    @Param("episodeId") episodeId: string,
    @Body() dto: MutationDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    return this.content.discardEpisode(
      episodeId,
      this.actor(req),
      this.picked(dto, ["reason", "confirmText"]) as MutationOptions,
    );
  }

  @Get("episodes/:episodeId/versions")
  @ApiOperation({
    summary: "版本时间线（draft / published / superseded / discarded）",
  })
  async listVersions(@Param("episodeId") episodeId: string) {
    return this.query.listVersions(episodeId);
  }

  @Get("episodes/:episodeId/versions/:versionId")
  @ApiOperation({ summary: "某个版本快照的完整内容" })
  async getVersion(
    @Param("episodeId") episodeId: string,
    @Param("versionId") versionId: string,
  ) {
    return this.query.getVersion(episodeId, versionId);
  }

  @Get("episodes/:episodeId/diff")
  @ApiOperation({ summary: "两个版本的逐段差异（?left=旧&right=新）" })
  async diffVersions(
    @Param("episodeId") episodeId: string,
    @Query() dto: VersionDiffQueryDto,
  ) {
    return this.query.diffVersions(episodeId, dto?.left, dto?.right);
  }

  @Get("episodes/:episodeId/impact")
  @ApiOperation({
    summary:
      "影响面：今天在播设备数、跨天挂起数、pin 在旧版本的设备数、历史触达设备总数",
  })
  async impact(@Param("episodeId") episodeId: string) {
    return this.query.retireImpact(episodeId);
  }

  @Post("lint")
  @ContentReadOnly()
  @ApiOperation({
    summary:
      "实时校验内容草稿，不写库（编辑器每次改动后调用；只读环境同样可用）",
  })
  async lint(@Body() dto: LintDto) {
    const identity: CheckContentIdentity | undefined = dto?.identity
      ? {
          ...this.identityOf(dto.identity),
          ...(dto.forPublish === undefined
            ? {}
            : { forPublish: dto.forPublish }),
        }
      : undefined;
    return this.query.checkContent(
      trimToNull(dto?.episodeId),
      dto.content,
      identity,
    );
  }

  @Post("simulate")
  @ContentReadOnly()
  @ApiOperation({
    summary:
      "试播：把整集走一遍，给出每个停顿点、时长估算、星星数与问题清单，不写库",
  })
  async simulate(@Body() dto: SimulateDto) {
    return this.query.simulate(this.identityOf(dto?.identity), dto.content);
  }

  @Get("audit")
  @ApiOperation({
    summary: "审计流水：谁在什么时候对哪一集做了什么、理由是什么",
  })
  async listAudit(@Query() dto: AuditListQueryDto) {
    return this.audit.list(this.auditFilter(dto));
  }

  @Post("export")
  @ApiOperation({
    summary:
      "导出 bundle（只含已发布快照）。会留一条 export 审计，因此在只读环境不可用",
  })
  async exportBundle(
    @Body() dto: ExportDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    const episodeIds = (Array.isArray(dto?.episodeIds) ? dto.episodeIds : [])
      .map((id) => trimToNull(id))
      .filter((id): id is string => Boolean(id));
    const selector: ExportSelector = {};
    if (episodeIds.length > 0) {
      selector.episodeIds = episodeIds;
    }
    const characterKey = trimToNull(dto?.characterKey);
    if (characterKey) {
      selector.characterKey = characterKey;
    }
    if (dto?.includeRetired === true) {
      selector.includeRetired = true;
    }
    return this.transfer.exportBundle(selector, this.actor(req));
  }

  @Post("import/preview")
  @ContentReadOnly()
  @ApiOperation({
    summary:
      "导入预览（dry-run）：算出 add / replace / already_up_to_date / reject 与确认码，不写库",
  })
  async importPreview(@Body() dto: ImportPreviewDto) {
    return this.transfer.planImport(dto?.bundle);
  }

  @Post("import")
  @ApiOperation({
    summary:
      "应用导入：需要预览返回的确认码，任一项被 reject 则整批不写；只落草稿，永不自动发布",
  })
  async applyImport(
    @Body() dto: ImportApplyDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    if (!dto?.bundle || typeof dto.bundle !== "object") {
      throw new BadRequestException({
        message:
          "缺少 bundle：请先用「导入预览」拿到 diff 与确认码，再提交同一份 bundle。",
        code: "BUNDLE_REQUIRED",
      });
    }
    return this.transfer.applyImport(
      dto.bundle,
      this.actor(req),
      this.picked(dto, [
        "reason",
        "confirmText",
        "expectedBundleHash",
      ]) as ImportOptions,
    );
  }

  /**
   * 自愈面板（L4）。GET 只读；两个 POST 是**会改数据的运维动作**——巡检会把病态
   * 进度判成 exited/abandoned，重置熔断器等于解除降级——所以它们不豁免只读闸，
   * 并且各留一条审计。理由走 assertReason（与内容变更同一条规则、同一个常量），
   * controller 不复述字数门槛。
   */
  @Get("recovery")
  @ApiOperation({
    summary:
      "自愈健康快照：熔断器状态、生效配置、最近巡检报告与引擎失败记录（只读）",
  })
  async recoveryHealth() {
    return this.recovery.getHealthSnapshot();
  }

  @Post("recovery/sweep")
  @ApiOperation({
    summary: "手动触发一次巡检（写操作，只读环境不可用，留审计）",
  })
  async recoverySweep(
    @Body() dto: MutationDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    const actor = this.actor(req);
    const reason = assertReason(dto?.reason);
    const report = await this.recovery.sweepBrokenProgress();
    const audited = await this.recordRecoveryAction(
      actor,
      "recovery_sweep",
      reason,
      summarizeSweep(report),
    );
    return { report, audited };
  }

  @Post("recovery/reset")
  @ApiOperation({
    summary:
      "重置恢复熔断器、解除降级。授权回滚：只由人决定，系统绝不自动回滚（写操作，留审计）",
  })
  async recoveryReset(
    @Body() dto: MutationDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    const actor = this.actor(req);
    const reason = assertReason(dto?.reason);
    await this.recovery.resetBreaker();
    const audited = await this.recordRecoveryAction(
      actor,
      "recovery_breaker_reset",
      reason,
      null,
    );
    return { ok: true, audited };
  }

  /**
   * 恢复动作的审计是尽力而为：巡检/重置此刻已经生效，因为审计写不进去就把结果
   * 一起丢掉，等于让运维在故障期间看不见自己刚做了什么。失败只进日志 + audited=false，
   * 由 dashboard 把「这次没留痕」显式摆出来。
   */
  private async recordRecoveryAction(
    actor: AuditActor,
    action: string,
    reason: string,
    detail: unknown,
  ): Promise<boolean> {
    try {
      await this.audit.record(actor, {
        action,
        entityType: RECOVERY_ENTITY_TYPE,
        businessKey: RECOVERY_BUSINESS_KEY,
        reason,
        detail,
      });
      return true;
    } catch (error) {
      this.logger.error(
        `恢复动作审计写入失败 actor=${actor.username} action=${action}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * 审计里的「谁」。username 缺失时拒绝执行而不是记成 unknown：
   * 一条追不到人的审计比一次失败的请求危害更大。
   */
  private actor(req: RequestWithContentAdmin): AuditActor {
    const user = req?.user;
    const username = trimToNull(user?.username);
    if (!username) {
      throw new UnauthorizedException(
        "管理员身份缺少 username，拒绝执行内容操作：审计必须能追到具体的人。",
      );
    }
    return {
      username,
      displayName: trimToNull(user?.displayName) ?? username,
      profile: resolveContentAdminProfile(this.configService),
    };
  }

  /** 身份三元组：season 缺省补当前季，避免手写 bundle 因为漏字段被判 SEASON_UNSUPPORTED。 */
  private identityOf(dto?: EpisodeIdentityDto): EpisodeIdentity {
    return {
      characterKey: dto?.characterKey,
      season: dto?.season ?? ADVENTURE_SEASON,
      episodeNumber: dto?.episodeNumber,
    };
  }

  /**
   * 白名单挑字段：只有列出来的 key 会被转发给服务层，其余（客户端多塞的）一律丢弃。
   * 字符串顺手 trim，空串等于没传——把 undefined / null / "" 都收敛掉，
   * 服务层就只需要判断「有没有」，不用判断「是不是空白」。
   * 布尔 false 与数字 0 是有效值，必须保留。
   */
  private picked<T extends object>(
    dto: T,
    keys: (keyof T)[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const value = dto ? dto[key] : undefined;
      if (value === undefined || value === null) {
        continue;
      }
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
          continue;
        }
        out[key as string] = trimmed;
        continue;
      }
      out[key as string] = value;
    }
    return out;
  }

  /** 审计筛选：日期字符串转 Date，转不出来就当没传（不拿 Invalid Date 去查库）。 */
  private auditFilter(dto: AuditListQueryDto): AuditListFilter {
    const filter = this.picked(dto, [
      "episodeId",
      "actorUsername",
      "action",
      "page",
      "pageSize",
    ]) as AuditListFilter;
    for (const key of ["from", "to"] as const) {
      const raw = dto ? dto[key] : undefined;
      if (typeof raw !== "string" || !raw.trim()) {
        continue;
      }
      const date = new Date(raw.trim());
      if (Number.isNaN(date.getTime())) {
        continue;
      }
      filter[key] = date;
    }
    return filter;
  }
}
