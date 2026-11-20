import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AdventureService } from "@/modules/adventure/adventure.service";
import {
  AdventureTestAccessService,
  AdventureTestSession,
} from "@/modules/adventure/adventure-test-access.service";
import { ADVENTURE_TEST_DEFAULTS } from "@/modules/adventure/adventure.constants";
import { assertReason } from "./adventure-content.service";
import { AdventureAuditService, AuditActor } from "./adventure-audit.service";

/**
 * 管理台样机试播编排（为后续 dashboard 与 curl 预留的后端）。
 *
 * 只做三件事：把人的动作翻译成引擎调用、留审计、把引擎的试播会话
 * 翻译成看板可读的形状。业务真相（标题解析、进度重置、门禁豁免）
 * 全部在引擎侧——本服务与内容服务一样是「管理台 → 引擎」单向依赖。
 */

export interface DeviceTestArmInput {
  deviceId: string;
  title: string;
  reason?: string;
}

interface ResolvedDevice {
  id: string;
  deviceId: string;
  deviceCode: string | null;
  characterKey: string;
}

function publicSession(
  device: ResolvedDevice,
  session: AdventureTestSession,
  episodeInfo?: {
    title: string | null;
    episodeNumber: number;
    characterKey: string;
    season: number;
  },
) {
  return {
    device: {
      id: device.id,
      deviceId: device.deviceId,
      deviceCode: device.deviceCode,
      characterKey: device.characterKey,
    },
    episode: episodeInfo
      ? {
          id: session.episodeId,
          title: episodeInfo.title ?? session.title,
          episodeNumber: episodeInfo.episodeNumber,
          characterKey: episodeInfo.characterKey,
          season: episodeInfo.season,
        }
      : null,
    episodeVersionId: session.episodeVersionId,
    title: session.title,
    source: session.source,
    armedBy: session.armedBy,
    runSeq: session.runSeq,
    armedAt: session.armedAt,
    expiresAt: session.expiresAt,
  };
}

@Injectable()
export class AdventureDeviceTestService {
  private readonly logger = new Logger(AdventureDeviceTestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adventure: AdventureService,
    private readonly testAccess: AdventureTestAccessService,
    private readonly audit: AdventureAuditService,
  ) {}

