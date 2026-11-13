import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AdventureAuditService, AuditActor } from "./adventure-audit.service";
import {
  AdventureContentQueryService,
  contentFromPayload,
  episodeIdentity,
} from "./adventure-content-query.service";
import {
  AdventureContentService,
  MutationOptions,
  assertDraftSavable,
  assertReason,
} from "./adventure-content.service";
import {
  ADVENTURE_SEASON,
  AdventureCharacterKey,
  EpisodeContentDraft,
  EpisodeIdentity,
  businessKey,
} from "./adventure-content.types";
import { LintReport } from "./adventure-linter";
import {
  AdventureBundle,
  BundleSourceEpisode,
  ExistingEpisodeForImport,
  ImportPlan,
  buildBundle,
  bundleContentHash,
  parseBundle,
  planBundleImport,
  toBundleEpisode,
} from "./adventure-bundle";

/**
 * staging → prod 的内容搬运。
 *
 * 设计上有四条硬约束，都是为了「搬运动作本身不能变成事故源」：
 *
 * 1. **导出只取已发布快照。** 草稿是未审的半成品，跨环境搬它等于绕过校验。
 * 2. **导入只写草稿，永不自动发布。** 发布在目标环境是一次独立的、要填理由的动作，
 *    走的是和人工编辑完全相同的 publish 路径（含发布自检）。
 * 3. **全部或什么都没有。** 计划里只要有一项被拒，整批不写，避免 prod 出现半套内容。
 * 4. **不信任客户端。** dry-run 与真实导入共用同一份计划生成逻辑，applyImport 一律重算，
 *    并要求回传预览时给出的确认码；提交内容与预览内容不一致时直接拒绝。
 *
 * 导入是幂等的：中断后重跑，已落地的集会因为内容哈希一致被判为 already_up_to_date 跳过。
 */

/** 确认码长度。取 bundle 内容哈希的前 12 位，等价于 GitHub 删库时要求手输仓库名。 */
export const CONFIRM_TOKEN_LENGTH = 12;

export interface ExportSelector {
  /** 指定集；给了就只导这些 */
  episodeIds?: string[];
  /** 不指定 id 时按 IP 全导 */
  characterKey?: string;
  /** 默认不导已 retire 的集 */
  includeRetired?: boolean;
}

export interface ExportSkipped {
  businessKey: string;
  reason: string;
}

export interface ExportResult {
  bundle: AdventureBundle;
  bundleHash: string;
  confirmToken: string;
  episodeCount: number;
  skipped: ExportSkipped[];
}

export interface ImportPreview {
  ok: boolean;
  bundleHash: string;
  confirmToken: string;
  plan: ImportPlan;
  parseErrors: string[];
  parseWarnings: string[];
  message: string;
}

export interface ImportOptions extends MutationOptions {
  /** 预览时拿到的 bundleHash；给了就必须与重新算出的一致 */
  expectedBundleHash?: string | null;
}

export interface ImportWrittenItem {
  businessKey: string;
  action: "add" | "replace";
  episodeId: string;
  versionId: string;
  version: number;
}

export interface ImportApplyResult {
  bundleHash: string;
  confirmToken: string;
  plan: ImportPlan;
  written: ImportWrittenItem[];
  skipped: string[];
  message: string;
}

interface PreparedImport {
  bundle: AdventureBundle | null;
  parseErrors: string[];
  parseWarnings: string[];
  plan: ImportPlan;
  bundleHash: string;
  confirmToken: string;
  contentByKey: Map<
    string,
    { identity: EpisodeIdentity; content: EpisodeContentDraft }
  >;
}

interface ExistingSnapshot {
  rows: ExistingEpisodeForImport[];
  episodeByKey: Map<string, { id: string }>;
  draftByEpisodeId: Map<
    string,
    { version: number; contentHash: string | null; createdByName: string }
  >;
}

const EMPTY_PLAN: ImportPlan = {
  ok: false,
  bundleHash: "",
  items: [],
  adds: 0,
  replaces: 0,
  upToDate: 0,
  rejects: 0,
};

