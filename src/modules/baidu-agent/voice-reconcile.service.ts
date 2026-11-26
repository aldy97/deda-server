import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import {
  VOICE_CATALOG_PORT,
  VoiceCatalogPort,
  BAIDU_AGENT_CLIENT_PORT,
  BaiduAgentClientPort,
  CHARACTER_TIMBRE_PORT,
  CharacterTimbrePort,
  DesiredVoiceState,
  VoiceApplyOutcome,
  VoiceReconcilePort,
  VoiceApplyBlockReason,
  TTS_SPD_MIN,
  TTS_SPD_MAX,
  DEFAULT_NORMAL_SPD,
  DEFAULT_SLEEP_SPD,
  VOICE_SPEED_CONFIG_ID,
  VOICE_APPLIED_KEY_PREFIX,
  VOICE_APPLIED_TTL_SECONDS,
} from "./baidu-agent.types";
import { buildTtsConfig } from "./tts-config.util";
import { isActiveSleepSession } from "./sleep-session.util";
import {
  botCurrentKey,
  botInstanceKey,
} from "../client-api/client-api.constants";

/**
 * 与 client-api.service.ts 的 BotInstanceRecord 对齐的最小视图。
 * 该接口未导出，刻意不改 client-api 以避免耦合。
 */
interface BotInstanceRecordView {
  instanceid: string;
  appid: string;
  authorization_Role?: string;
  cloudNode: string;
  lang: string;
  status: "active" | "ended";
}

/**
 * 音色/语速切换编排服务。
 *
 * 职责：
 * 1. 从 DeviceConfig 读取设备当前期望的音色与语速；
 * 2. 对活跃百度实例实时下发（通过 switchSceneRole），或在条件不满足时返回
 *    可归因的 deferred 原因，留给下一轮 bot/start 追平；
 * 3. 提供 IP/角色 → timbreId 查表（character_timbre 表，见 CharacterTimbreService），
 *    是平台侧「某个 IP 用哪个音色」的唯一真相。设备端协议 v1.4（2026-11-18）新增
 *    POST /client/bot/bot/getvalue：固件每轮创建百度实例前拉取 vcn/vol/spd 且**不缓存**，
 *    vcn 即取自这张表；剧情内多 IP 同剧时按角色切音色也查同一张表。
 *    getvalue 的服务端实现见 ClientApiService.botGetValue。
 */
@Injectable()
export class VoiceReconcileService implements VoiceReconcilePort {
  private readonly logger = new Logger(VoiceReconcileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
    @Inject(VOICE_CATALOG_PORT) private readonly catalog: VoiceCatalogPort,
    @Inject(BAIDU_AGENT_CLIENT_PORT)
    private readonly client: BaiduAgentClientPort,
    @Inject(CHARACTER_TIMBRE_PORT)
    private readonly characterTimbre: CharacterTimbrePort,
  ) {}

  // ---------------------------------------------------------------------------
  // VoiceReconcilePort
  // ---------------------------------------------------------------------------

  /** 当前会话应生效的语速：哄睡中 sleepSpd，否则 normalSpd。 */
  async resolveActiveSpd(deviceInternalId: string): Promise<number> {
    const session = await this.prisma.conversationSession.findUnique({
      where: { deviceId: deviceInternalId },
      select: { currentMode: true, expiresAt: true },
    });
    return isActiveSleepSession(session)
      ? this.resolveSleepSpd()
      : this.resolveNormalSpd();
  }

  /** 非哄睡语速倍数；DB 无行或越界时回落 DEFAULT_NORMAL_SPD（不猜）。 */
  async resolveNormalSpd(): Promise<number> {
    const row = await this.prisma.voiceSpeedConfig.findUnique({
      where: { id: VOICE_SPEED_CONFIG_ID },
    });
    const spd = row?.normalSpd;
    if (!Number.isFinite(spd) || spd < TTS_SPD_MIN || spd > TTS_SPD_MAX) {
      return DEFAULT_NORMAL_SPD;
    }
    return spd;
  }

  /** 哄睡语速倍数；DB 无行或越界时回落 DEFAULT_SLEEP_SPD（不猜）。 */
  async resolveSleepSpd(): Promise<number> {
    const row = await this.prisma.voiceSpeedConfig.findUnique({
      where: { id: VOICE_SPEED_CONFIG_ID },
    });
    const spd = row?.sleepSpd;
    if (!Number.isFinite(spd) || spd < TTS_SPD_MIN || spd > TTS_SPD_MAX) {
      return DEFAULT_SLEEP_SPD;
    }
    return spd;
  }

