import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AdventureContentAuditLog, Prisma } from "@prisma/client";

/**
 * 冒险内容操作审计。
 *
 * 这是安全控制，不是日志：破坏性内容操作（发布、retire、discard、跨环境导入）
 * 的可追溯性完全依赖它。因此本服务**只有 record 与 list 两个方法**，
 * 不提供任何 update / delete / upsert 入口，审计一旦写入不可改写。
 * 对应地，schema 里这张表没有任何外键关系，被引用实体消失后审计仍须可读。
 *
 * 写入必须与内容变更同事务：`record(actor, entry, tx)`。审计写失败会让整个
 * 事务回滚——宁可操作失败，也不允许发生一次没有记录在案的破坏性变更。
 */

export interface AuditActor {
  username: string;
  displayName: string;
  /** authoring / readonly，来自 CONTENT_ADMIN_PROFILE；记录操作发生在哪个环境 */
  profile: string;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  businessKey: string;
  episodeId?: string | null;
  episodeVersionId?: string | null;
  reason?: string | null;
  detail?: unknown;
  sourceBundleHash?: string | null;
}

export interface AuditListFilter {
  episodeId?: string;
  actorUsername?: string;
  action?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export interface AuditListResult {
  items: AdventureContentAuditLog[];
  total: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

@Injectable()
export class AdventureAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** 追加一条审计。传入 tx 时与内容变更同事务提交或同事务回滚。 */
  async record(
    actor: AuditActor,
    entry: AuditEntry,
    client?: Prisma.TransactionClient,
  ): Promise<void> {
    const writer = client ?? this.prisma;
    await writer.adventureContentAuditLog.create({
      data: {
        action: entry.action,
        entityType: entry.entityType,
        episodeId: entry.episodeId ?? null,
        episodeVersionId: entry.episodeVersionId ?? null,
        businessKey: entry.businessKey,
        actorUsername: actor.username,
        actorDisplayName: actor.displayName,
        profile: actor.profile,
        reason: entry.reason ?? null,
        detail: toJsonValue(entry.detail),
        sourceBundleHash: entry.sourceBundleHash ?? null,
      },
    });
  }

  /** 只读查询：最新在前，分页有上限，空过滤条件不参与 where。 */
  async list(filter: AuditListFilter = {}): Promise<AuditListResult> {
    const where: Prisma.AdventureContentAuditLogWhereInput = {};
    const episodeId = trimToNull(filter.episodeId);
    if (episodeId) {
      where.episodeId = episodeId;
    }
    const actorUsername = trimToNull(filter.actorUsername);
    if (actorUsername) {
      where.actorUsername = actorUsername;
    }
    const action = trimToNull(filter.action);
    if (action) {
      where.action = action;
    }
    if (filter.from || filter.to) {
      where.createdAt = {
        ...(filter.from ? { gte: filter.from } : {}),
        ...(filter.to ? { lte: filter.to } : {}),
      };
    }

    const pageSize = normalizePageSize(filter.pageSize);
    const page = normalizePage(filter.page);
    const [items, total] = await Promise.all([
      this.prisma.adventureContentAuditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.adventureContentAuditLog.count({ where }),
    ]);
    return { items, total };
  }
}

/**
 * 审计的 detail 是自由结构，但 Prisma 的 Json 列只接受可序列化值。
 * 这里把类型收窄集中在一处：调用方仍可以传任意对象，越界的值（如函数、
 * 循环引用）会在序列化阶段暴露，而不是被静默写坏。
 */
function toJsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === undefined || value === null) {
    return null;
  }
  return value as Prisma.InputJsonValue;
}

function trimToNull(value?: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizePageSize(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(value), MAX_PAGE_SIZE);
}

function normalizePage(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.floor(value);
}
