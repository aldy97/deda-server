/**
 * 冒险兜底与自愈的共享常量。
 *
 * 单独成文件的原因：这些话术与阈值同时被引擎（adventure.service）、
 * 自愈巡检（adventure-recovery.service）、熔断器与两条对话入口
 * （llm-adapter 主链路 / vendor 备选链路）使用，放任一模块内都会造成
 * 反向依赖或复制粘贴。常量文件不注入任何服务，谁都能安全 import。
 */

/**
 * L0 兜底话术：所有降级手段都用尽时的最后一句话。
 *
 * 铁律：温暖、不吓人、**不承诺继续冒险**。承诺了却做不到，比沉默更伤信任；
 * 也不得虚构剧情或进度（家长端能看到消息记录，假剧情等于撒谎）。
 */
export const ADVENTURE_DEGRADED_REPLIES = {
  /** 冒险引擎本轮出故障，但对话链路还活着：先安抚，再由上层走自由创作 */
  engine: "哎呀，我刚刚走神了一下。我们聊点别的好不好？",
  /** 连对话链路都失败了：只保证设备端有声音，不承诺任何内容 */
  lastResort: "我在这儿呢，我们等一会儿再玩好不好？",
} as const;

/** 巡检与熔断的默认阈值。全部可被环境变量覆盖（见 ADVENTURE_RECOVERY_ENV）。 */
export const ADVENTURE_RECOVERY_DEFAULTS = {
  /** 总开关：关掉后巡检不启动、不注册失败监听 */
  enabled: true,
  /** 巡检周期。60s：比引擎自身的 2s 超时扫描慢一个量级，避免抢跑 */
  sweepIntervalMs: 60_000,
  /**
   * 「等待互动但 waitingSince 为空」判定为陈旧所需的静默时长。
   * 仅在 staleAwaitAction 非 off 时生效——主链路（百度 RTC）刻意不落
   * waitingSince，这种状态在那条链路上是正常的，见 staleAwaitAction 说明。
   */
  staleAwaitMs: 120_000,
  /**
   * 陈旧等待态的处置方式：
   * - `off`（默认）：完全不扫这种行；
   * - `alert`：只告警不改状态；
   * - `exit`：改判 exited（当日孩子再开口可从原处续玩）。
   *
   * 默认 off 是硬要求：主链路 llm-adapter 从不调用 markPromptPlaybackComplete，
   * 于是每个孩子停在互动点时都是「awaiting_reply + waitingSince=null」，
   * 且可能一停就是几小时（第二天接着玩）。把它改判 exited 会让孩子的下一句
   * 「我选第二个」不再被 handleChildReply 接住，而是掉进意图分类变成闲聊，
   * 冒险在半路静默死掉。只有纯 vendor 链路（有 10s 沉默超时推送）的部署
   * 才应该开 alert/exit。
   */
  staleAwaitAction: "off" as "off" | "alert" | "exit",
  /** 熔断滑动窗口长度 */
  breakerWindowMs: 600_000,
  /** 窗口内失败达到此数即熔断（标记 + 告警，绝不自动改内容） */
  breakerThreshold: 5,
  /** 熔断标记的存活时间；过期后若窗口内仍超阈值会重新熔断并再次告警 */
  breakerTrippedTtlSeconds: 3600,
} as const;

/** 阈值 → 环境变量名。值一律按字符串读，非数字时回落默认值。 */
export const ADVENTURE_RECOVERY_ENV = {
  enabled: "ADVENTURE_RECOVERY_ENABLED",
  sweepIntervalMs: "ADVENTURE_RECOVERY_SWEEP_INTERVAL_MS",
  staleAwaitMs: "ADVENTURE_RECOVERY_STALE_AWAIT_MS",
  staleAwaitAction: "ADVENTURE_RECOVERY_STALE_AWAIT_ACTION",
  breakerWindowMs: "ADVENTURE_BREAKER_WINDOW_MS",
  breakerThreshold: "ADVENTURE_BREAKER_THRESHOLD",
  breakerTrippedTtlSeconds: "ADVENTURE_BREAKER_TRIPPED_TTL_SECONDS",
} as const;

/** 熔断标记日志的固定前缀，供日志告警规则抓取（改这个词等于改告警契约）。 */
export const ADVENTURE_BREAKER_TRIPPED_MARKER =
  "ADVENTURE_RECOVERY_BREAKER_TRIPPED";

/** 巡检发现病态进度时的固定日志前缀，同上。 */
export const ADVENTURE_RECOVERY_ALERT_MARKER = "ADVENTURE_RECOVERY_ALERT";

/** 引擎兜底失败的固定日志前缀，同上。 */
export const ADVENTURE_ENGINE_FAILURE_MARKER = "ADVENTURE_ENGINE_FAILURE";

/** 熔断状态在 Redis 中的 key（滑动窗口 zset 与熔断标记 string）。 */
export const ADVENTURE_BREAKER_KEYS = {
  window: "adventure:recovery:breaker",
  tripped: "adventure:recovery:breaker:tripped",
} as const;

/** 巡检报告内存环形缓冲长度：够 dashboard 看趋势，又不会无限涨内存。 */
export const ADVENTURE_SWEEP_HISTORY_LIMIT = 20;

/**
 * 引擎兜底失败的上报形状。
 *
 * 由 AdventureService 在 catch 里产出，AdventureRecoveryService 通过
 * registerFailureListener 接收（照抄既有 registerTimeoutListener 的惯用法，
 * 避免「引擎 ← 巡检」与「巡检 → 引擎」形成 DI 环）。
 */
export type AdventureFailurePhase =
  "start_today" | "handle_reply" | "check_timeout";

export interface AdventureFailureReport {
  /** 设备内部 id（Device.id），不是对外的业务 deviceId */
  deviceInternalId: string;
  phase: AdventureFailurePhase;
  /** 已归一化的错误消息，不含堆栈、不含孩子说的话 */
  reason: string;
  /** 是否已成功平移到下一集；false 表示上层还得继续降级 */
  recovered: boolean;
  at: string;
}

/** 面板上的引擎失败记录：字段名对外，deviceId 用内部 id 只读展示。 */
export interface EngineFailureRecord {
  deviceId: string;
  phase: AdventureFailurePhase;
  reason: string;
  recovered: boolean;
  at: string;
}

/** 引擎失败上报的内存环形缓冲长度。 */
export const ADVENTURE_ENGINE_FAILURE_LIMIT = 50;
