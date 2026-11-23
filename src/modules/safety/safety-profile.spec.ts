import {
  MESSAGE_MODES,
  PROFILE_BY_MODE,
  resolveSafetyProfile,
} from "./safety-profile";

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
