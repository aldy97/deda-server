import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { ADVENTURE_TEST_ENV } from "@/modules/adventure/adventure.constants";
import { assertReason } from "./adventure-content.service";
import { AdventureAuditService, AuditActor } from "./adventure-audit.service";

/**
 * 测试冒险故事下发（仅 staging）。
 *
 * 与旧样机试播的差别：状态真相不再放 Redis 武装会话，而是 device 上两条持久化
 * 字段（testAdventureEpisodeId + testAdventureEpisodeVersionId）。管理台只负责
 * 「把当前集写到设备上」和「清除」，播放由引擎侧读字段完成。写操作照内容管理台
 * 同一套双闸：ContentAdminGuard（scope + authoring）+ 环境闸，动作留审计。
 */

export interface TestAssignInput {
  deviceId: string;
  reason?: string;
}

interface ResolvedDevice {
  id: string;
  deviceId: string;
  deviceCode: string | null;
  testAdventureEpisodeId: string | null;
  testAdventureEpisodeVersionId: string | null;
}

export interface CharacterTestDevice {
  deviceId: string;
  deviceCode: string | null;
  episode: {
    id: string;
    businessKey: string;
    title: string;
    characterKey: string;
    season: number;
    episodeNumber: number;
    retiredAt: string | null;
  };
  version: { id: string; version: number; status: string } | null;
  followsCurrent: boolean;
  stale: boolean;
  lastAssignedAt: string | null;
}

export interface CharacterTestDevicesResult {
  enabled: boolean;
  characterKey: string;
  total: number;
  devices: CharacterTestDevice[];
}

/** 一个 IP 下的样机数量是量级很小的运营集合，500 足够且能挡住异常数据把响应撑爆。 */
const CHARACTER_DEVICE_LIST_LIMIT = 500;

@Injectable()
export class AdventureTestAssignService {
  private readonly logger = new Logger(AdventureTestAssignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly audit: AdventureAuditService,
  ) {}

  private isEnabled(): boolean {
    return (
      this.configService.get<string>(ADVENTURE_TEST_ENV.enabled) === "true"
    );
  }

