import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { RedisService } from "@/common/redis/redis.service";
import {
  ADVENTURE_BREAKER_KEYS,
  ADVENTURE_BREAKER_TRIPPED_MARKER,
  ADVENTURE_RECOVERY_DEFAULTS,
  ADVENTURE_RECOVERY_ENV,
} from "./adventure.constants";

/** recordFailure 的结果：只回答「熔断了吗、窗口内几次」，不含面板字段。 */
export interface BreakerRecordResult {
  enabled: boolean;
  tripped: boolean;
  failureCount: number;
  /** Redis 不可用：计数失真，此时刻意报告「未熔断」，见类注释 */
  degraded: boolean;
}

/** 面板状态：dashboard 的恢复健康页直接消费这个形状。 */
export interface BreakerState extends BreakerRecordResult {
  trippedAt: string | null;
  windowMs: number;
  threshold: number;
  recentReasons: string[];
  error: string | null;
}

/** member 编码分隔符。原因文本里的该字符会被压成空格，故解析无歧义。 */
const MEMBER_SEPARATOR = "|";
const RECENT_REASON_LIMIT = 10;
const MAX_REASON_CHARS = 120;

/**
 * 冒险兜底熔断器（纯观测面）。
 *
 * 职责边界，也是它安全的全部理由：
 * - 只做「计数 + 标记 + 告警」，**绝不改写任何内容、绝不回滚任何版本**。
 *   熊总的口径是「授权回滚，不做自动回滚」：自动改内容比故障本身更危险，
 *   因为它会在无人监督时把孩子的故事换掉。
 * - Redis 挂了绝不熔断（degraded=true）。观测面失真时，宁可少一条告警，
 *   也不能因为「读不到计数」就把系统判成故障、进而触发任何下游动作。
 * - 阈值到点只打一条带固定标记 ADVENTURE_RECOVERY_BREAKER_TRIPPED 的 error
 *   日志，交给日志告警规则抓取；同一轮熔断期内不重复刷屏。
 *
 * 滑动窗口用 Redis sorted set 实现：score = 失败发生时间戳，
 * 每次记录前先删掉窗口外的成员，再按 score 区间取计数。
 * RedisService 自带内存 fallback，因此无 Redis 的部署下计数仍可用（单实例内）。
 */
@Injectable()
export class AdventureCircuitBreaker {
  private readonly logger = new Logger(AdventureCircuitBreaker.name);

