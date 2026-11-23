import type { SafetyVerdict } from "@/modules/vendor/child-safety.service";
import type { SafetyReply, SafetySnapshot } from "./safety.types";

const FAIL_OPEN_SOURCES = new Set(["l2_fail_open", "l2_invalid_label"]);

/**
 * 单谓词：本轮是否存在需要人工复核/消息快照的安全事件。
 * recorder 的原文留存与消息快照都从这里派生，避免两个 owner。
 */
export function isSafetyEvent(
  safety: SafetyVerdict | null | undefined,
  safetyReply: SafetyReply | null | undefined,
): boolean {
  const reply = safetyReply ?? "none";
  if (!safety) return reply !== "none";
  return (
    safety.blocked ||
    (safety.category !== null && safety.category !== "safe") ||
    FAIL_OPEN_SOURCES.has(safety.source ?? "") ||
    reply !== "none"
  );
}

/** recorder 唯一入口：是否应留 asrText 供人工复核。 */
export function shouldPersistAsrText(
  safety: SafetyVerdict | null | undefined,
  safetyReply: SafetyReply | null | undefined,
): boolean {
  const reply = safetyReply ?? "none";
  if (!safety) return reply !== "none";
  return (
    safety.blocked ||
    (safety.category !== null && safety.category !== "safe") ||
    reply !== "none"
  );
}

/**
 * 构造消息 rawPayload.safety。
 * 无 verdict 但实际播出了安全话术时，构造退化快照并标记 inferred=true，
 * 保证复核队列与消息详情看到同一件事。
 */
export function buildSafetySnapshot(
  safety: SafetyVerdict | null | undefined,
  safetyReply: SafetyReply,
): SafetySnapshot | null {
  if (!isSafetyEvent(safety, safetyReply)) return null;

  if (!safety) {
    return {
      layer: null,
      category: null,
      blocked: safetyReply === "canned_block",
      source:
        safetyReply === "unsafe_line_echo"
          ? "inferred_from_reply"
          : "not_evaluated",
      matched: null,
      reply: safetyReply,
      inferred: true,
    };
  }

  return {
    layer: safety.layer ?? null,
    category: safety.category ?? null,
    blocked: safety.blocked,
    source: safety.source ?? "not_evaluated",
    matched: safety.matched ?? null,
    reply: safetyReply,
    inferred: false,
  };
}

export interface SafetyReplyInput {
  texts: string[];
  safetyBlocked?: boolean;
  verdict?: SafetyVerdict | null;
  /** 由配置文件提供，safety 模块不 import 任何 mode 模块的常量。 */
  unsafeLine: string;
}

/**
 * 从实际播出内容解析安全处置，顺序不可变：
 * 代码拦截 > 回抄固定句 > 谨慎指令 > 未触发。
 */
export function resolveSafetyReply(input: SafetyReplyInput): SafetyReply {
  if (input.safetyBlocked || input.verdict?.blocked) return "canned_block";
  if (input.texts.some((text) => text.includes(input.unsafeLine))) {
    return "unsafe_line_echo";
  }
  if (input.verdict && FAIL_OPEN_SOURCES.has(input.verdict.source ?? "")) {
    return "caution_injected";
  }
  return "none";
}