  /**
   * 环境闸：人的闸在 ContentAdminGuard（scope + authoring），环境的闸在这里。
   * 未启用时写操作与明细一律 403——prod 连「当前有没有武装」都不需要暴露。
   * state() 例外：它要如实告诉看板「本环境关闭」，用于前端隐藏入口。
   */
  private assertEnabled(): void {
    if (!this.testAccess.isEnabled()) {
      throw new ForbiddenException(
        "样机试播未启用：ADVENTURE_TEST_MODE_ENABLED 不是 true（prod 永远不可用）。",
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
        characterKey: true,
      },
    });
    if (!device) {
      throw new NotFoundException(`Device not found: ${raw}`);
    }
    return device;
  }

  /** 当前环境开关与武装中的设备列表（dashboard 入口用；prod 返回 enabled=false）。 */
  async state() {
    if (!this.testAccess.isEnabled()) {
      return {
        enabled: false,
        ttlMinutes: ADVENTURE_TEST_DEFAULTS.sessionTtlMinutes,
        sessions: [],
      };
    }
    const sessions = await this.testAccess.listArmed();
    if (sessions.length === 0) {
      return {
        enabled: true,
        ttlMinutes: ADVENTURE_TEST_DEFAULTS.sessionTtlMinutes,
        sessions: [],
      };
    }
    const deviceIds = sessions.map((s) => s.deviceInternalId);
    const episodeIds = [...new Set(sessions.map((s) => s.episodeId))];
    const [devices, episodes] = await Promise.all([
      this.prisma.device.findMany({
        where: { id: { in: deviceIds } },
        select: {
          id: true,
          deviceId: true,
          deviceCode: true,
          characterKey: true,
        },
      }),
      this.prisma.adventureEpisode.findMany({
        where: { id: { in: episodeIds } },
        select: {
          id: true,
          title: true,
          episodeNumber: true,
          characterKey: true,
          season: true,
        },
      }),
    ]);
    const deviceById = new Map(devices.map((d) => [d.id, d]));
    const episodeById = new Map(episodes.map((e) => [e.id, e]));
    return {
      enabled: true,
      ttlMinutes: ADVENTURE_TEST_DEFAULTS.sessionTtlMinutes,
      sessions: sessions.map((s) =>
        publicSession(
          deviceById.get(s.deviceInternalId) ?? {
            id: s.deviceInternalId,
            deviceId: "",
            deviceCode: null,
            characterKey: "",
          },
          s,
          episodeById.get(s.episodeId),
        ),
      ),
    };
  }

  /** 武装：标题解析（含草稿标题）→ arm 会话 → 重置粘滞会话 → 审计。 */
  async arm(input: DeviceTestArmInput, actor: AuditActor) {
    this.assertEnabled();
    const reason = assertReason(input.reason);
    const device = await this.resolveDevice(input.deviceId);
    const session = await this.adventure.armTestSessionByTitle(
      device.id,
      input.title,
      { source: "admin_api", armedBy: actor.username },
    );
    if (!session) {
      throw new BadRequestException(
        `没有找到叫「${input.title}」的冒险故事（已发布标题或当前草稿标题），请确认标题。`,
      );
    }
    // 粘滞会话重置：与 ConversationSessionService.reset 同口径（不把 vendor
    // 的依赖拖进管理台模块）。不重置的话，残留的 english_story 粘滞态会
    // 把下一次开口的意图吃掉，触发词与「我想听故事」都进不了冒险。
    await this.resetStickySession(device.id);
    const audited = await this.recordAudit(
      actor,
      "device_test_arm",
      device,
      reason,
      {
        title: input.title,
        episodeId: session.episodeId,
        episodeVersionId: session.episodeVersionId,
        runSeq: session.runSeq,
      },
    );
    return { ok: true, session: publicSession(device, session), audited };
  }

  /** 同集从第 0 段重开（runSeq+1 + 进度重置，真相在引擎 restartTestRun）。 */
  async restart(deviceId: string, actor: AuditActor, reason?: string) {
    this.assertEnabled();
    const resolvedReason = assertReason(reason);
    const device = await this.resolveDevice(deviceId);
    const session = await this.adventure.restartTestRun(device.id);
    if (!session) {
      throw new BadRequestException(
        "该设备当前没有武装中的试播会话，无法重开。",
      );
    }
    const audited = await this.recordAudit(
      actor,
      "device_test_restart",
      device,
      resolvedReason,
      { episodeId: session.episodeId, runSeq: session.runSeq },
    );
    return { ok: true, session: publicSession(device, session), audited };
  }

  /** 解除武装：只清 Redis 会话，进度与事件原样保留。 */
  async clear(deviceId: string, actor: AuditActor, reason?: string) {
    this.assertEnabled();
    const resolvedReason = assertReason(reason);
    const device = await this.resolveDevice(deviceId);
    const previous = await this.testAccess.peek(device.id);
    await this.testAccess.clear(device.id);
    const audited = await this.recordAudit(
      actor,
      "device_test_clear",
      device,
      resolvedReason,
      { hadSession: previous ? previous.episodeId : null },
    );
    return { ok: true, audited };
  }

  /** 单台设备的武装会话 + 最近 20 条试播事件（payload.test=true）。 */
  async sessionDetail(deviceId: string) {
    this.assertEnabled();
    const device = await this.resolveDevice(deviceId);
    const session = await this.testAccess.peek(device.id);
    const events = await this.prisma.adventureEvent.findMany({
      where: { deviceId: device.id, payload: { path: ["test"], equals: true } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        eventType: true,
        eventKey: true,
        segmentOrder: true,
        payload: true,
        createdAt: true,
        episode: { select: { title: true, episodeNumber: true } },
      },
    });
    return {
      enabled: true,
      session: session ? publicSession(device, session) : null,
      recentEvents: events,
    };
  }

  /**
   * 审计是尽力而为：会话已经武装成功，因为审计写不进去就把结果一起丢掉，
   * 等于让操作者在看板上看不见自己刚做了什么。失败只进日志 + audited=false，
   * 由 dashboard 把「这次没留痕」显式摆出来（与 recordRecoveryAction 同口径）。
   */
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
        `试播审计写入失败 actor=${actor.username} action=${action}: ${
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
