import { ChildSafetyService } from "@/modules/vendor/child-safety.service";
import type { SafetyVerdict } from "@/modules/vendor/child-safety.service";
import {
  ADVENTURE_EMOTIONAL_HARM_GUIDANCE as LEGACY_EMOTIONAL_GUIDANCE,
  ADVENTURE_SAFETY_CAUTION as LEGACY_SAFETY_CAUTION,
  ADVENTURE_UNSAFE_LINE as LEGACY_UNSAFE_LINE,
} from "@/modules/adventure/adventure.constants";
import {
  ADVENTURE_EMOTIONAL_HARM_GUIDANCE,
  ADVENTURE_SAFETY_CAUTION,
  ADVENTURE_UNSAFE_LINE,
  MESSAGE_MODES,
  PROFILE_BY_MODE,
  PROFILE_CONTENT,
  resolveSafetyInstruction,
  resolveSafetyProfile,
} from "./safety-profile";

const verdict = (over: Partial<SafetyVerdict>): SafetyVerdict => ({
  blocked: false,
  category: "safe",
  layer: "L2",
  source: "l2_model",
  ...over,
});

describe("resolveSafetyProfile", () => {
  it.each([
    ["adventure_story", undefined, "adventure"],
    ["sleep_story", undefined, "sleep"],
    ["free_chat", undefined, "default"],
    ["english_chat", undefined, "default"],
    ["english_story", undefined, "default"],
    ["idiom_story", undefined, "default"],
    ["free_story", undefined, "default"],
  ] as const)("mode=%s → %s", (mode, intent, expected) => {
    expect(resolveSafetyProfile({ mode, intent })).toBe(expected);
  });

  it("sleep_config 意图即使落库 mode=free_chat，也归 sleep profile", () => {
    expect(
      resolveSafetyProfile({ mode: "free_chat", intent: "sleep_config" }),
    ).toBe("sleep");
  });

  it("adventure_story 意图但冒险未真正开始（mode=free_story）时按 default", () => {
    expect(
      resolveSafetyProfile({
        mode: "free_story",
        intent: "adventure_story",
      }),
    ).toBe("default");
  });

  it("缺失 mode/intent → default", () => {
    expect(resolveSafetyProfile({})).toBe("default");
  });

  it("每个真实 message mode 都有显式 profile", () => {
    for (const mode of MESSAGE_MODES) {
      expect(PROFILE_BY_MODE[mode]).toBeDefined();
    }
  });
});

describe("PROFILE_CONTENT", () => {
  it("冒险 profile 持有固定安全句与两条指令", () => {
    expect(PROFILE_CONTENT.adventure).toEqual({
      unsafeLine: ADVENTURE_UNSAFE_LINE,
      cautionInstruction: ADVENTURE_SAFETY_CAUTION,
      emotionalHarmInstruction: ADVENTURE_EMOTIONAL_HARM_GUIDANCE,
    });
  });

  it("default/sleep 不持有冒险专属文本", () => {
    for (const profile of ["default", "sleep"] as const) {
      expect("unsafeLine" in PROFILE_CONTENT[profile]).toBe(false);
      expect("cautionInstruction" in PROFILE_CONTENT[profile]).toBe(false);
    }
  });

  it("default/sleep 复用自由对话共情指令，冒险用接回故事的版本", () => {
    expect(PROFILE_CONTENT.default.emotionalHarmInstruction).toBe(
      ChildSafetyService.EMOTIONAL_HARM_GUIDANCE,
    );
    expect(PROFILE_CONTENT.sleep.emotionalHarmInstruction).toBe(
      ChildSafetyService.EMOTIONAL_HARM_GUIDANCE,
    );
    expect(PROFILE_CONTENT.adventure.emotionalHarmInstruction).toBe(
      ADVENTURE_EMOTIONAL_HARM_GUIDANCE,
    );
    expect(PROFILE_CONTENT.adventure.emotionalHarmInstruction).not.toBe(
      ChildSafetyService.EMOTIONAL_HARM_GUIDANCE,
    );
  });

  it("adventure.constants 的 re-export 与原值逐字节一致", () => {
    expect(LEGACY_UNSAFE_LINE).toBe(ADVENTURE_UNSAFE_LINE);
    expect(LEGACY_SAFETY_CAUTION).toBe(ADVENTURE_SAFETY_CAUTION);
    expect(LEGACY_EMOTIONAL_GUIDANCE).toBe(ADVENTURE_EMOTIONAL_HARM_GUIDANCE);
  });
});

describe("resolveSafetyInstruction", () => {
  it.each([
    ["null verdict", null],
    ["l2_fail_open", verdict({ category: null, source: "l2_fail_open" })],
    [
      "l2_invalid_label",
      verdict({ category: null, source: "l2_invalid_label" }),
    ],
  ] as const)("adventure + %s → 谨慎指令", (_name, safety) => {
    expect(resolveSafetyInstruction("adventure", safety)).toBe(
      ADVENTURE_SAFETY_CAUTION,
    );
  });

  it("adventure + emotional_harm → 接回故事的共情指令", () => {
    expect(
      resolveSafetyInstruction(
        "adventure",
        verdict({ category: "emotional_harm" }),
      ),
    ).toBe(ADVENTURE_EMOTIONAL_HARM_GUIDANCE);
  });

  it("adventure + safe → 不注入指令", () => {
    expect(resolveSafetyInstruction("adventure", verdict({}))).toBeUndefined();
  });

  it("未提供 verdict 时不误注入谨慎指令（与引擎旧真值表一致）", () => {
    expect(resolveSafetyInstruction("adventure", undefined)).toBeUndefined();
  });

  it("default/sleep 只在 emotional_harm 时注入自由对话共情指令", () => {
    expect(
      resolveSafetyInstruction(
        "default",
        verdict({ category: "emotional_harm" }),
      ),
    ).toBe(ChildSafetyService.EMOTIONAL_HARM_GUIDANCE);
    expect(
      resolveSafetyInstruction(
        "sleep",
        verdict({ category: "emotional_harm" }),
      ),
    ).toBe(ChildSafetyService.EMOTIONAL_HARM_GUIDANCE);
    expect(resolveSafetyInstruction("default", null)).toBeUndefined();
  });
});