@Injectable()
export class AdventureTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdventureAuditService,
    private readonly query: AdventureContentQueryService,
    private readonly content: AdventureContentService,
  ) {}

  /** 导出：把选定各集的**当前已发布快照**打成一个 bundle。 */
  async exportBundle(
    selector: ExportSelector,
    actor: AuditActor,
  ): Promise<ExportResult> {
    const where: Prisma.AdventureEpisodeWhereInput = {
      season: ADVENTURE_SEASON,
    };
    if (selector.episodeIds?.length) {
      where.id = { in: selector.episodeIds };
    } else if (selector.characterKey) {
      where.characterKey = selector.characterKey;
    }
    if (!selector.includeRetired) {
      where.retiredAt = null;
    }

    const episodes = await this.prisma.adventureEpisode.findMany({
      where,
      orderBy: [{ characterKey: "asc" }, { episodeNumber: "asc" }],
    });
    const versionIds = episodes
      .map((episode) => episode.currentVersionId)
      .filter((id): id is string => !!id);
    const versions = versionIds.length
      ? await this.prisma.adventureEpisodeVersion.findMany({
          where: { id: { in: versionIds } },
        })
      : [];
    const versionById = new Map(versions.map((row) => [row.id, row]));

    const sources: BundleSourceEpisode[] = [];
    const skipped: ExportSkipped[] = [];
    const exportedKeys: string[] = [];
    for (const episode of episodes) {
      const identity = episodeIdentity(episode);
      const key = businessKey(identity);
      const version = episode.currentVersionId
        ? (versionById.get(episode.currentVersionId) ?? null)
        : null;
      if (!version) {
        skipped.push({
          businessKey: key,
          reason: "从未发布过，没有可导出的快照。",
        });
        continue;
      }
      if (version.status !== "published") {
        skipped.push({
          businessKey: key,
          reason: `当前版本状态是 ${version.status}，不是已发布版本，不能导出。`,
        });
        continue;
      }
      sources.push({
        identity,
        content: contentFromPayload(identity, version.payload),
      });
      exportedKeys.push(key);
    }

    if (sources.length === 0) {
      throw new BadRequestException({
        message:
          "没有可导出的已发布故事。导出只取已发布快照——草稿是未审的半成品，不能跨环境搬运。",
        code: "NOTHING_TO_EXPORT",
        skipped,
      });
    }

    const profile = this.query.capabilities().profile;
    const bundle = buildBundle(sources, { sourceProfile: profile });
    const bundleHash = bundleContentHash(bundle);
    const confirmToken = shortToken(bundleHash);

    await this.audit.record(actor, {
      action: "export",
      entityType: "bundle",
      businessKey: exportedKeys.join(","),
      detail: {
        bundleHash,
        confirmToken,
        episodeCount: sources.length,
        businessKeys: exportedKeys,
        skipped,
      },
    });

    return {
      bundle,
      bundleHash,
      confirmToken,
      episodeCount: sources.length,
      skipped,
    };
  }

  /** dry-run：解析 bundle、比对目标环境、生成计划。不写任何东西。 */
  async planImport(raw: unknown): Promise<ImportPreview> {
    const prepared = await this.prepareImport(raw);
    const ok = prepared.plan.ok && prepared.parseErrors.length === 0;
    return {
      ok,
      bundleHash: prepared.bundleHash,
      confirmToken: prepared.confirmToken,
      plan: prepared.plan,
      parseErrors: prepared.parseErrors,
      parseWarnings: prepared.parseWarnings,
      message: describePreview(prepared),
    };
  }

  /**
   * 真实导入。重算计划，校验确认码，然后逐集写草稿。
   *
   * 写入阶段不在一个大事务里（每集各自提交），所以前置校验必须做足：
   * 计划里任何一项被拒就整批不写。真出现中途失败，重跑即可——
   * 已落地的集会因为哈希一致被判为 already_up_to_date 跳过。
   */
  async applyImport(
    raw: unknown,
    actor: AuditActor,
    options: ImportOptions = {},
  ): Promise<ImportApplyResult> {
    const reason = assertReason(options.reason);
    const prepared = await this.prepareImport(raw);

    if (prepared.parseErrors.length > 0) {
      throw new BadRequestException({
        message: `bundle 无法解析：${prepared.parseErrors.join("；")}`,
        code: "BUNDLE_INVALID",
        errors: prepared.parseErrors,
      });
    }

    const expected = (options.expectedBundleHash ?? "").trim();
    if (expected && expected !== prepared.bundleHash) {
      throw new ConflictException({
        message:
          "提交的 bundle 与你预览的不是同一份。请重新执行预览，确认要导入的内容后再提交。",
        code: "BUNDLE_HASH_MISMATCH",
        previewedHash: expected,
        actualHash: prepared.bundleHash,
      });
    }

    if ((options.confirmText ?? "").trim() !== prepared.confirmToken) {
      throw new BadRequestException({
        message: `导入会改写目标环境的内容，请原样输入预览给出的确认码：${prepared.confirmToken}`,
        code: "CONFIRM_TEXT_MISMATCH",
        expected: prepared.confirmToken,
      });
    }

    if (!prepared.plan.ok) {
      throw new BadRequestException({
        message: `导入计划里有 ${prepared.plan.rejects} 项被拒。导入是全部或什么都没有——请先解决被拒项，再重新预览。`,
        code: "IMPORT_PLAN_REJECTED",
        plan: prepared.plan,
      });
    }

    const bundle = prepared.bundle;
    const writable = prepared.plan.items.filter(
      (item) => item.action === "add" || item.action === "replace",
    );
    const skipped = prepared.plan.items
      .filter((item) => item.action === "already_up_to_date")
      .map((item) => item.businessKey);

    if (!bundle || writable.length === 0) {
      await this.audit.record(actor, {
        action: "import_noop",
        entityType: "bundle",
        businessKey: skipped.join(",") || prepared.confirmToken,
        reason,
        sourceBundleHash: prepared.bundleHash,
        detail: {
          confirmToken: prepared.confirmToken,
          skipped,
          sourceProfile: bundle?.sourceProfile ?? null,
        },
      });
      return {
        bundleHash: prepared.bundleHash,
        confirmToken: prepared.confirmToken,
        plan: prepared.plan,
        written: [],
        skipped,
        message: `目标环境的内容已经和 bundle 一致，没有需要写入的（跳过 ${skipped.length} 集）。`,
      };
    }

    // 每集的理由里带上确认码，让单集审计能反查是哪一次导入带进来的
    const note = `${reason}（导入 bundle ${prepared.confirmToken}）`;
    const written: ImportWrittenItem[] = [];
    for (const item of writable) {
      const entry = prepared.contentByKey.get(item.businessKey);
      if (!entry) {
        continue;
      }
      const result =
        item.action === "add"
          ? await this.content.createEpisode(
              entry.identity,
              entry.content,
              actor,
              { reason: note },
            )
          : await this.content.saveDraft(item.episodeId, entry.content, actor, {
              reason: note,
            });
      written.push({
        businessKey: item.businessKey,
        // writable 已按 action 过滤过，这里只剩两种；显式收敛以满足类型
        action: item.action === "add" ? "add" : "replace",
        episodeId: result.episodeId,
        versionId: result.versionId,
        version: result.version,
      });
    }

    await this.audit.record(actor, {
      action: "import",
      entityType: "bundle",
      businessKey: written.map((item) => item.businessKey).join(","),
      reason,
      sourceBundleHash: prepared.bundleHash,
      detail: {
        confirmToken: prepared.confirmToken,
        adds: prepared.plan.adds,
        replaces: prepared.plan.replaces,
        upToDate: prepared.plan.upToDate,
        skipped,
        written,
        sourceProfile: bundle.sourceProfile,
        exportedAt: bundle.exportedAt,
        parseWarnings: prepared.parseWarnings,
      },
    });

    return {
      bundleHash: prepared.bundleHash,
      confirmToken: prepared.confirmToken,
      plan: prepared.plan,
      written,
      skipped,
      message:
        `导入完成：新增 ${prepared.plan.adds} 集、更新 ${prepared.plan.replaces} 集，` +
        `全部落为草稿。导入不会自动发布——请在目标环境逐集确认后手动发布。` +
        (skipped.length > 0 ? `已跳过 ${skipped.length} 集（内容一致）。` : ""),
    };
  }

  private async prepareImport(raw: unknown): Promise<PreparedImport> {
    const parsed = parseBundle(raw);
    if (!parsed.ok || !parsed.bundle) {
      return {
        bundle: null,
        parseErrors: parsed.errors,
        parseWarnings: parsed.warnings,
        plan: EMPTY_PLAN,
        bundleHash: "",
        confirmToken: "",
        contentByKey: new Map(),
      };
    }
    const bundle = parsed.bundle;
    const contentByKey = new Map<
      string,
      { identity: EpisodeIdentity; content: EpisodeContentDraft }
    >();
    for (const episode of bundle.episodes) {
      const identity: EpisodeIdentity = {
        characterKey: episode.characterKey,
        season: episode.season,
        episodeNumber: episode.episodeNumber,
      };
      contentByKey.set(businessKey(identity), {
        identity,
        content: {
          title: episode.title,
          recap: episode.recap,
          segments: episode.segments,
        },
      });
    }

    const existing = await this.loadExisting(bundle);
    const basePlan = planBundleImport(bundle, existing.rows);
    const plan = await this.applyEnvironmentGuards(
      basePlan,
      contentByKey,
      existing,
    );
    return {
      bundle,
      parseErrors: [],
      parseWarnings: parsed.warnings,
      plan,
      bundleHash: plan.bundleHash,
      confirmToken: shortToken(plan.bundleHash),
      contentByKey,
    };
  }

  private async loadExisting(
    bundle: AdventureBundle,
  ): Promise<ExistingSnapshot> {
    const wantedKeys = new Set(
      bundle.episodes.map((episode) =>
        businessKey({
          characterKey: episode.characterKey,
          season: episode.season,
          episodeNumber: episode.episodeNumber,
        }),
      ),
    );
    const episodes = (
      await this.prisma.adventureEpisode.findMany({
        where: {
          season: ADVENTURE_SEASON,
          characterKey: {
            in: [
              ...new Set(
                bundle.episodes.map(
                  (episode) => episode.characterKey as AdventureCharacterKey,
                ),
              ),
            ],
          },
          episodeNumber: {
            in: [
              ...new Set(
                bundle.episodes.map((episode) => episode.episodeNumber),
              ),
            ],
          },
        },
      })
    ).filter((episode) =>
      wantedKeys.has(businessKey(episodeIdentity(episode))),
    );

    const episodeIds = episodes.map((episode) => episode.id);
    const versionIds = episodes
      .map((episode) => episode.currentVersionId)
      .filter((id): id is string => !!id);
    const [publishedVersions, drafts] = await Promise.all([
      versionIds.length
        ? this.prisma.adventureEpisodeVersion.findMany({
            where: { id: { in: versionIds } },
          })
        : Promise.resolve([]),
      episodeIds.length
        ? this.prisma.adventureEpisodeVersion.findMany({
            where: { episodeId: { in: episodeIds }, status: "draft" },
            orderBy: { version: "desc" },
          })
        : Promise.resolve([]),
    ]);
    const publishedById = new Map(
      publishedVersions.map((row) => [row.id, row]),
    );
    const draftByEpisodeId = new Map<
      string,
      { version: number; contentHash: string | null; createdByName: string }
    >();
    for (const draft of drafts) {
      if (draftByEpisodeId.has(draft.episodeId)) {
        continue;
      }
      draftByEpisodeId.set(draft.episodeId, {
        version: draft.version,
        contentHash: draft.contentHash,
        createdByName: draft.createdByName,
      });
    }

    const rows: ExistingEpisodeForImport[] = [];
    const episodeByKey = new Map<string, { id: string }>();
    for (const episode of episodes) {
      const identity = episodeIdentity(episode);
      const key = businessKey(identity);
      episodeByKey.set(key, { id: episode.id });
      const version = episode.currentVersionId
        ? (publishedById.get(episode.currentVersionId) ?? null)
        : null;
      rows.push({
        id: episode.id,
        characterKey: identity.characterKey,
        season: identity.season,
        episodeNumber: identity.episodeNumber,
        published: episode.published,
        retiredAt: episode.retiredAt,
        currentContentHash: version?.contentHash ?? null,
        currentEpisode: version
          ? toBundleEpisode(
              identity,
              contentFromPayload(identity, version.payload),
            )
          : null,
      });
    }
    return { rows, episodeByKey, draftByEpisodeId };
  }

  /**
   * 纯函数计划之外的两道环境闸：
   * - 目标环境有未发布的本地草稿且内容与导入内容不同 → 拒绝，不静默覆盖同事的工作；
   * - 导入内容连草稿门槛都过不了（禁用词、身份非法、会丢段）→ 拒绝。
   *
   * 两者都把 item 转成 reject，从而让整批导入失败（all-or-nothing）。
   */
  private async applyEnvironmentGuards(
    plan: ImportPlan,
    contentByKey: PreparedImport["contentByKey"],
    existing: ExistingSnapshot,
  ): Promise<ImportPlan> {
    const rejects = new Map<string, string>();

    for (const item of plan.items) {
      if (item.action !== "add" && item.action !== "replace") {
        continue;
      }
      const entry = contentByKey.get(item.businessKey);
      if (!entry) {
        continue;
      }

      const episode = existing.episodeByKey.get(item.businessKey);
      const draft = episode
        ? (existing.draftByEpisodeId.get(episode.id) ?? null)
        : null;
      if (
        draft &&
        draft.contentHash !== item.incomingHash &&
        draft.contentHash !== item.existingHash
      ) {
        rejects.set(
          item.businessKey,
          `目标环境这一集有未发布的本地草稿（v${draft.version}，由 ${draft.createdByName} 修改），` +
            "内容与本次导入不同。导入不会静默覆盖同事的工作——请先在目标环境发布或丢弃该草稿。",
        );
        continue;
      }

      const report = await this.query.checkContent(
        item.episodeId ?? null,
        entry.content,
        entry.identity,
      );
      try {
        assertDraftSavable(entry.identity, entry.content, report);
      } catch (error) {
        rejects.set(item.businessKey, describeBlockingError(error, report));
      }
    }

    if (rejects.size === 0) {
      return plan;
    }
    return rebuildPlan(plan, rejects);
  }
}

