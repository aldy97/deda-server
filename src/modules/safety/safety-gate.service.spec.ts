import { ChildSafetyService } from "@/modules/vendor/child-safety.service";
import type { SafetyVerdict } from "@/modules/vendor/child-safety.service";
import {
  SafetyGateService,
  diffSafetyEvaluations,
} from "./safety-gate.service";

function verdict(overrides: Partial<SafetyVerdict> = {}): SafetyVerdict {
  return {
    blocked: true,
    category: "violence",
    layer: "L2",
    source: "l2_model",
    matched: null,
    ...overrides,
  };
}

const cannedReply = jest.fn().mockReturnValue("这个话题不适合小朋友聊哦。");
const childSafety = { cannedReply } as unknown as ChildSafetyService;
const gate = new SafetyGateService(childSafety);

beforeEach(() => {
  cannedReply.mockClear();
});

describe("SafetyGateService.interpret", () => {
  it("blocked → canned + canned_block + snapshot", () => {
    const result = gate.interpret({ verdict: verdict(), intent: "free_chat" });
    expect(result).toMatchObject({
      profile: "default",
      blocked: true,
      safetyReply: "canned_block",
      cannedReply: "这个话题不适合小朋友聊哦。",
      promptInstruction: undefined,
      snapshot: {
        layer: "L2",
        category: "violence",
        blocked: true,
        reply: "canned_block",
        inferred: false,
      },
    });
    expect(cannedReply).toHaveBeenCalledWith("violence");
  });

  it("emotional_harm → 不拦截但注入共情指令并写快照", () => {
    const result = gate.interpret({
      verdict: verdict({
        blocked: false,
        category: "emotional_harm",
      }),
      intent: "free_chat",
    });
    expect(result).toMatchObject({
      blocked: false,
      safetyReply: "none",
      promptInstruction: ChildSafetyService.EMOTIONAL_HARM_GUIDANCE,
      snapshot: { category: "emotional_harm", reply: "none" },
    });
    expect(result?.cannedReply).toBeUndefined();
  });

  it("fail-open → 不拦截，但写 fail-open 快照", () => {
    const result = gate.interpret({
      verdict: verdict({
        blocked: false,
        category: null,
        layer: null,
        source: "l2_fail_open",
      }),
      intent: "free_chat",
    });
    expect(result).toMatchObject({
      blocked: false,
      safetyReply: "none",
      promptInstruction: undefined,
      snapshot: { source: "l2_fail_open", reply: "none" },
    });
  });

  it("safe → 不写快照", () => {
    expect(
      gate.interpret({
        verdict: verdict({ blocked: false, category: "safe" }),
        intent: "free_chat",
      })?.snapshot,
    ).toBeNull();
  });

  it("sleep_story / sleep_config 使用 sleep profile", () => {
    expect(
      gate.interpret({ verdict: verdict(), mode: "sleep_story" }),
    ).toMatchObject({
      profile: "sleep",
      blocked: true,
      safetyReply: "canned_block",
      cannedReply: "这个话题不适合小朋友聊哦。",
    });
    expect(
      gate.interpret({ verdict: verdict(), intent: "sleep_config" }),
    ).toMatchObject({ profile: "sleep", blocked: true });
  });

  it("sleep profile 的 emotional_harm 仍注入共情指令", () => {
    expect(
      gate.interpret({
        verdict: verdict({ blocked: false, category: "emotional_harm" }),
        mode: "sleep_story",
      }),
    ).toMatchObject({
      profile: "sleep",
      blocked: false,
      promptInstruction: ChildSafetyService.EMOTIONAL_HARM_GUIDANCE,
      snapshot: { category: "emotional_harm" },
    });
  });

  it("adventure profile 在 Phase 3 仍返回 null，由旧链路继续", () => {
    expect(
      gate.interpret({ verdict: verdict(), mode: "adventure_story" }),
    ).toBeNull();
  });
});

describe("diffSafetyEvaluations", () => {
  const base = gate.interpret({ verdict: verdict(), intent: "free_chat" })!;

  it("完全一致返回空数组", () => {
    expect(diffSafetyEvaluations(base, { ...base })).toEqual([]);
  });

  it("逐项报告差异", () => {
    const next = {
      ...base,
      blocked: false,
      safetyReply: "none" as const,
      cannedReply: undefined,
      promptInstruction: "inject",
      snapshot: null,
    };
    const diffs = diffSafetyEvaluations(base, next);
    expect(diffs).toEqual(
      expect.arrayContaining([
        "blocked",
        "safetyReply",
        "cannedReply",
        "promptInstruction",
        "snapshot",
      ]),
    );
  });
});
