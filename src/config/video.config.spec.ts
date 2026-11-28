import {
  buildVoiceSetVersion,
  parseTtsMode,
  resolveVideoStudioConfig,
  VIDEO_SYSTEM_VOICES,
} from "./video.config";

function reader(values: Record<string, string | undefined>) {
  return (key: string) => values[key];
}

describe("resolveVideoStudioConfig", () => {
  it("空配置回落默认值：关闭、system、720P、9:16、50 元预算", () => {
    const config = resolveVideoStudioConfig(reader({}));
    expect(config.enabled).toBe(false);
    expect(config.ttsMode).toBe("system");
    expect(config.aspect).toBe("9:16");
    expect(config.resolution).toBe("720P");
    expect(config.budgetCents).toBe(5000);
    expect(config.systemVoices).toEqual(VIDEO_SYSTEM_VOICES);
    expect(config.workerConcurrency).toBe(2);
  });

  it("只有显式 true 才开启", () => {
    expect(
      resolveVideoStudioConfig(reader({ ADVENTURE_VIDEO_ENABLED: "1" }))
        .enabled,
    ).toBe(false);
    expect(
      resolveVideoStudioConfig(reader({ ADVENTURE_VIDEO_ENABLED: "TRUE" }))
        .enabled,
    ).toBe(false);
    expect(
      resolveVideoStudioConfig(reader({ ADVENTURE_VIDEO_ENABLED: "true" }))
        .enabled,
    ).toBe(true);
  });

  it("配置值 trim 后为空视为未配置", () => {
    const config = resolveVideoStudioConfig(
      reader({
        BAILIAN_API_KEY: "  sk-xx  ",
        BAILIAN_WORKSPACE_ID: "   ",
        OSS_BUCKET: "",
      }),
    );
    expect(config.bailian.apiKey).toBe("sk-xx");
    expect(config.bailian.workspaceId).toBe("");
    expect(config.oss.bucket).toBe("");
  });

  it("预算与并发只接受正整数，否则回落默认", () => {
    expect(
      resolveVideoStudioConfig(reader({ VIDEO_TEASER_BUDGET_CNY: "0" }))
        .budgetCents,
    ).toBe(5000);
    expect(
      resolveVideoStudioConfig(reader({ VIDEO_TEASER_BUDGET_CNY: "80" }))
        .budgetCents,
    ).toBe(8000);
    expect(
      resolveVideoStudioConfig(reader({ VIDEO_WORKER_CONCURRENCY: "-1" }))
        .workerConcurrency,
    ).toBe(2);
  });

  it("违禁词按中英逗号分隔解析，空配置为空数组", () => {
    expect(resolveVideoStudioConfig(reader({})).lintForbiddenWords).toEqual([]);
    expect(
      resolveVideoStudioConfig(
        reader({ ADVENTURE_LINT_FORBIDDEN_WORDS: "暴力, 恐怖，血腥" }),
      ).lintForbiddenWords,
    ).toEqual(["暴力", "恐怖", "血腥"]);
    expect(
      resolveVideoStudioConfig(
        reader({ ADVENTURE_LINT_FORBIDDEN_WORDS: "，,  " }),
      ).lintForbiddenWords,
    ).toEqual([]);
  });
});

describe("parseTtsMode", () => {
  it("只有 cloned 走复刻，其余一律 system", () => {
    expect(parseTtsMode("cloned")).toBe("cloned");
    expect(parseTtsMode(" CLONED ")).toBe("cloned");
    expect(parseTtsMode("system")).toBe("system");
    expect(parseTtsMode("clone")).toBe("system");
    expect(parseTtsMode(undefined)).toBe("system");
  });
});

describe("buildVoiceSetVersion", () => {
  const voices = { elly: "v1", polly: "v2", narrator: "v3" };

  it("同输入稳定，换模式或换任一音色都会变", () => {
    const base = buildVoiceSetVersion("system", voices);
    expect(buildVoiceSetVersion("system", { ...voices })).toBe(base);
    expect(buildVoiceSetVersion("cloned", voices)).not.toBe(base);
    expect(
      buildVoiceSetVersion("system", { ...voices, narrator: "v9" }),
    ).not.toBe(base);
  });

  it("带模式前缀，便于审计一眼看出是否复刻产物", () => {
    expect(buildVoiceSetVersion("system", voices).startsWith("system:")).toBe(
      true,
    );
    expect(buildVoiceSetVersion("cloned", voices).startsWith("cloned:")).toBe(
      true,
    );
  });
});
