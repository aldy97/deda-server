import {
  StoryboardValidationError,
  validateStoryboard,
  type StoryboardEnvelope,
} from "./storyboard.validator";

const PAYLOAD = {
  title: "星星湖",
  segments: [
    { kind: "narration", text: "小象沿着湖边慢慢走。" },
    { kind: "narration", text: "忽然，湖面上亮起一颗星星。" },
    { kind: "interaction", text: "你愿意和我一起找星星吗？" },
  ],
};

const ENVELOPE: StoryboardEnvelope = {
  title: "星星湖",
  businessKey: "elly/1/3",
  episodeVersionId: "v1",
  contentHash: "hash-v1",
  aspect: "9:16",
  resolution: "720P",
};

function beat(overrides: Record<string, unknown> = {}) {
  return {
    order: 0,
    sourceSegmentOrders: [0],
    speaker: "narrator",
    text: "小象沿着湖边慢慢走。",
    emotion: "calm",
    characters: ["elly"],
    shot: "广角，镜头缓慢向前推",
    visualPrompt: "月光下的湖边，小象沿着水边走",
    optional: false,
    ...overrides,
  };
}

function validInput() {
  return {
    stylePrompt: "柔和 3D 毛绒质感，暖色，儿童绘本动画",
    beats: [
      beat(),
      beat({
        order: 1,
        sourceSegmentOrders: [1],
        text: "忽然，湖面上亮起一颗星星。",
        emotion: "curious",
      }),
      beat({
        order: 2,
        sourceSegmentOrders: [2],
        speaker: "elly",
        text: "你愿意和我一起找星星吗？",
        emotion: "gentle",
        characters: ["elly"],
      }),
    ],
    clips: [
      { order: 0, beats: [0, 1] },
      { order: 1, beats: [2] },
    ],
  };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error("expected validation error");
  } catch (error) {
    expect(error).toBeInstanceOf(StoryboardValidationError);
    expect((error as StoryboardValidationError).code).toBe(code);
  }
}

