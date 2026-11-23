import type { ConversationIntent } from "@/modules/vendor/conversation-session.service";
import type { SafetyProfileKey } from "./safety.types";

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
