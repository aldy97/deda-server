import {
  DEFAULT_SIMULATION_THRESHOLDS,
  simulateEpisode,
  TTS_CHARS_PER_SECOND,
} from "./adventure-simulator";
import {
  EpisodeContentDraft,
  EpisodeIdentity,
  EpisodeSegmentDraft,
} from "./adventure-content.types";

/**
 * 静态走查：让内容创作者在发布前看到孩子实际会听到什么、在哪里停下来等回答。
 * 刻意不复制引擎状态机——只按「recap + 旁白连播到交互点」的可见行为走一遍，
 * 避免两份实现各自漂移。
 */
describe("adventure-simulator", () => {
  const identity: EpisodeIdentity = {
    characterKey: "elly",
    season: 1,
    episodeNumber: 1,
  };

  const RECAP = "前情回顾。";
  const PROMPT = "我们去森林还是去河边？";

  const narration = (order: number, text: string): EpisodeSegmentDraft => ({
    order,
    kind: "narration",
    text,
  });

  const twoChoice = (
    order: number,
    overrides: Partial<EpisodeSegmentDraft> = {},
  ): EpisodeSegmentDraft => ({
    order,
    kind: "interaction",
    text: PROMPT,
    interactionType: "two_choice",
    options: {
      choices: [
        { key: "forest", text: "森林", reply: "好呀！" },
        { key: "river", text: "河边", reply: "走吧！" },
      ],
    },
    fallbackText: "那我替你选森林吧。",
    exitText: "那明天接着玩。",
    rewardStar: true,
    ...overrides,
  });

  const openQuestion = (
    order: number,
    overrides: Partial<EpisodeSegmentDraft> = {},
  ): EpisodeSegmentDraft => ({
    order,
    kind: "interaction",
    text: "你觉得 Elly 会怎么做？",
    interactionType: "open_question",
    options: null,
    fallbackText: "我们一起接着看。",
    exitText: "那明天接着玩。",
    rewardStar: false,
    ...overrides,
  });

  const content = (
    segments: EpisodeSegmentDraft[],
    overrides: Partial<EpisodeContentDraft> = {},
  ): EpisodeContentDraft => ({
    title: "听风原野第一天",
    recap: RECAP,
    segments,
    ...overrides,
  });

  const codes = (result: { problems: Array<{ code: string }> }) =>
    result.problems.map((problem) => problem.code);

  it("prepends the recap and batches narrations up to the first interaction", () => {
    const result = simulateEpisode(
      identity,
      content([
        narration(0, "第一段。"),
        narration(1, "第二段。"),
        twoChoice(2),
        narration(3, "结尾。"),
      ]),
    );

    expect(result.beats).toHaveLength(2);
    expect(result.beats[0]).toEqual(
      expect.objectContaining({
        says: [RECAP, "第一段。", "第二段。", PROMPT],
        stopsAtOrder: 2,
        waitsForReply: true,
        interactionType: "two_choice",
        outcome: "await_reply",
      }),
    );
    expect(result.beats[1]).toEqual(
      expect.objectContaining({
        says: ["结尾。"],
        stopsAtOrder: null,
        waitsForReply: false,
        interactionType: null,
        outcome: "episode_complete",
      }),
    );
  });

  it("omits the opening line when there is no recap", () => {
    const result = simulateEpisode(
      identity,
      content([narration(0, "第一段。"), twoChoice(1)], { recap: null }),
    );
    expect(result.beats[0].says).toEqual(["第一段。", PROMPT]);
  });

  it("exposes the choices on the beat so the UI can render the branch", () => {
    const result = simulateEpisode(identity, content([twoChoice(0)]));
    expect(result.beats[0].choices).toEqual([
      { key: "forest", text: "森林", reply: "好呀！" },
      { key: "river", text: "河边", reply: "走吧！" },
    ]);
  });

  it("does not stop at a reward interaction and counts its star inline", () => {
    const result = simulateEpisode(
      identity,
      content([
        narration(0, "开场。"),
        {
          order: 1,
          kind: "interaction",
          text: "你做到了！",
          interactionType: "reward",
          rewardStar: true,
        },
        narration(2, "继续走。"),
        twoChoice(3),
      ]),
    );

    expect(result.beats).toHaveLength(2);
    expect(result.beats[0].says).toEqual([
      RECAP,
      "开场。",
      "你做到了！",
      "继续走。",
      PROMPT,
    ]);
    expect(result.beats[0].starsAwarded).toBe(1);
    expect(result.beats[0].stopsAtOrder).toBe(3);
    expect(result.beats[1].starsAwarded).toBe(1);
    expect(result.awaitsReplyCount).toBe(1);
    expect(result.totalStars).toBe(2);
  });

  it("walks segments in order sequence even when the array is shuffled", () => {
    const result = simulateEpisode(
      identity,
      content([
        narration(2, "第三句。"),
        narration(0, "第一句。"),
        narration(1, "第二句。"),
      ]),
    );
    expect(result.beats[0].says).toEqual([
      RECAP,
      "第一句。",
      "第二句。",
      "第三句。",
    ]);
    expect(result.beats[0].outcome).toBe("episode_complete");
  });

  it("counts one await per reply-waiting interaction", () => {
    const result = simulateEpisode(
      identity,
      content([
        twoChoice(0),
        narration(1, "过场。"),
        openQuestion(2),
        narration(3, "结尾。"),
      ]),
    );
    expect(result.awaitsReplyCount).toBe(2);
    expect(result.beats.map((beat) => beat.outcome)).toEqual([
      "await_reply",
      "await_reply",
      "episode_complete",
    ]);
  });

  it("flags an episode that ends on a question with no closing line", () => {
    const result = simulateEpisode(
      identity,
      content([narration(0, "开场。"), twoChoice(1)]),
    );
    const last = result.beats[result.beats.length - 1];
    expect(last.outcome).toBe("episode_complete");
    expect(last.says).toEqual([]);
    expect(codes(result)).toContain("EPISODE_ENDS_ON_INTERACTION");
  });

  it("flags an episode where the child never gets to speak", () => {
    const result = simulateEpisode(
      identity,
      content([narration(0, "一段。"), narration(1, "两段。")]),
    );
    expect(result.awaitsReplyCount).toBe(0);
    expect(codes(result)).toContain("NO_AWAIT_POINTS");
  });

  it("flags an episode that never awards a star", () => {
    const result = simulateEpisode(
      identity,
      content([twoChoice(0, { rewardStar: false }), narration(1, "结尾。")]),
    );
    expect(result.totalStars).toBe(0);
    expect(codes(result)).toContain("STAR_NEVER_AWARDED");
  });

  it("flags a star set on an interaction type the engine never awards one for", () => {
    const result = simulateEpisode(
      identity,
      content([
        openQuestion(0, { rewardStar: true }),
        narration(1, "结尾。"),
        twoChoice(2),
      ]),
    );
    // 引擎只在 reward 段与 two_choice 命中时发星；挂在 open_question 上的星永远发不出去
    expect(codes(result)).toContain("STAR_ON_NON_AWARDING_INTERACTION");
    expect(result.totalStars).toBe(1);
  });

  it("flags too many stops for one sitting", () => {
    const segments: EpisodeSegmentDraft[] = [];
    for (let i = 0; i <= DEFAULT_SIMULATION_THRESHOLDS.maxAwaitPoints; i++) {
      segments.push(twoChoice(i));
    }
    segments.push(narration(segments.length, "结尾。"));
    const result = simulateEpisode(identity, content(segments));
    expect(codes(result)).toContain("TOO_MANY_AWAIT_POINTS");
  });

  it("estimates spoken length from recap plus the spine plus the expected response", () => {
    const result = simulateEpisode(
      identity,
      content([narration(0, "一二三四五"), twoChoice(1)]),
    );
    // recap + 旁白 + 引导词 + 两个选项接话的均值
    expect(result.totalSpokenChars).toBe(
      RECAP.length + "一二三四五".length + PROMPT.length + 3,
    );
    expect(result.estimatedSeconds).toBe(
      Math.round(result.totalSpokenChars / TTS_CHARS_PER_SECOND),
    );
  });

  it("counts the praise line for repeat_after_me and nothing for open_question", () => {
    const praise = "说得真好！";
    const withPraise = simulateEpisode(
      identity,
      content([
        {
          order: 0,
          kind: "interaction",
          text: "跟我念。",
          interactionType: "repeat_after_me",
          options: { praise },
          fallbackText: "没关系。",
          exitText: "明天见。",
          rewardStar: false,
        },
        narration(1, "结尾。"),
      ]),
    );
    expect(withPraise.totalSpokenChars).toBe(
      RECAP.length + "跟我念。".length + praise.length + "结尾。".length,
    );

    const openEnded = simulateEpisode(
      identity,
      content([openQuestion(0), narration(1, "结尾。")]),
    );
    // 开放提问的接话由小模型现场生成，不计入固定字数
    expect(openEnded.totalSpokenChars).toBe(
      RECAP.length + "你觉得 Elly 会怎么做？".length + "结尾。".length,
    );
  });

  it("flags a session that runs past the sitting budget", () => {
    const longText = "字".repeat(200);
    const result = simulateEpisode(
      identity,
      content([narration(0, longText), twoChoice(1), narration(2, "结尾。")]),
      { maxSessionSeconds: 10 },
    );
    expect(codes(result)).toContain("SESSION_TOO_LONG");
  });

  it("does not crash on an empty episode", () => {
    const result = simulateEpisode(identity, content([]));
    expect(result.beats).toEqual([]);
    expect(result.totalSpokenChars).toBe(0);
    expect(codes(result)).toContain("NO_SEGMENTS");
  });

  it("stamps every problem with the business key and a severity", () => {
    const result = simulateEpisode(identity, content([narration(0, "a")]));
    expect(result.problems.length).toBeGreaterThan(0);
    for (const problem of result.problems) {
      expect(problem.businessKey).toBe("elly/1/1");
      expect(["error", "warning"]).toContain(problem.severity);
      expect(problem.message.length).toBeGreaterThan(0);
    }
  });

  it("treats an interaction without a usable type as plain narration, like the engine does", () => {
    const result = simulateEpisode(
      identity,
      content([
        narration(0, "开场。"),
        { order: 1, kind: "interaction", text: "你想去哪？" },
        narration(2, "结尾。"),
      ]),
    );
    expect(result.awaitsReplyCount).toBe(0);
    expect(result.beats[0].says).toEqual([
      RECAP,
      "开场。",
      "你想去哪？",
      "结尾。",
    ]);
    expect(codes(result)).toContain("INTERACTION_WITHOUT_TYPE");
  });
});