describe("validateStoryboard", () => {
  it("合法分镜原样通过，并补全信封字段", () => {
    const result = validateStoryboard(validInput(), PAYLOAD, ENVELOPE);
    expect(result.version).toBe(1);
    expect(result.businessKey).toBe("elly/1/3");
    expect(result.beats).toHaveLength(3);
    expect(result.totalTextChars).toBe(
      "小象沿着湖边慢慢走。".length +
        "忽然，湖面上亮起一颗星星。".length +
        "你愿意和我一起找星星吗？".length,
    );
  });

  it("受控压缩：忠于原文的改写可以通过（不再要求原文连续子串）", () => {
    const input = validInput();
    input.beats[0].text = "小象在湖边散步。";
    const result = validateStoryboard(input, PAYLOAD, ENVELOPE);
    expect(result.beats[0].text).toBe("小象在湖边散步。");
  });

  it("违禁词命中失败", () => {
    const input = validInput();
    input.beats[0].text = "小象打败了大坏人。";
    expectCode(
      () =>
        validateStoryboard(input, PAYLOAD, ENVELOPE, {
          forbiddenWords: ["坏人"],
        }),
      "STORYBOARD_FORBIDDEN_WORD",
    );
  });

  it("违禁词列表未配置时不扫描", () => {
    const input = validInput();
    input.beats[0].text = "小象在湖边散步。";
    const result = validateStoryboard(input, PAYLOAD, ENVELOPE);
    expect(result.beats[0].text).toBe("小象在湖边散步。");
  });

  it("shot 含违禁词失败", () => {
    const input = validInput();
    input.beats[0].shot = "镜头扫过一片血迹";
    expectCode(
      () =>
        validateStoryboard(input, PAYLOAD, ENVELOPE, {
          forbiddenWords: ["血迹"],
        }),
      "STORYBOARD_FORBIDDEN_WORD",
    );
  });

  it("visualPrompt 含违禁词失败", () => {
    const input = validInput();
    input.beats[0].visualPrompt = "地上有血迹，小象后退";
    expectCode(
      () =>
        validateStoryboard(input, PAYLOAD, ENVELOPE, {
          forbiddenWords: ["血迹"],
        }),
      "STORYBOARD_FORBIDDEN_WORD",
    );
  });

  it("stylePrompt 含违禁词失败", () => {
    const input = validInput();
    input.stylePrompt = "阴暗恐怖的森林，冷色";
    expectCode(
      () =>
        validateStoryboard(input, PAYLOAD, ENVELOPE, {
          forbiddenWords: ["恐怖"],
        }),
      "STORYBOARD_FORBIDDEN_WORD",
    );
  });

  it("跨相邻段合并时保留多段溯源下标", () => {
    const input = validInput();
    input.beats = [
      beat({
        sourceSegmentOrders: [0, 1],
        text: "小象沿着湖边慢慢走。忽然，湖面上亮起一颗星星。",
      }),
    ];
    input.clips = [{ order: 0, beats: [0] }];
    const result = validateStoryboard(input, PAYLOAD, ENVELOPE);
    expect(result.beats[0].sourceSegmentOrders).toEqual([0, 1]);
  });

  it("最多一处角色台词", () => {
    const input = validInput();
    input.beats[1].speaker = "elly";
    expectCode(
      () => validateStoryboard(input, PAYLOAD, ENVELOPE),
      "STORYBOARD_SPEAKER_LIMIT",
    );
  });

  it("角色说话时必须同时出现在画面里", () => {
    const input = validInput();
    input.beats[2].characters = [];
    expectCode(
      () => validateStoryboard(input, PAYLOAD, ENVELOPE),
      "STORYBOARD_SPEAKER_OFFSCREEN",
    );
  });

  it("字数超预算失败", () => {
    const input = validInput();
    expectCode(
      () =>
        validateStoryboard(input, PAYLOAD, ENVELOPE, {
          maxChars: 10,
        }),
      "STORYBOARD_CHAR_BUDGET",
    );
  });

  it("clip 必须不重不漏覆盖 beats", () => {
    const input = validInput();
    input.clips = [
      { order: 0, beats: [0, 1] },
      { order: 1, beats: [1] },
    ];
    expectCode(
      () => validateStoryboard(input, PAYLOAD, ENVELOPE),
      "STORYBOARD_CLIP_COVERAGE",
    );
  });

  it("单段超 30 秒失败", () => {
    const input = validInput();
    expectCode(
      () =>
        validateStoryboard(input, PAYLOAD, ENVELOPE, {
          maxClipSeconds: 1,
        }),
      "STORYBOARD_CLIP_TOO_LONG",
    );
  });

  it("optional 段数受限（开端与结局已被结构守卫排除，只统计中段）", () => {
    const input = validInput();
    input.beats[1].optional = true;
    expectCode(
      () =>
        validateStoryboard(input, PAYLOAD, ENVELOPE, { maxOptionalBeats: 0 }),
      "STORYBOARD_OPTIONAL_LIMIT",
    );
  });

  it("optional 必须是布尔值，字符串形式失败", () => {
    const input = validInput();
    (input.beats[1] as unknown as Record<string, unknown>).optional = "true";
    expectCode(
      () => validateStoryboard(input, PAYLOAD, ENVELOPE),
      "STORYBOARD_TYPE",
    );
  });

  it("开端 beat 标 optional 失败：三幕闭环不可裁剪开头", () => {
    const input = validInput();
    input.beats[0].optional = true;
    expectCode(
      () => validateStoryboard(input, PAYLOAD, ENVELOPE),
      "STORYBOARD_ENDING_REQUIRED",
    );
  });

  it("结局 beat 标 optional 失败：禁止以可裁剪段收尾", () => {
    const input = validInput();
    input.beats[2].optional = true;
    expectCode(
      () => validateStoryboard(input, PAYLOAD, ENVELOPE),
      "STORYBOARD_ENDING_REQUIRED",
    );
  });

  it("sourceSegmentOrders 越界失败", () => {
    const input = validInput();
    input.beats[0].sourceSegmentOrders = [99];
    expectCode(
      () => validateStoryboard(input, PAYLOAD, ENVELOPE),
      "STORYBOARD_SOURCE",
    );
  });

  it("情绪枚举非法失败", () => {
    const input = validInput();
    input.beats[0].emotion = "angry";
    expectCode(
      () => validateStoryboard(input, PAYLOAD, ENVELOPE),
      "STORYBOARD_EMOTION",
    );
  });

  it("总时长超 60 秒失败", () => {
    const input = validInput();
    expectCode(
      () =>
        validateStoryboard(input, PAYLOAD, ENVELOPE, {
          maxTotalSeconds: 1,
        }),
      "STORYBOARD_TOTAL_TOO_LONG",
    );
  });
});
