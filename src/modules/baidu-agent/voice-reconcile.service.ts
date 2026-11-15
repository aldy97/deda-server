import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import {
  VOICE_CATALOG_PORT,
  VoiceCatalogPort,
  BAIDU_AGENT_CLIENT_PORT,
  BaiduAgentClientPort,
  DesiredVoiceState,
  VoiceApplyOutcome,
  VoiceReconcilePort,
  VoiceApplyBlockReason,
  parseVoicePayload,
  TTS_SPD_MIN,
  TTS_SPD_MAX,
} from "./baidu-agent.types";
import { buildTtsConfig } from "./tts-config.util";
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
 *    可归因的 deferred 原因，留给下一轮 bot/start 追平。
 */
@Injectable()
export class VoiceReconcileService implements VoiceReconcilePort {
  private readonly logger = new Logger(VoiceReconcileService.name);

  /**
   * 档位→倍数是产品决策，走配置注入，代码里不出现魔法数字。
   */
  private readonly spdMap: ReadonlyMap<string, number>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
    @Inject(VOICE_CATALOG_PORT) private readonly catalog: VoiceCatalogPort,
    @Inject(BAIDU_AGENT_CLIENT_PORT)
    private readonly client: BaiduAgentClientPort,
  ) {
    this.spdMap = this.parseSpdMap(
      this.configService.get<string>("SPEECH_RATE_MAP_JSON"),
    );
  }

  // ---------------------------------------------------------------------------
  // VoiceReconcilePort
  // ---------------------------------------------------------------------------

  /** 查该设备 isActive:true 且 createdAt 最新的 DeviceConfig，返回期望音色/语速。 */
  async readDesired(deviceInternalId: string): Promise<DesiredVoiceState> {
    const config = await this.prisma.deviceConfig.findFirst({
      where: { deviceId: deviceInternalId, isActive: true },
      orderBy: { createdAt: "desc" },
    });

    if (!config) {
      return { vcn: null, speechRate: null };
    }

    const voice = parseVoicePayload(config.payload);
    return {
      vcn: voice?.vcn ?? null,
      speechRate: (config.speechRate as string | null) ?? null,
    };
  }

  /** 语速档位 → spd 倍数；未配置或越界时返回 null（不猜默认倍数）。 */
  resolveSpd(speechRate: string | null): number | null {
    if (!speechRate) return null;
    const spd = this.spdMap.get(speechRate);
    if (spd === undefined) return null;
    return spd;
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
  ): Promise<VoiceApplyOutcome> {
    if (desired.vcn === null && desired.speechRate === null) {
      return { applied: "noop" };
    }

    if (!this.client.enabled) {
      this.logger.warn(`Voice apply deferred: client disabled, mac=${mac}`);
      return { applied: "deferred", reason: "disabled" };
    }

    const instanceId = await this.redis.getValue(botCurrentKey(mac));
    if (!instanceId) {
      this.logger.warn(`Voice apply deferred: no active instance, mac=${mac}`);
      return { applied: "deferred", reason: "no_active_instance" };
    }

    return this.dispatchToInstance(mac, instanceId, desired);
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
  ): Promise<VoiceApplyOutcome> {
    try {
      const device = await this.prisma.device.findUnique({
        where: { deviceId: mac },
      });
      if (!device) {
        this.logger.warn(
          `Voice reconcile deferred: device not found, mac=${mac}`,
        );
        return { applied: "deferred", reason: "invalid_request" };
      }

      const desired = await this.readDesired(device.id);
      return this.dispatchToInstance(mac, instanceId, desired);
    } catch (error) {
      this.logger.warn(
        `Voice reconcile deferred: error, mac=${mac}, instanceId=${instanceId}, error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { applied: "deferred", reason: "internal_error" };
    }
  }

  // ---------------------------------------------------------------------------
  // private helpers
  // ---------------------------------------------------------------------------

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
  ): Promise<VoiceApplyOutcome> {
    if (desired.vcn === null && desired.speechRate === null) {
      return { applied: "noop" };
    }

    if (!this.client.enabled) {
      this.logger.warn(
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

    let spd: number | null = null;
    if (desired.speechRate !== null) {
      spd = this.resolveSpd(desired.speechRate);
      if (spd === null) {
        this.logger.warn(
          `Voice reconcile deferred: speech rate map missing, mac=${mac}, instanceId=${instanceId}, speechRate=${desired.speechRate}`,
        );
        return { applied: "deferred", reason: "speech_rate_map_missing" };
      }
    }

    // TODO(Q9): 只传 spd 不传 vcn 时百度侧是否沿用当前音色，官方文档未定义；
    // 确认前要求 vcn 与 spd 同时齐备才下发，缺一律记 incomplete_tts_target。
    const vcn = desired.vcn;
    if (!vcn || spd === null) {
      this.logger.warn(
        `Voice reconcile deferred: incomplete tts target, mac=${mac}, instanceId=${instanceId}`,
      );
      return { applied: "deferred", reason: "incomplete_tts_target" };
    }

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
    return { applied: "live" };
  }

  // ---------------------------------------------------------------------------
  // spd map parsing
  // ---------------------------------------------------------------------------

  private parseSpdMap(raw: string | undefined): ReadonlyMap<string, number> {
    if (!raw || raw.trim().length === 0) return new Map();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new Map();
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return new Map();
    }

    const map = new Map<string, number>();
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (value < TTS_SPD_MIN || value > TTS_SPD_MAX) continue;
      map.set(key, value);
    }
    return map;
  }
}
