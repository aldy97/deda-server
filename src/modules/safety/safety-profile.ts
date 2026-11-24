import { ChildSafetyService } from "@/modules/vendor/child-safety.service";
import type { SafetyVerdict } from "@/modules/vendor/child-safety.service";
import type { ConversationIntent } from "@/modules/vendor/conversation-session.service";
import type { SafetyProfileKey } from "./safety.types";

/**
 * 冒险链路的固定安全话术：由代码直接返回，绝不交给生成模型。
 * 触发条件只有一个——本轮 L2 明确判定 blocked（性/暴力/自伤）。
 */
export const ADVENTURE_UNSAFE_LINE = "我们先回到故事里，好吗？";

/**
 * L2 不可用（fail-open）时注入接话层的谨慎指令。
 * 正常情况下安全判定由 L2 负责；只有分类器异常/超时才让模型兜底，
 * 并明确“孩子对角色行为的道德评价不算不适宜”，避免误伤。
 */
export const ADVENTURE_SAFETY_CAUTION =
  "本轮安全分类不可用。若孩子的话涉及性、色情、隐私部位、真实暴力或伤害他人的方法、自伤、自杀、自残、辱骂或教唆伤害，不要复述，只说「我们先回到故事里，好吗？」。孩子对故事角色行为的道德评价或否定判断（如「你不应该偷拿别人的东西」）不属于不适宜内容。";

/**
 * L2 判为 emotional_harm（情绪宣泄，不拦截）时注入接话层的共情指令。
 * 与自由对话的 EMOTIONAL_HARM_GUIDANCE 同向，但把落点改成“接回故事”。
 */
export const ADVENTURE_EMOTIONAL_HARM_GUIDANCE =
  "孩子刚才的话带有攻击性或负面情绪。请先共情孩子的感受，温和地询问发生了什么；绝不附和、鼓励或复述任何伤害性内容，不批评、不说教；等孩子情绪平复后，自然接回故事。";

/** safety 话术的公共部分：三个 profile 都有的共情指令。 */
export interface SafetyProfileContent {
  /** emotional_harm 时注入的共情指令。 */
  emotionalHarmInstruction: string;
}

/** 冒险 profile 额外拥有固定安全句（同时是 echo 判定的子串）与谨慎指令。 */
export interface AdventureSafetyProfileContent extends SafetyProfileContent {
  /** 固定安全句，绝不交给生成模型。 */
  unsafeLine: string;
  /** L2 不可用时的谨慎指令。 */
  cautionInstruction: string;
}

export const PROFILE_CONTENT: {
  default: SafetyProfileContent;
  sleep: SafetyProfileContent;
  adventure: AdventureSafetyProfileContent;
} = {
  default: {
    emotionalHarmInstruction: ChildSafetyService.EMOTIONAL_HARM_GUIDANCE,
  },
  sleep: {
    emotionalHarmInstruction: ChildSafetyService.EMOTIONAL_HARM_GUIDANCE,
  },
  adventure: {
    unsafeLine: ADVENTURE_UNSAFE_LINE,
    cautionInstruction: ADVENTURE_SAFETY_CAUTION,
    emotionalHarmInstruction: ADVENTURE_EMOTIONAL_HARM_GUIDANCE,
  },
};

/**
 * 安全结论 → 附加指令，与引擎旧真值表逐行一致：
 * null（评估失败/未给结论）或 fail-open 来源 → 谨慎指令；emotional_harm → 共情指令。
 * undefined（调用方根本没提供判定）不注入，保持惰性路径零成本；
 * default/sleep 没有谨慎指令，避免把冒险专属文本注入普通对话。
 */
export function resolveSafetyInstruction(
  profile: SafetyProfileKey,
  verdict: SafetyVerdict | null | undefined,
): string | undefined {
  if (
    verdict === null ||
    verdict?.source === "l2_fail_open" ||
    verdict?.source === "l2_invalid_label"
  ) {
    return profile === "adventure"
      ? PROFILE_CONTENT.adventure.cautionInstruction
      : undefined;
  }
  if (verdict?.category === "emotional_harm") {
    return PROFILE_CONTENT[profile].emotionalHarmInstruction;
  }
  return undefined;
}

/** 与 messages.mode / llm-adapter mode 解析段保持一致的真实取值。 */
export type MessageMode =
  | "free_chat"
  | "english_chat"
  | "english_story"
  | "idiom_story"
  | "free_story"
  | "sleep_story"
  | "adventure_story";

export const MESSAGE_MODES: readonly MessageMode[] = [
  "free_chat",
  "english_chat",
  "english_story",
  "idiom_story",
  "free_story",
  "sleep_story",
  "adventure_story",
];

/**
 * 显式穷举：新增 mode 时 TS 会要求在这里补 profile，不允许运行时猜测。
 * sleep_config 是 intent 不是 mode，只在 resolveSafetyProfile 里做 override。
 */
export const PROFILE_BY_MODE: Record<MessageMode, SafetyProfileKey> = {
  free_chat: "default",
  english_chat: "default",
  english_story: "default",
  idiom_story: "default",
  free_story: "default",
  sleep_story: "sleep",
  adventure_story: "adventure",
};

/**
 * 优先级：
 * 1. sleep_config 意图（短链路落库 mode=free_chat，必须按 sleep 处理）
 * 2. 实际 message mode（冒险未真正开始时 mode=free_story，不能被 intent 抢走）
 * 3. 无 mode 时按 intent 兜底
 * 4. default
 */
export function resolveSafetyProfile(input: {
  mode?: MessageMode | null;
  intent?: ConversationIntent | null;
}): SafetyProfileKey {
  if (input.intent === "sleep_config") return "sleep";
  if (input.mode) return PROFILE_BY_MODE[input.mode];
  if (input.intent === "adventure_story") return "adventure";
  if (input.intent === "sleep_story") return "sleep";
  return "default";
}
