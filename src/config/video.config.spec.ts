import {
  buildVoiceSetVersion,
  parseTtsInstruction,
  parseTtsMode,
  resolveVideoStudioConfig,
  supportsTtsInstruction,
  VIDEO_SYSTEM_VOICES,
} from "./video.config";
import { DEFAULT_FORBIDDEN_WORDS } from "@/common/content/forbidden-words";

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

  it("违禁词空配置回落 baseline，env 只追加", () => {
    expect(resolveVideoStudioConfig(reader({})).lintForbiddenWords).toEqual([
      ...DEFAULT_FORBIDDEN_WORDS,
    ]);
    const merged = resolveVideoStudioConfig(
      reader({ ADVENTURE_LINT_FORBIDDEN_WORDS: "人贩子, 谣言，血腥" }),
    ).lintForbiddenWords;
    expect(merged.slice(0, DEFAULT_FORBIDDEN_WORDS.length)).toEqual([
      ...DEFAULT_FORBIDDEN_WORDS,
    ]);
    expect(merged).toContain("人贩子");
    expect(merged).toContain("谣言");
    expect(merged.filter((word) => word === "血腥")).toHaveLength(1);
    expect(
      resolveVideoStudioConfig(
        reader({ ADVENTURE_LINT_FORBIDDEN_WORDS: "，,  " }),
      ).lintForbiddenWords,
    ).toEqual([...DEFAULT_FORBIDDEN_WORDS]);
  });

  it("VIDEO_REFERENCE_KEYS 解析合法 JSON，非法 JSON 回落空对象", () => {
    expect(
      resolveVideoStudioConfig(
        reader({ VIDEO_REFERENCE_KEYS: '{"elly":"a.png","polly":"b.png"}' }),
      ).referenceKeys,
    ).toEqual({ elly: "a.png", polly: "b.png" });
    expect(
      resolveVideoStudioConfig(reader({ VIDEO_REFERENCE_KEYS: "not-json" }))
        .referenceKeys,
    ).toEqual({});
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

describe("tts instruction 开关", () => {
  it("默认 on，只有显式 off 才关", () => {
    expect(parseTtsInstruction(undefined)).toBe("on");
    expect(parseTtsInstruction("")).toBe("on");
    expect(parseTtsInstruction(" ON ")).toBe("on");
    expect(parseTtsInstruction("off")).toBe("off");
    expect(parseTtsInstruction(" OFF ")).toBe("off");
    expect(parseTtsInstruction("disable")).toBe("on");
  });

  it("resolveVideoStudioConfig 读出开关", () => {
    expect(resolveVideoStudioConfig(reader({})).ttsInstruction).toBe("on");
    expect(
      resolveVideoStudioConfig(reader({ VIDEO_TTS_INSTRUCTION: "off" }))
        .ttsInstruction,
    ).toBe("off");
  });

  it("system 试跑音色不支持 instruction，cloned 支持", () => {
    expect(
      supportsTtsInstruction({ ttsMode: "system", ttsInstruction: "on" }),
    ).toBe(false);
    expect(
      supportsTtsInstruction({ ttsMode: "cloned", ttsInstruction: "on" }),
    ).toBe(true);
  });

  it("紧急开关 off 时 cloned 也不发", () => {
    expect(
      supportsTtsInstruction({ ttsMode: "cloned", ttsInstruction: "off" }),
    ).toBe(false);
  });
});
