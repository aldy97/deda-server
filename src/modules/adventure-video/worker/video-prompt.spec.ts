import { buildClipPrompt, buildClipSeed } from "./video-prompt";

describe("video-prompt", () => {
  it("把真实时长写成时间戳分镜，并带上主角与风格", () => {
    const prompt = buildClipPrompt({
      stylePrompt: "柔和 3D 毛绒质感，暖色",
      characterKey: "elly",
      beats: [
        {
          startSec: 0,
          endSec: 8.2,
          shot: "远景，镜头缓慢向前推",
          visualPrompt: "月光下的湖边，小象踩着浅水",
        },
        {
          startSec: 8.55,
          endSec: 15,
          shot: "特写，小象抬头",
          visualPrompt: "湖面亮起一颗星星",
        },
      ],
    });
    expect(prompt).toContain("柔和 3D 毛绒质感");
    expect(prompt).toContain("小象 Elly");
    expect(prompt).toContain("0.0-8.2s：远景");
    expect(prompt).toContain("8.6-15.0s：特写");
    expect(prompt).toContain("9:16");
    expect(prompt).toContain("不需要口型同步");
  });

  it("polly 集用 Polly 作主角", () => {
    const prompt = buildClipPrompt({
      stylePrompt: "s",
      characterKey: "polly",
      beats: [{ startSec: 0, endSec: 5, shot: "s", visualPrompt: "v" }],
    });
    expect(prompt).toContain("小马 Polly");
    expect(prompt).not.toContain("小象 Elly");
  });

  it("seed 稳定且落在 wan3.0 允许区间", () => {
    const a = buildClipSeed("job-1", 0);
    expect(buildClipSeed("job-1", 0)).toBe(a);
    expect(buildClipSeed("job-1", 1)).not.toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(2_147_483_647);
  });
});