  constructor(
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 记一次兜底失败。一次巡检（无论修了几台设备）只记一次，
   * 避免上百台设备同时病态时瞬间打爆阈值、让告警失去信息量。
   */
  async recordFailure(reason: string): Promise<BreakerRecordResult> {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        tripped: false,
        failureCount: 0,
        degraded: false,
      };
    }
    const now = Date.now();
    const windowMs = this.resolveNumber(
      ADVENTURE_RECOVERY_ENV.breakerWindowMs,
      ADVENTURE_RECOVERY_DEFAULTS.breakerWindowMs,
    );
    const threshold = this.resolveNumber(
      ADVENTURE_RECOVERY_ENV.breakerThreshold,
      ADVENTURE_RECOVERY_DEFAULTS.breakerThreshold,
    );
    try {
      await this.redis.zRemRangeByScore(
        ADVENTURE_BREAKER_KEYS.window,
        0,
        now - windowMs,
      );
      await this.redis.zAdd(
        ADVENTURE_BREAKER_KEYS.window,
        now,
        this.encodeMember(now, reason),
      );
      const rows = await this.redis.zRangeByScoreWithScores(
        ADVENTURE_BREAKER_KEYS.window,
        now - windowMs,
        now,
      );
      const failureCount = rows.length;
      const tripped = failureCount >= threshold;
      if (tripped) {
        await this.markTripped(
          failureCount,
          rows.map((row) => this.decodeReason(row.member)),
          now,
          windowMs,
          threshold,
        );
      }
      return { enabled: true, tripped, failureCount, degraded: false };
    } catch (error) {
      this.logger.warn(
        `Adventure circuit breaker degraded, failure not counted: ${this.describe(
          error,
        )}`,
      );
      return { enabled: true, tripped: false, failureCount: 0, degraded: true };
    }
  }

  async getState(): Promise<BreakerState> {
    const windowMs = this.resolveNumber(
      ADVENTURE_RECOVERY_ENV.breakerWindowMs,
      ADVENTURE_RECOVERY_DEFAULTS.breakerWindowMs,
    );
    const threshold = this.resolveNumber(
      ADVENTURE_RECOVERY_ENV.breakerThreshold,
      ADVENTURE_RECOVERY_DEFAULTS.breakerThreshold,
    );
    if (!this.isEnabled()) {
      return {
        enabled: false,
        tripped: false,
        trippedAt: null,
        failureCount: 0,
        recentReasons: [],
        windowMs,
        threshold,
        degraded: false,
        error: null,
      };
    }
    const now = Date.now();
    try {
      await this.redis.zRemRangeByScore(
        ADVENTURE_BREAKER_KEYS.window,
        0,
        now - windowMs,
      );
      const rows = await this.redis.zRangeByScoreWithScores(
        ADVENTURE_BREAKER_KEYS.window,
        now - windowMs,
        now,
      );
      const raw = await this.redis.getValue(ADVENTURE_BREAKER_KEYS.tripped);
      return {
        enabled: true,
        tripped: !!raw,
        trippedAt: this.parseTrippedAt(raw),
        failureCount: rows.length,
        recentReasons: rows
          .map((row) => this.decodeReason(row.member))
          .slice(-RECENT_REASON_LIMIT),
        windowMs,
        threshold,
        degraded: false,
        error: null,
      };
    } catch (error) {
      const message = this.describe(error);
      this.logger.warn(
        `Adventure circuit breaker state unavailable: ${message}`,
      );
      return {
        enabled: true,
        tripped: false,
        trippedAt: null,
        failureCount: 0,
        recentReasons: [],
        windowMs,
        threshold,
        degraded: true,
        error: message,
      };
    }
  }

  /**
   * 清除熔断标记与窗口计数（admin 手动动作）。
   * 刻意不吞异常：这是人工操作，Redis 真挂了就该让操作者看到失败，
   * 而不是收到一个「已清除」的假成功。
   */
  async reset(): Promise<void> {
    await this.redis.deleteValue(ADVENTURE_BREAKER_KEYS.tripped);
    await this.redis.deleteValue(ADVENTURE_BREAKER_KEYS.window);
    this.logger.log("Adventure circuit breaker reset by admin");
  }

  private async markTripped(
    count: number,
    reasons: string[],
    now: number,
    windowMs: number,
    threshold: number,
  ): Promise<void> {
    const existing = await this.redis.getValue(ADVENTURE_BREAKER_KEYS.tripped);
    if (existing) {
      return; // 已在本轮熔断期内：计数继续累加，但不重复写标记、不重复告警
    }
    const recent = reasons.slice(-RECENT_REASON_LIMIT);
    const ttl = this.resolveNumber(
      ADVENTURE_RECOVERY_ENV.breakerTrippedTtlSeconds,
      ADVENTURE_RECOVERY_DEFAULTS.breakerTrippedTtlSeconds,
    );
    await this.redis.setValue(
      ADVENTURE_BREAKER_KEYS.tripped,
      JSON.stringify({
        trippedAt: new Date(now).toISOString(),
        count,
        reasons: recent,
      }),
      ttl,
    );
    this.logger.error(
      `${ADVENTURE_BREAKER_TRIPPED_MARKER} count=${count} windowMs=${windowMs} ` +
        `threshold=${threshold} reasons=${recent.join(" ; ")}`,
    );
  }

  private isEnabled(): boolean {
    const raw = this.configService.get<string>(
      ADVENTURE_RECOVERY_ENV.enabled,
    ) as string | undefined;
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return ADVENTURE_RECOVERY_DEFAULTS.enabled;
    }
    const normalized = String(raw).trim().toLowerCase();
    return normalized !== "false" && normalized !== "0";
  }

  private resolveNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key) as string | undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private encodeMember(now: number, reason: string): string {
    const safeReason = String(reason ?? "")
      .replace(/[|\n\r]+/g, " ")
      .trim()
      .slice(0, MAX_REASON_CHARS);
    return [now, randomUUID(), safeReason].join(MEMBER_SEPARATOR);
  }

  private decodeReason(member: string): string {
    const parts = String(member).split(MEMBER_SEPARATOR);
    return parts.slice(2).join(MEMBER_SEPARATOR);
  }

  private parseTrippedAt(raw: string | null): string | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { trippedAt?: unknown };
      return typeof parsed?.trippedAt === "string" ? parsed.trippedAt : null;
    } catch {
      return null;
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
