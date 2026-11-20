import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "@/common/redis/redis.service";
import {
  ADVENTURE_TEST_DEFAULTS,
  ADVENTURE_TEST_ENV,
  ADVENTURE_TEST_KEYS,
  ADVENTURE_TEST_TRIGGER_PREFIX,
} from "./adventure.constants";

/**
 * 样机试播会话（测试环境专用）。
 *
 * 放在**引擎侧**而不是管理台侧：`adventure.module.ts` 钉死依赖方向是
 * 「管理台 → 引擎」，引擎永远不知道管理台存在。试播会话是引擎门禁的
 * 输入之一（isCompletedToday / startToday 都要读它），所以状态真相必须
 * 在引擎一侧。管理台之后通过 AdventureModule 导出的同一份服务读写。
 */
export interface AdventureTestSession {
  deviceInternalId: string;
  episodeId: string;
  /** 锁定播放的版本快照；命中草稿标题时为草稿版本 id，否则为 null/当前发布版本 */
  episodeVersionId: string | null;
  /** 集标题（armed 时说话命中的标题；草稿标题与已发布标题可能不同） */
  title: string;
  source: "voice_trigger" | "admin_api";
  armedBy: string | null;
  /** 每次 arm 递增：事件键 run 后缀的唯一来源，保证同日重玩不撞 eventKey */
  runSeq: number;
  armedAt: string;
  expiresAt: string;
}

export interface ArmTestSessionInput {
  episodeId: string;
  episodeVersionId: string | null;
  title: string;
  source: AdventureTestSession["source"];
  armedBy?: string | null;
  /** 覆盖默认 TTL；夹在 1..1440 分钟 */
  ttlMinutes?: number;
}

/**
 * 试播会话的存储与判定服务。
 *
 * 双保险 fail-safe：
 * - `ADVENTURE_TEST_MODE_ENABLED` 不是字面 "true" → isEnabled() 恒 false，
 *   所有方法不碰 Redis、不产生任何行为变化（prod 与普通设备走原路径）；
 * - Redis 未配置时 RedisService 自动走内存兜底（单实例语义），staging 有
 *   独立 redis 容器，生产无影响。
 */
@Injectable()
export class AdventureTestAccessService {
  constructor(
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {}

  /** 环境总闸：非字面 "true" 一律视为关。 */
  isEnabled(): boolean {
    return (
      this.configService.get<string>(ADVENTURE_TEST_ENV.enabled) === "true"
    );
  }

  /**
   * 语音触发判定：纯字符串匹配、不调模型。命中返回完整标题，未命中/未启用
   * 返回 null。标题只做 trim，不做模糊匹配——说错就落 not-found 话术。
   */
  matchTrigger(asrText: string | null | undefined): string | null {
    if (!this.isEnabled()) {
      return null;
    }
    const text = (asrText ?? "").trim();
    if (!text.startsWith(ADVENTURE_TEST_TRIGGER_PREFIX)) {
      return null;
    }
    const title = text.slice(ADVENTURE_TEST_TRIGGER_PREFIX.length).trim();
    return title.length > 0 ? title : null;
  }

  /**
   * 武装（或重新武装）一台设备的试播会话。重复 arm 会 runSeq+1（新一轮），
   * 并刷新 TTL。未启用时返回 null 且不写任何东西。
   */
  async arm(
    deviceInternalId: string,
    input: ArmTestSessionInput,
  ): Promise<AdventureTestSession | null> {
    if (!this.isEnabled()) {
      return null;
    }
    const existing = await this.peek(deviceInternalId);
    const runSeq = (existing?.runSeq ?? 0) + 1;
    const ttlMinutes = Math.min(
      Math.max(
        1,
        Math.floor(
          input.ttlMinutes ?? ADVENTURE_TEST_DEFAULTS.sessionTtlMinutes,
        ),
      ),
      1440,
    );
    const now = Date.now();
    const expiresAtMs = now + ttlMinutes * 60_000;
    const session: AdventureTestSession = {
      deviceInternalId,
      episodeId: input.episodeId,
      episodeVersionId: input.episodeVersionId ?? null,
      title: input.title,
      source: input.source,
      armedBy: input.armedBy ?? null,
      runSeq,
      armedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
    await this.redis.setValue(
      this.sessionKey(deviceInternalId),
      JSON.stringify(session),
      ttlMinutes * 60,
    );
    await this.redis.zAdd(
      ADVENTURE_TEST_KEYS.index,
      expiresAtMs,
      deviceInternalId,
    );
    return session;
  }

  /** 读取当前武装会话；无会话/过期/损坏/未启用一律返回 null。 */
  async peek(deviceInternalId: string): Promise<AdventureTestSession | null> {
    if (!this.isEnabled()) {
      return null;
    }
    const raw = await this.redis.getValue(this.sessionKey(deviceInternalId));
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<AdventureTestSession>;
      if (
        typeof parsed.episodeId !== "string" ||
        typeof parsed.runSeq !== "number" ||
        typeof parsed.title !== "string"
      ) {
        return null;
      }
      return parsed as AdventureTestSession;
    } catch {
      return null;
    }
  }

  /** 解除武装。幂等；索引里的成员由 listArmed 惰性清理（TTL 到期后 peek 为 null）。 */
  async clear(deviceInternalId: string): Promise<void> {
    await this.redis.deleteValue(this.sessionKey(deviceInternalId));
  }

  /** 列出所有仍在有效期内的武装设备（供管理台与后续 dashboard 使用）。 */
  async listArmed(): Promise<AdventureTestSession[]> {
    if (!this.isEnabled()) {
      return [];
    }
    const now = Date.now();
    // 先清掉已过期索引条目，避免 zset 只增不减
    await this.redis.zRemRangeByScore(ADVENTURE_TEST_KEYS.index, 0, now);
    const entries = await this.redis.zRangeByScoreWithScores(
      ADVENTURE_TEST_KEYS.index,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const sessions: AdventureTestSession[] = [];
    for (const entry of entries) {
      const session = await this.peek(entry.member);
      if (session) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  private sessionKey(deviceInternalId: string): string {
    return `${ADVENTURE_TEST_KEYS.sessionPrefix}${deviceInternalId}`;
  }
}