function shortToken(hash: string): string {
  return hash.slice(0, CONFIRM_TOKEN_LENGTH);
}

function describeBlockingError(error: unknown, report: LintReport): string {
  if (error instanceof BadRequestException) {
    const body = error.getResponse() as { message?: string | string[] };
    const message = Array.isArray(body.message)
      ? body.message.join("；")
      : body.message;
    if (message) {
      return `导入内容未通过校验：${message}`;
    }
  }
  return `导入内容未通过校验：${report.errors
    .map((issue) => issue.message)
    .join("；")}`;
}

function rebuildPlan(
  plan: ImportPlan,
  rejects: Map<string, string>,
): ImportPlan {
  const items = plan.items.map((item) => {
    const reason = rejects.get(item.businessKey);
    if (!reason) {
      return item;
    }
    return {
      ...item,
      action: "reject" as const,
      reason,
      diff: undefined,
    };
  });
  const count = (action: string) =>
    items.filter((item) => item.action === action).length;
  return {
    // bundleHash 只由内容决定，与闸口结果无关：确认码在预览与提交之间必须稳定
    ok: count("reject") === 0,
    bundleHash: plan.bundleHash,
    items,
    adds: count("add"),
    replaces: count("replace"),
    upToDate: count("already_up_to_date"),
    rejects: count("reject"),
  };
}

function describePreview(prepared: PreparedImport): string {
  if (prepared.parseErrors.length > 0) {
    return `bundle 无法解析：${prepared.parseErrors.join("；")}`;
  }
  const { adds, replaces, upToDate, rejects } = prepared.plan;
  const parts = [
    `新增 ${adds} 集`,
    `替换 ${replaces} 集`,
    `已一致 ${upToDate} 集`,
  ];
  if (rejects > 0) {
    parts.push(`被拒 ${rejects} 集`);
  }
  const verdict = prepared.plan.ok
    ? "导入只写草稿，不会自动发布。"
    : "存在被拒项，整批导入不会写入任何内容。";
  return `预览：${parts.join("、")}。${verdict}确认后请原样输入确认码：${prepared.confirmToken}`;
}