  /**
   * 角色/IP → timbreId 查表；null/空 key 或未命中返回 null，由调用方决定降级。
   *
   * 委托 CharacterTimbreService（内存缓存），保留「永不抛错」的旧语义：
   * 缓存内部已吞 DB 异常，这里再兜一层，防止端口实现异常打断 getvalue。
   */
  async getTimbreForCharacter(
    characterKey: string | null,
  ): Promise<string | null> {
    if (!characterKey || characterKey.trim().length === 0) return null;
    try {
      return await this.characterTimbre.get(characterKey);
    } catch (error) {
      this.logger.warn(
        `timbre lookup failed, characterKey=${characterKey}, error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * 对设备当前活跃实例下发期望值；永不抛错。
   *
   * 与 onInstanceRegistered 的差别只在实例来源：这里要自己查 botCurrentKey，
   * 那里由 bot/start 直接给 instanceId。判定顺序统一由 dispatchToInstance 承担。
   */
  async applyToActiveInstance(
    mac: string,
    desired: DesiredVoiceState,
    deviceInternalId?: string,
  ): Promise<VoiceApplyOutcome> {
    if (desired.vcn === null) {
      return { applied: "noop" };
    }

    if (!this.client.enabled) {
      // 配置态而非异常态：暗启动期间每次调用都会命中，记 warn 会刷屏。
      // 可观测性由 App 接口响应里的 reason 字段保证。
      this.logger.debug(`Voice apply deferred: client disabled, mac=${mac}`);
      return { applied: "deferred", reason: "disabled" };
    }

    const instanceId = await this.redis.getValue(botCurrentKey(mac));
    if (!instanceId) {
      this.logger.warn(`Voice apply deferred: no active instance, mac=${mac}`);
      return { applied: "deferred", reason: "no_active_instance" };
    }

    return this.dispatchToInstance(mac, instanceId, desired, deviceInternalId);
  }

  /**
   * 设备 start 登记成功后的追平入口；永不抛错。
   *
   * 协议 4.2 要求 start 幂等返回 {"code":200}，追平失败绝不能影响该响应，
   * 否则设备会按协议 6.2 做无意义重试。
   */
  async onInstanceRegistered(
    mac: string,
    instanceId: string,
    device?: { id: string; characterKey: string | null },
  ): Promise<VoiceApplyOutcome> {
    try {
      // bot/start 已经查过 Device（401 校验），传进来就免掉这次重复查询。
      const resolved =
        device ??
        (await this.prisma.device.findUnique({
          where: { deviceId: mac },
          select: { id: true, characterKey: true },
        }));
      if (!resolved) {
        this.logger.warn(
          `Voice reconcile deferred: device not found, mac=${mac}`,
        );
        return { applied: "deferred", reason: "invalid_request" };
      }

      const vcn = await this.getTimbreForCharacter(resolved.characterKey);
      if (!vcn) {
        this.logger.warn(
          `Voice reconcile skipped: no timbre for characterKey=${resolved.characterKey}, mac=${mac}`,
        );
        return { applied: "noop" };
      }

      const spd = await this.resolveActiveSpd(resolved.id);
      return await this.applyToInstance(mac, instanceId, vcn, spd, false);
    } catch (error) {
      this.logger.warn(
        `Voice reconcile deferred: error, mac=${mac}, instanceId=${instanceId}, error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { applied: "deferred", reason: "internal_error" };
    }
  }

  /**
   * 对设备当前活跃实例实时下发指定语速倍数（不改变音色，vcn 沿用权威映射）。
   * 用于哄睡模式的临时降速：直接给倍数，不走语速档位映射。
   * 永不抛错；无活跃实例 / client 未启用时返回 deferred，由 getvalue 兜底。
   */
  async applySpd(
    mac: string,
    vcn: string,
    spd: number,
    options: { force?: boolean } = {},
  ): Promise<VoiceApplyOutcome> {
    if (!this.client.enabled) {
      this.logger.debug(`Voice apply deferred: client disabled, mac=${mac}`);
      return { applied: "deferred", reason: "disabled" };
    }

    const instanceId = await this.redis.getValue(botCurrentKey(mac));
    if (!instanceId) {
      this.logger.warn(`Voice apply deferred: no active instance, mac=${mac}`);
      return { applied: "deferred", reason: "no_active_instance" };
    }

    return this.applyToInstance(
      mac,
      instanceId,
      vcn,
      spd,
      options.force === true,
    );
  }

  /** 记录 getvalue 已交付的 TTS 状态，避免紧随其后的 start 追平重复出站。 */
  async noteApplied(mac: string, vcn: string, spd: number): Promise<void> {
    await this.markApplied(mac, vcn, spd);
  }

  // ---------------------------------------------------------------------------
  // private helpers
  // ---------------------------------------------------------------------------

  private appliedKey(mac: string): string {
    return `${VOICE_APPLIED_KEY_PREFIX}${mac}`;
  }

  private async readApplied(
    mac: string,
  ): Promise<{ vcn: string; spd: number } | null> {
    try {
      const raw = await this.redis.getValue(this.appliedKey(mac));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { vcn?: unknown; spd?: unknown };
      if (typeof parsed?.vcn !== "string" || typeof parsed?.spd !== "number") {
        return null;
      }
      return { vcn: parsed.vcn, spd: parsed.spd };
    } catch {
      // 缓存不可用按 miss 处理：宁可多下发一次，也不阻断设备对话。
      return null;
    }
  }

  private async markApplied(
    mac: string,
    vcn: string,
    spd: number,
  ): Promise<void> {
    try {
      await this.redis.setValue(
        this.appliedKey(mac),
        JSON.stringify({ vcn, spd }),
        VOICE_APPLIED_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.debug(
        `Voice applied cache write failed, mac=${mac}, error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 已拿到 instanceId 后的缓存检查 + 下发。
   * 缓存一致直接 noop；force 用于手动下发/显式修正，跳过缓存。
   */
  private async applyToInstance(
    mac: string,
    instanceId: string,
    vcn: string,
    spd: number,
    force: boolean,
  ): Promise<VoiceApplyOutcome> {
    if (!this.client.enabled) {
      this.logger.debug(`Voice apply deferred: client disabled, mac=${mac}`);
      return { applied: "deferred", reason: "disabled" };
    }

    const trimmed = vcn?.trim();
    if (!trimmed) {
      this.logger.warn(
        `Voice apply deferred: incomplete tts target, mac=${mac}, instanceId=${instanceId}`,
      );
      return { applied: "deferred", reason: "incomplete_tts_target" };
    }
    if (!Number.isFinite(spd) || spd < TTS_SPD_MIN || spd > TTS_SPD_MAX) {
      this.logger.warn(
        `Voice apply deferred: invalid spd, mac=${mac}, instanceId=${instanceId}, spd=${spd}`,
      );
      return { applied: "deferred", reason: "invalid_request" };
    }

    if (!force) {
      const applied = await this.readApplied(mac);
      if (applied && applied.vcn === trimmed && applied.spd === spd) {
        this.logger.debug(
          `Voice apply skipped: unchanged, mac=${mac}, instanceId=${instanceId}, spd=${spd}`,
        );
        return { applied: "noop" };
      }
    }

    return this.dispatchSpd(mac, instanceId, trimmed, spd);
  }

  /**
   * 读取并校验 Redis 中的实例登记记录。
   * 返回 null 表示该实例不可用于下发（记录缺失/解析失败/已结束/无签名）。
   */
  private async readInstance(
    mac: string,
    instanceId: string,
  ): Promise<BotInstanceRecordView | null> {
    const raw = await this.redis.getValue(botInstanceKey(mac, instanceId));
    if (!raw) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;

    if (obj.status !== "active") return null;
    if (
      typeof obj.authorization_Role !== "string" ||
      obj.authorization_Role.length === 0
    )
      return null;

    return {
      instanceid: String(obj.instanceid ?? ""),
      appid: String(obj.appid ?? ""),
      authorization_Role: obj.authorization_Role as string,
      cloudNode: String(obj.cloudNode ?? "cn"),
      lang: String(obj.lang ?? "zh"),
      status: "active",
    };
  }

  /**
   * 已拿到 instanceId 后的统一下发流程（任一步不满足即 deferred，不调 client）。
   */
  private async dispatchToInstance(
    mac: string,
    instanceId: string,
    desired: DesiredVoiceState,
    deviceInternalId?: string,
  ): Promise<VoiceApplyOutcome> {
    if (desired.vcn === null) {
      return { applied: "noop" };
    }

    if (!this.client.enabled) {
      // 同 applyToActiveInstance：配置态，暗启动期间每轮 start 都会命中。
      this.logger.debug(
        `Voice reconcile deferred: client disabled, mac=${mac}, instanceId=${instanceId}`,
      );
      return { applied: "deferred", reason: "disabled" };
    }

    const record = await this.readInstance(mac, instanceId);
    if (!record) {
      this.logger.warn(
        `Voice reconcile deferred: no active instance record, mac=${mac}, instanceId=${instanceId}`,
      );
      return { applied: "deferred", reason: "no_active_instance" };
    }

    if (!this.catalog.available) {
      this.logger.warn(
        `Voice reconcile deferred: empty catalog, mac=${mac}, instanceId=${instanceId}`,
      );
      return { applied: "deferred", reason: "empty_catalog" };
    }

    if (desired.vcn !== null) {
      const entry = this.catalog.find(desired.vcn, record.lang);
      if (!entry) {
        this.logger.warn(
          `Voice reconcile deferred: voice not in catalog, mac=${mac}, instanceId=${instanceId}, vcn=${desired.vcn}`,
        );
        return { applied: "deferred", reason: "voice_not_in_catalog" };
      }
    }

    // per-device 语速档位已被全局两值取代：spd 按当前会话模式取全局值。
    const vcn = desired.vcn;
    if (!vcn) {
      this.logger.warn(
        `Voice reconcile deferred: incomplete tts target, mac=${mac}, instanceId=${instanceId}`,
      );
      return { applied: "deferred", reason: "incomplete_tts_target" };
    }
    const spd = deviceInternalId
      ? await this.resolveActiveSpd(deviceInternalId)
      : await this.resolveNormalSpd();

    let tts: string;
    try {
      tts = buildTtsConfig({ vcn, spd });
    } catch {
      this.logger.warn(
        `Voice reconcile deferred: invalid tts config, mac=${mac}, instanceId=${instanceId}`,
      );
      return { applied: "deferred", reason: "invalid_request" };
    }

    const result = await this.client.switchSceneRole({
      appId: record.appid,
      instanceId: record.instanceid,
      tts,
      lang: record.lang,
      authString: record.authorization_Role,
      cloudNode: record.cloudNode,
    });

    if (!result.ok) {
      // tsconfig strictNullChecks:false，判别联合不会自动收窄，只能显式取类型。
      const reason = (result as { reason: VoiceApplyBlockReason }).reason;
      this.logger.warn(
        `Voice reconcile deferred: upstream, mac=${mac}, instanceId=${instanceId}, reason=${reason}`,
      );
      return { applied: "deferred", reason };
    }

    this.logger.log(
      `Voice reconcile live, mac=${mac}, instanceId=${instanceId}`,
    );
    await this.markApplied(mac, vcn, spd);
    return { applied: "live" };
  }

  /**
   * 已拿到 instanceId 后按指定 spd 下发。与 dispatchToInstance 的差别：
   * 这里直接收倍数、不走语速档位映射，也不校验音色目录（vcn 是 IP 权威映射，
   * 不是目录查询，目录本身还是 placeholder）。
   */
  private async dispatchSpd(
    mac: string,
    instanceId: string,
    vcn: string,
    spd: number,
  ): Promise<VoiceApplyOutcome> {
    const trimmed = vcn?.trim();
    if (!trimmed) {
      this.logger.warn(
        `Voice apply deferred: incomplete tts target, mac=${mac}, instanceId=${instanceId}`,
      );
      return { applied: "deferred", reason: "incomplete_tts_target" };
    }
    if (!Number.isFinite(spd) || spd < TTS_SPD_MIN || spd > TTS_SPD_MAX) {
      this.logger.warn(
        `Voice apply deferred: invalid spd, mac=${mac}, instanceId=${instanceId}, spd=${spd}`,
      );
      return { applied: "deferred", reason: "invalid_request" };
    }

    const record = await this.readInstance(mac, instanceId);
    if (!record) {
      this.logger.warn(
        `Voice apply deferred: no active instance record, mac=${mac}, instanceId=${instanceId}`,
      );
      return { applied: "deferred", reason: "no_active_instance" };
    }

    let tts: string;
    try {
      tts = buildTtsConfig({ vcn: trimmed, spd });
    } catch {
      this.logger.warn(
        `Voice apply deferred: invalid tts config, mac=${mac}, instanceId=${instanceId}`,
      );
      return { applied: "deferred", reason: "invalid_request" };
    }

    const result = await this.client.switchSceneRole({
      appId: record.appid,
      instanceId: record.instanceid,
      tts,
      lang: record.lang,
      authString: record.authorization_Role,
      cloudNode: record.cloudNode,
    });

    if (!result.ok) {
      const reason = (result as { reason: VoiceApplyBlockReason }).reason;
      this.logger.warn(
        `Voice apply deferred: upstream, mac=${mac}, instanceId=${instanceId}, reason=${reason}`,
      );
      return { applied: "deferred", reason };
    }

    this.logger.log(
      `Voice apply spd live, mac=${mac}, instanceId=${instanceId}, spd=${spd}`,
    );
    await this.markApplied(mac, trimmed, spd);
    return { applied: "live" };
  }
}
