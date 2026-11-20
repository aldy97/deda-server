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

/**
 * 全局唯一的退出话术。
 *
 * 刻意不做成每段可写的字段（原 `AdventureSegment.exitText` 已下线）：孩子在任何
 * IP、任何一集、任何一个互动点、甚至打断旁白时退出，都该听到同一句温柔收尾——
 * 逐段自定义只会让同一句话术在几十个段落里漂移出几十种说法，人设反而不一致。
 *
 * 与 ADVENTURE_DEGRADED_REPLIES 那条「不承诺继续冒险」的铁律**不冲突**：降级是
 * 「我们兜不住了」，退出是「孩子说不玩了，我们尊重他」。退出走 `exited` 状态，
 * 当日进度原样保留、孩子明确要求时可以从未答完的互动点续玩，所以这句承诺是真的。
 *
 * 这句话通过 admin capabilities 的 `fixedExitText` 下发给看板只读展示，
 * 前端不得内联硬编码（单一真相源在这里）。
 */
export const ADVENTURE_EXIT_TEXT = "好的，那么我们之后再一起继续冒险吧";

/**
 * 明确拒绝/退出的关键词。命中即温柔退出，绝不调模型、绝不追问。
 *
 * 这份词表是**引擎与会话层的唯一真相**：`AdventureService` 用它接管冒险轮次，
 * `ConversationSessionService.isExplicitExit` 用它中断 english_story / idiom_story /
 * sleep_story 的粘滞会话。此前两边各有一份（引擎 5 个词、会话层一条正则），
 * 于是孩子说「退出」时冒险不接管、说「不想玩」时粘滞会话不中断——同一句话在
 * 两条链路上结论不同。合成一份之后，任何一侧加词都自动对另一侧生效。
 *
 * 英文词按小写比较（见 isAdventureExitRequest）。
 */
export const ADVENTURE_EXIT_KEYWORDS = [
  "不要听",
  "不想听",
  "不想玩",
  "不玩了",
  "不要玩了",
  "退出",
  "停止",
  "结束",
  "别讲了",
  "stop",
  "quit",
  "exit",
] as const;

/**
 * 孩子这句话是不是「不想玩了」。
 *
 * 纯子串匹配、不调模型：退出是唯一一条**宁可多判也不能漏判**的路径——漏判的代价
 * 是孩子说了不玩还被继续追问，多判的代价只是提前温柔收尾且当日可续玩。
 */
export function isAdventureExitRequest(
  asrText: string | null | undefined,
): boolean {
  const normalized = (asrText ?? "").toLowerCase();
  if (!normalized.trim()) {
    return false;
  }
  return ADVENTURE_EXIT_KEYWORDS.some((keyword) =>
    normalized.includes(keyword),
  );
}

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

/**
 * 二选一 LLM 兜底判定开关默认值。
 *
 * 默认关：播放内容来自物化副本或孩子被锁定的版本快照，所以改内容只对新发布版本生效，
 * 但改匹配算法对正在玩的孩子立刻生效、没有版本快照保护 —— 这个开关是唯一能不发版就
 * 止血的机制。灰度验证通过后再由运维打开。
 */
export const ADVENTURE_CHOICE_LLM_DEFAULTS = {
  enabled: false,
} as const;

/** 二选一 LLM 兜底判定开关 → 环境变量名。值一律按字符串读，非字面 true 视为关。 */
export const ADVENTURE_CHOICE_LLM_ENV = {
  enabled: "ADVENTURE_CHOICE_LLM_ENABLED",
} as const;

/**
 * 测试冒险故事（仅 staging）环境开关。
 *
 * 新方案不再用 Redis 武装会话：device 上持久化一条下发关系
 * （testAdventureEpisodeId + 版本快照），孩子说固定触发词「测试冒险故事」
 * 即从第 0 段播放被下发的集，不限次数、不限顺序、可播草稿快照。
 *
 * 总开关沿用 fail-safe 哲学：只有部署显式写 ADVENTURE_TEST_MODE_ENABLED=true
 * 才启用（staging compose 硬写，base/prod 刻意不转发，由 compose-env-gate.spec.ts
 * 钉死）。未开启时触发词不生效、行为与普通设备完全一致。
 */
export const ADVENTURE_TEST_ENV = {
  enabled: "ADVENTURE_TEST_MODE_ENABLED",
} as const;

/** 测试冒险故事的语音触发词：ASR 文本 trim 后精确等于它即进入测试播放。 */
export const ADVENTURE_TEST_STORY_TRIGGER = "测试冒险故事";

/** 触发词命中但设备未下发任何集时的确定性话术：不走 LLM、不写库。 */
export const ADVENTURE_TEST_STORY_NOT_ASSIGNED_TEXT =
  "这台设备还没有下发测试冒险故事，请先在看板里给这台设备指定一集。";
