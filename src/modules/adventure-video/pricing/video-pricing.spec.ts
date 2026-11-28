import {
  estimateTeaserCostCents,
  isSupportedResolution,
  ttsModelForMode,
} from "./video-pricing";

describe("video-pricing", () => {
  it("60 秒 720P 按原价算 36 元", () => {
    const cost = estimateTeaserCostCents({
      durationSec: 60,
      resolution: "720P",
      ttsChars: 0,
      ttsMode: "system",
    });
    expect(cost.videoCents).toBe(3600);
    expect(cost.totalCents).toBe(3600);
  });

  it("480P / 1080P 单价正确", () => {
    expect(
      estimateTeaserCostCents({
        durationSec: 60,
        resolution: "480P",
        ttsChars: 0,
        ttsMode: "system",
      }).videoCents,
    ).toBe(1800);
    expect(
      estimateTeaserCostCents({
        durationSec: 60,
        resolution: "1080P",
        ttsChars: 0,
        ttsMode: "system",
      }).videoCents,
    ).toBe(7200);
  });

  it("秒数向上取整，避免 30.4 秒按 30 秒估", () => {
    expect(
      estimateTeaserCostCents({
        durationSec: 30.4,
        resolution: "720P",
        ttsChars: 0,
        ttsMode: "system",
      }).videoCents,
    ).toBe(1860);
  });

  it("TTS 按万字符单价折算到分：3000 字 system 0.3 元 / cloned 0.24 元", () => {
    expect(
      estimateTeaserCostCents({
        durationSec: 0,
        resolution: "720P",
        ttsChars: 3000,
        ttsMode: "system",
      }).ttsCents,
    ).toBe(30);
    expect(
      estimateTeaserCostCents({
        durationSec: 0,
        resolution: "720P",
        ttsChars: 3000,
        ttsMode: "cloned",
      }).ttsCents,
    ).toBe(24);
  });

  it("参考图按张计费，可为 0", () => {
    expect(
      estimateTeaserCostCents({
        durationSec: 0,
        resolution: "720P",
        ttsChars: 0,
        ttsMode: "system",
        imageCount: 3,
      }).imageCents,
    ).toBe(54);
    expect(
      estimateTeaserCostCents({
        durationSec: 0,
        resolution: "720P",
        ttsChars: 0,
        ttsMode: "system",
      }).imageCents,
    ).toBe(0);
  });

  it("总额是三项相加", () => {
    const cost = estimateTeaserCostCents({
      durationSec: 60,
      resolution: "720P",
      ttsChars: 3000,
      ttsMode: "cloned",
      imageCount: 3,
    });
    expect(cost.totalCents).toBe(
      cost.videoCents + cost.ttsCents + cost.imageCents,
    );
  });

  it("不支持的分辨率直接抛错，不静默按 0 计", () => {
    expect(isSupportedResolution("4K")).toBe(false);
    expect(() =>
      estimateTeaserCostCents({
        durationSec: 60,
        resolution: "4K",
        ttsChars: 0,
        ttsMode: "system",
      }),
    ).toThrow("unsupported resolution");
  });

  it("TTS 模型随模式绑定", () => {
    expect(ttsModelForMode("system")).toBe("cosyvoice-v3-flash");
    expect(ttsModelForMode("cloned")).toBe("cosyvoice-v3.5-flash");
  });
});
