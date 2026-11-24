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
  resolveSafetyReply,
} from "./safety-policy";
import {
  PROFILE_CONTENT,
  resolveSafetyInstruction,
  resolveSafetyProfile,
  type MessageMode,
} from "./safety-profile";
import type {
  SafetyEvaluation,
  SafetyHandle,
  SafetyProfileKey,
  SafetyReply,
} from "./safety.types";

/**
 * 安全中心化的唯一 public 入口。
 *
 * - interpret：对既有 verdict 出解释（default/sleep），纯函数、不调用 L2，
 *   确保 shadow 不会双跑模型；adventure 仍返回 null。
 * - openLazyHandle（Phase 4）：冒险专用的惰性句柄，引擎决定何时评估。
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
    // Phase 3：default 与 sleep 共用同一套语义；adventure 留给 Phase 4。
    if (profile === "adventure") return null;

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

  /**
   * 冒险专用惰性句柄：引擎决定「何时评估」，gate 决定「如何解释」。
   * 非 adventure profile 返回 null，由既有 interpret 路径继续。
   */
  openLazyHandle(input: {
    profile?: SafetyProfileKey;
    mode?: MessageMode | null;
    intent?: ConversationIntent | null;
    getVerdict: () => Promise<SafetyVerdict | null>;
  }): SafetyHandle | null {
    const profile =
      input.profile ??
      resolveSafetyProfile({ mode: input.mode, intent: input.intent });
    if (profile !== "adventure") return null;

    const unsafeLine = PROFILE_CONTENT.adventure.unsafeLine;
    let requested = false;
    let inflight: Promise<SafetyVerdict | null> | null = null;
    let resolved: SafetyVerdict | null | undefined;

    const evaluateIfNeeded = (): Promise<SafetyVerdict | null> => {
      if (resolved !== undefined) return Promise.resolve(resolved);
      if (inflight) return inflight;
      requested = true;
      inflight = Promise.resolve()
        .then(input.getVerdict)
        .catch(() => {
          // 日志责任在 getVerdict 提供方（adapter 的 safeClassifyL2 自带
          // warn + null）。这里只保证句柄永不抛，避免把安全判定故障
          // 升级为本轮静默。
          return null;
        })
        .then((verdict) => {
          resolved = verdict;
          inflight = null;
          return verdict;
        });
      return inflight;
    };

    return {
      evaluateIfNeeded,
      promptInstruction: (verdict) =>
        resolveSafetyInstruction("adventure", verdict),
      /**
       * 生成后收口。同步契约：调用方必须先 await 过 evaluateIfNeeded
       * （引擎 withSafety 保证了这一点）。未评估时按「无 verdict」推断，
       * 绝不在这里补评估，否则确定性命中也会多付一次 L2。
       */
      finalize: (reply) => {
        const verdict = resolved ?? null;
        const safetyReply =
          reply.safetyDisposition ??
          resolveSafetyReply({
            texts: reply.texts,
            safetyBlocked: reply.safetyBlocked,
            verdict,
            unsafeLine,
          });
        // 显式处置来自产生点，不能被缓存 verdict 覆盖；正常路径两者等价。
        const blocked =
          Boolean(verdict?.blocked) || safetyReply === "canned_block";
        return {
          profile: "adventure",
          verdict,
          blocked,
          safetyReply,
          cannedReply: blocked ? unsafeLine : undefined,
          promptInstruction: resolveSafetyInstruction("adventure", verdict),
          snapshot: buildSafetySnapshot(verdict, safetyReply),
          evaluated: requested,
        };
      },
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
