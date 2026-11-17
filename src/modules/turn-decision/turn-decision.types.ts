import type {
  SafetySource,
  SafetyVerdict,
} from "@/modules/vendor/child-safety.service";
import type {
  ConversationIntent,
  IntentSource,
} from "@/modules/vendor/conversation-session.service";

export type { SafetySource, SafetyVerdict, ConversationIntent, IntentSource };

/**
 * 落库用的意图来源。会话服务自身的 9 种来源之外，编排层还有三种「本轮没走到意图路由」
 * 或「路由结果不是模型判的」成因，必须与真实意图区分——否则看板会把「被安全拦截」和
 * 「匿名链路」都算成 free_chat，意图分布就成了假数据。
 * - not_routed：L1/L2 判定拦截，直接播兜底话术，未做意图分类
 * - adventure_takeover：冒险状态机在编排顺序上早于 L2，命中即返回，
 *   本轮既未评估 L2 也未分类意图（已知安全盲区，看板单独暴露）
 * - no_device：请求未带设备标识（匿名链路），无会话状态可依赖，恒定 free_chat
 *
 * 注：pre_filter_skip 已随前置关键词过滤移除而停用，保留取值只为让上线前的
 * 历史行仍能正确分桶；force_sleep / sleep_window_closed 是哄睡时段治理新增，
 * 其中 sleep_window_closed 本轮**调过**模型（模型判 sleep_story 后被规则降级），
 * 因此不计入 modelInvokedCount——该字段口径是「模型判定被直接采纳」。
 */
export type TurnIntentSource =
  IntentSource | "not_routed" | "adventure_takeover" | "no_device";

/** safetySource 全集，与 turn_decision_logs.safetySource 的取值域一致 */
export const SAFETY_SOURCES = [
  "l1_regex",
  "l2_model",
  "l2_invalid_label",
  "l2_fail_open",
  "not_evaluated",
] as const satisfies readonly SafetySource[];

/** intentSource 全集，与 turn_decision_logs.intentSource 的取值域一致 */
export const TURN_INTENT_SOURCES = [
  "model",
  "fallback_invalid_label",
  "fallback_error",
  "pre_filter_skip",
  "continuation",
  "session_sticky",
  "explicit_exit",
  "force_sleep",
  "sleep_window_closed",
  "adventure_takeover",
  "not_routed",
  "no_device",
] as const satisfies readonly TurnIntentSource[];

/**
 * 本期唯一在埋点的链路（百度 RTC OpenAI 兼容回调）。
 * 老 WS 链路 vendor.gateway 刻意不埋点，列保留以备将来接入。
 */
export const DEFAULT_TURN_CHANNEL = "baidu-rtc";

/** asrText 列宽 VARCHAR(200)，超长截断，避免落库报错反过来打断对话 */
export const ASR_TEXT_MAX_LENGTH = 200;

/** 编排层的意图决策：会话服务的 IntentDecision 加上编排独有的来源 */
export interface TurnIntentDecision {
  intent: ConversationIntent;
  source: TurnIntentSource;
}

export interface TurnDecisionRecord {
  /** 对话轮次 ID，幂等键；缺失时整条丢弃 */
  turnId: string;
  /** devices.id 内部 UUID；匿名链路为 null 且照记 */
  deviceId?: string | null;
  /** 缺省 baidu-rtc */
  channel?: string;
  /**
   * 本轮的安全判定。null / 省略 = 未评估（冒险接管等），
   * recorder 会落成 safetySource="not_evaluated" 而非伪装成 safe。
   */
  safety?: SafetyVerdict | null;
  /**
   * safety 为 null 时的来源覆盖。用于 safeClassifyL2 外层捕获到异常、
   * 连 verdict 都没拿到的情况：应记 l2_fail_open 而不是 not_evaluated。
   */
  safetySource?: SafetySource;
  /** 七标签之一；被拦截或未路由时为 null */
  intent?: ConversationIntent | null;
  intentSource?: TurnIntentSource | null;
  /**
   * 孩子的原话。只在「拦了」或「判成非 safe 类别」时落库，
   * 且任何情况下都不进日志——见 recorder 的 PII 纪律。
   */
  asrText?: string | null;
}
