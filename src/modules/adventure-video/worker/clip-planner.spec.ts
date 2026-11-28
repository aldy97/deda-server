import { ClipPlanError, planClips } from "./clip-planner";

function beat(
  order: number,
  seconds: number,
  optional = false,
): {
  beatOrder: number;
  text: string;
  audioDurationSec: number;
  optional: boolean;
} {
  return {
    beatOrder: order,
    text: `beat-${order}`,
    audioDurationSec: seconds,
    optional,
  };
}

describe("planClips", () => {
  it("按真实时长装段，两段都不超 30 秒", () => {
    const result = planClips([beat(0, 12), beat(1, 13), beat(2, 14)]);
    expect(result.clips).toHaveLength(2);
    expect(result.clips[0].beats.map((b) => b.beatOrder)).toEqual([0, 1]);
    expect(result.clips[1].beats.map((b) => b.beatOrder)).toEqual([2]);
    expect(result.clips.every((clip) => clip.durationSec <= 30)).toBe(true);
  });

  it("时间戳连续，gap 计入下一段起点", () => {
    const result = planClips([beat(0, 10), beat(1, 10)], { gapSeconds: 0.5 });
    const [first, second] = result.clips[0].beats;
    expect(first.startSec).toBe(0);
    expect(first.endSec).toBe(10);
    expect(second.startSec).toBe(10.5);
  });

  it("超时长时先丢 optional，并记录被丢的 beat", () => {
    const result = planClips([beat(0, 20), beat(1, 20, true), beat(2, 20)], {
      maxTotalSeconds: 45,
    });
    expect(result.droppedBeatOrders).toEqual([1]);
    expect(
      result.clips.flatMap((clip) => clip.beats.map((b) => b.beatOrder)),
    ).toEqual([0, 2]);
  });

  it("丢光 optional 仍超时 → OVER_BUDGET", () => {
    expect(() =>
      planClips([beat(0, 25), beat(1, 25)], { maxTotalSeconds: 40 }),
    ).toThrow(ClipPlanError);
  });

  it("单段超过 30 秒直接拒绝，不静默截断", () => {
    expect(() => planClips([beat(0, 31)])).toThrow(/单段超过/);
  });

  it("空 beat 列表拒绝", () => {
    expect(() => planClips([])).toThrow(ClipPlanError);
  });
});