  /** 环境闸：未启用时写操作与明细一律 403——prod 连「当前有没有下发」都不暴露。 */
  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new ForbiddenException(
        "测试冒险故事未启用：ADVENTURE_TEST_MODE_ENABLED 不是 true（prod 永远不可用）。",
      );
    }
  }

  /** 业务 deviceId（小写 MAC）或 deviceCode → 内部 UUID。查不到一律 404。 */
  private async resolveDevice(raw: string): Promise<ResolvedDevice> {
    const device = await this.prisma.device.findFirst({
      where: { OR: [{ deviceId: raw }, { deviceCode: raw }] },
      select: {
        id: true,
        deviceId: true,
        deviceCode: true,
        testAdventureEpisodeId: true,
        testAdventureEpisodeVersionId: true,
      },
    });
    if (!device) {
      throw new NotFoundException(`Device not found: ${raw}`);
    }
    return device;
  }

  /** 下发当前集到设备：优先锁草稿快照，否则锁当前发布版本。staging only，留审计。 */
  async assign(episodeId: string, input: TestAssignInput, actor: AuditActor) {
    this.assertEnabled();
    const reason = assertReason(input.reason);
    const episode = await this.prisma.adventureEpisode.findUnique({
      where: { id: episodeId },
      select: { id: true, title: true, currentVersionId: true },
    });
    if (!episode) {
      throw new NotFoundException(`Episode not found: ${episodeId}`);
    }
    const device = await this.resolveDevice(input.deviceId);
    const draft = await this.prisma.adventureEpisodeVersion.findFirst({
      where: { episodeId, status: "draft" },
      orderBy: { version: "desc" },
      select: { id: true },
    });
    const episodeVersionId = draft?.id ?? episode.currentVersionId ?? null;
    await this.prisma.device.update({
      where: { id: device.id },
      data: {
        testAdventureEpisodeId: episode.id,
        testAdventureEpisodeVersionId: episodeVersionId,
      },
    });
    await this.resetStickySession(device.id);
    const audited = await this.recordAudit(
      actor,
      "device_test_assign",
      device,
      reason,
      { episodeId: episode.id, episodeVersionId },
    );
    return {
      ok: true,
      audited,
      assignment: {
        episodeId: episode.id,
        title: episode.title,
        episodeVersionId,
        versionStatus: draft ? "draft" : "published",
      },
    };
  }

  /** 清除该设备当前下发：仅当它正是这一集，否则 409（防误清别的集）。 */
  async clear(episodeId: string, input: TestAssignInput, actor: AuditActor) {
    this.assertEnabled();
    const reason = assertReason(input.reason);
    const device = await this.resolveDevice(input.deviceId);
    if (device.testAdventureEpisodeId !== episodeId) {
      throw new ConflictException(
        "该设备当前下发的不是这一集，请到对应集的下发里清除。",
      );
    }
    await this.prisma.device.update({
      where: { id: device.id },
      data: {
        testAdventureEpisodeId: null,
        testAdventureEpisodeVersionId: null,
      },
    });
    const audited = await this.recordAudit(
      actor,
      "device_test_clear",
      device,
      reason,
      { clearedEpisodeId: episodeId },
    );
    return { ok: true, audited };
  }

  /**
   * 按 IP 列出所有「当前被下发」的样机。只读，不改任何状态。
   *
   * 真相是 device 上的一对字段（每台设备同时只记一集），不是审计流水：
   * 下发会覆盖、清除会把字段清空，拿历史推导会列出早已换走的设备。
   * 审计只用来补一个展示字段 lastAssignedAt——取该设备最近一条
   * device_test_assign 的时间；若那次审计写失败（audited=false），这里为 null。
   *
   * stale 的口径与 assign 的选版规则一致：有草稿锁最新草稿，否则锁当前发布版。
   * 设备锁的是旧快照时 stale=true，但播放仍按它自己锁的快照走——这只是提醒
   * 「重新下发才会换到新版本」，不是错误。
   */
  async listByCharacter(
    characterKey: string,
  ): Promise<CharacterTestDevicesResult> {
    if (!this.isEnabled()) {
      return { enabled: false, characterKey, total: 0, devices: [] };
    }

    const where: Prisma.DeviceWhereInput = {
      testAdventureEpisode: { is: { characterKey } },
    };
    const [devices, total] = await Promise.all([
      this.prisma.device.findMany({
        where,
        select: {
          deviceId: true,
          deviceCode: true,
          testAdventureEpisodeId: true,
          testAdventureEpisodeVersionId: true,
          testAdventureEpisode: {
            select: {
              id: true,
              title: true,
              characterKey: true,
              season: true,
              episodeNumber: true,
              retiredAt: true,
              currentVersionId: true,
            },
          },
          testAdventureEpisodeVersion: {
            select: { id: true, version: true, status: true },
          },
        },
        orderBy: { deviceId: "asc" },
        take: CHARACTER_DEVICE_LIST_LIMIT,
      }),
      this.prisma.device.count({ where }),
    ]);

    const episodeIds = [
      ...new Set(
        devices
          .map((device) => device.testAdventureEpisode?.id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const deviceIds = devices.map((device) => device.deviceId);

    const [drafts, assignments] = await Promise.all([
      episodeIds.length > 0
        ? this.prisma.adventureEpisodeVersion.findMany({
            where: { episodeId: { in: episodeIds }, status: "draft" },
            orderBy: { version: "desc" },
            select: { id: true, episodeId: true },
          })
        : Promise.resolve([]),
      deviceIds.length > 0
        ? this.prisma.adventureContentAuditLog.findMany({
            where: {
              action: "device_test_assign",
              businessKey: { in: deviceIds },
            },
            orderBy: { createdAt: "desc" },
            select: { businessKey: true, createdAt: true },
          })
        : Promise.resolve([]),
    ]);

    const latestDraftByEpisode = new Map<string, string>();
    for (const draft of drafts) {
      if (!latestDraftByEpisode.has(draft.episodeId)) {
        latestDraftByEpisode.set(draft.episodeId, draft.id);
      }
    }
    const lastAssignedByDevice = new Map<string, Date>();
    for (const row of assignments) {
      if (!lastAssignedByDevice.has(row.businessKey)) {
        lastAssignedByDevice.set(row.businessKey, row.createdAt);
      }
    }

    const rows = devices.flatMap((device): CharacterTestDevice[] => {
      const episode = device.testAdventureEpisode;
      if (!episode) {
        return [];
      }
      const expectedVersionId =
        latestDraftByEpisode.get(episode.id) ??
        episode.currentVersionId ??
        null;
      const followsCurrent = device.testAdventureEpisodeVersionId === null;
      const pinned = device.testAdventureEpisodeVersion;
      return [
        {
          deviceId: device.deviceId,
          deviceCode: device.deviceCode,
          episode: {
            id: episode.id,
            businessKey: `${episode.characterKey}/${episode.season}/${episode.episodeNumber}`,
            title: episode.title,
            characterKey: episode.characterKey,
            season: episode.season,
            episodeNumber: episode.episodeNumber,
            retiredAt: episode.retiredAt
              ? episode.retiredAt.toISOString()
              : null,
          },
          version: pinned
            ? {
                id: pinned.id,
                version: pinned.version,
                status: pinned.status,
              }
            : null,
          followsCurrent,
          stale:
            !followsCurrent &&
            device.testAdventureEpisodeVersionId !== expectedVersionId,
          lastAssignedAt:
            lastAssignedByDevice.get(device.deviceId)?.toISOString() ?? null,
        },
      ];
    });

    rows.sort(
      (a, b) =>
        a.episode.season - b.episode.season ||
        a.episode.episodeNumber - b.episode.episodeNumber ||
        a.deviceId.localeCompare(b.deviceId),
    );

    return { enabled: true, characterKey, total, devices: rows };
  }

  /** 读设备当前下发（dashboard 展示用；未启用时返回 enabled=false，不暴露明细）。 */
  async assignment(deviceId: string) {
    if (!this.isEnabled()) {
      return { enabled: false, assignment: null };
    }
    const device = await this.resolveDevice(deviceId);
    if (!device.testAdventureEpisodeId) {
      return { enabled: true, assignment: null };
    }
    const [episode, version] = await Promise.all([
      this.prisma.adventureEpisode.findUnique({
        where: { id: device.testAdventureEpisodeId },
        select: {
          id: true,
          title: true,
          episodeNumber: true,
          characterKey: true,
          season: true,
        },
      }),
      device.testAdventureEpisodeVersionId
        ? this.prisma.adventureEpisodeVersion.findUnique({
            where: { id: device.testAdventureEpisodeVersionId },
            select: { id: true, version: true, status: true },
          })
        : Promise.resolve(null),
    ]);
    return {
      enabled: true,
      assignment: {
        device: {
          id: device.id,
          deviceId: device.deviceId,
          deviceCode: device.deviceCode,
        },
        episode,
        episodeVersion: version,
      },
    };
  }

  /** 审计尽力而为：会话已下发成功，审计写失败只进日志 + audited=false。 */
  private async recordAudit(
    actor: AuditActor,
    action: string,
    device: ResolvedDevice,
    reason: string,
    detail: unknown,
  ): Promise<boolean> {
    try {
      await this.audit.record(actor, {
        action,
        entityType: "device",
        businessKey: device.deviceId,
        reason,
        detail,
      });
      return true;
    } catch (error) {
      this.logger.error(
        `测试下发审计写入失败 actor=${actor.username} action=${action}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async resetStickySession(deviceInternalId: string): Promise<void> {
    try {
      await this.prisma.conversationSession.upsert({
        where: { deviceId: deviceInternalId },
        create: {
          deviceId: deviceInternalId,
          currentMode: "free_chat",
          expiresAt: null,
        },
        update: { currentMode: "free_chat", expiresAt: null },
      });
    } catch (error) {
      this.logger.warn(
        `Sticky session reset failed for device=${deviceInternalId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
