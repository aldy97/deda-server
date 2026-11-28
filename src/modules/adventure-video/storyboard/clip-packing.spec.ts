import { packClipsByEstimate } from "./clip-packing";
import { StoryboardValidationError } from "./storyboard.validator";

function beat(order: number, chars: number) {
  return { order, text: "星".repeat(chars) };
}

describe("packClipsByEstimate", () => {
  it("按顺序装成两段，每段不超过 30 秒", () => {
    const clips = packClipsByEstimate([
      beat(0, 60),
      beat(1, 60),
      beat(2, 60),
      beat(3, 60),
    ]);
    expect(clips).toEqual([
      { order: 0, beats: [0, 1] },
      { order: 1, beats: [2, 3] },
    ]);
  });

  it("单段超 30 秒直接拒绝", () => {
    expect(() => packClipsByEstimate([beat(0, 200)])).toThrow(
      StoryboardValidationError,
    );
  });

  it("超过两段装不下时拒绝，不静默丢段", () => {
    try {
      packClipsByEstimate([beat(0, 100), beat(1, 100), beat(2, 100)]);
      throw new Error("expected error");
    } catch (error) {
      expect(error).toBeInstanceOf(StoryboardValidationError);
      expect((error as StoryboardValidationError).code).toBe(
        "STORYBOARD_CLIP_TOO_LONG",
      );
    }
  });
});
