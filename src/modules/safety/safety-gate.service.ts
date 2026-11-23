import { Injectable } from "@nestjs/common";
import {
  BlockedSafetyCategory,
  ChildSafetyService,
  SafetyVerdict,
} from "@/modules/vendor/child-safety.service";
import type { ConversationIntent } from "@/modules/vendor/conversation-session.service";
import {
  BLOCKED_SAFETY_CATEGORIES,
  buildSafetySnapshot,
} from "./safety-policy";
import { resolveSafetyProfile, type MessageMode } from "./safety-profile";
import type { SafetyEvaluation, SafetyReply } from "./safety.types";

/**
 * 安全中心化的唯一 public 入口。
 *
 * Phase 2 只实现 default profile（普通聊天/故事），sleep 与 adventure
 * 由旧链路继续；interpret 不调用 L2，确保 shadow 不会双跑模型。
 */
@Injectable()
export class SafetyGateService {
  constructor(private readonly childSafety: ChildSafetyService) {}

  interpret(input: {
    verdict: SafetyVerdict | null;
    mode?: MessageMode | null;
    intent?: ConversationIntent | null;
  }): SafetyEvaluation | null {
    const profile = resolveSafetyProfile({
      mode: input.mode,
      intent: input.intent,
    });
    if (profile !== "default") return null;

    const verdict = input.verdict;
    const blocked = Boolean(
      verdict?.blocked &&
      verdict.category &&
      BLOCKED_SAFETY_CATEGORIES.includes(
        verdict.category as BlockedSafetyCategory,
      ),
    );
    const safetyReply: SafetyReply = blocked ? "canned_block" : "none";
    const cannedReply = blocked
      ? this.childSafety.cannedReply(verdict!.category as BlockedSafetyCategory)
      : undefined;
    const promptInstruction =
      verdict?.category === "emotional_harm"
        ? ChildSafetyService.EMOTIONAL_HARM_GUIDANCE
        : undefined;

    return {
      profile,
      verdict,
      blocked,
      safetyReply,
      cannedReply,
      promptInstruction,
      snapshot: buildSafetySnapshot(verdict, safetyReply),
    };
  }
}

/** shadow 只比较同一份 verdict 的两种解释，不做任何模型调用。 */
export function diffSafetyEvaluations(
  legacy: SafetyEvaluation,
  next: SafetyEvaluation,
): string[] {
  const diffs: string[] = [];
  if (legacy.profile !== next.profile) diffs.push("profile");
  if ((legacy.verdict?.source ?? null) !== (next.verdict?.source ?? null)) {
    diffs.push("verdict.source");
  }
  if (legacy.blocked !== next.blocked) diffs.push("blocked");
  if (legacy.safetyReply !== next.safetyReply) diffs.push("safetyReply");
  if (legacy.cannedReply !== next.cannedReply) diffs.push("cannedReply");
  if (legacy.promptInstruction !== next.promptInstruction) {
    diffs.push("promptInstruction");
  }
  if (JSON.stringify(legacy.snapshot) !== JSON.stringify(next.snapshot)) {
    diffs.push("snapshot");
  }
  return diffs;
}
