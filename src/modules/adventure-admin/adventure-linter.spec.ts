import {
  DEFAULT_LINT_THRESHOLDS,
  lintEpisode,
  LintIssue,
} from "./adventure-linter";
import {
  EpisodeContentDraft,
  EpisodeIdentity,
  EpisodeSegmentDraft,
} from "./adventure-content.types";

/**
 * 发布闸口的规则集。每一条 error 都对应一个「上线后孩子会遇到什么」的真实故障，
 * 所以这里逐条规则建用例，而不是只测一个「合法内容通过」。
 */
describe("adventure-linter", () => {
  const identity: EpisodeIdentity = {
    characterKey: "elly",
    season: 1,
    episodeNumber: 1,
  };

  const narration = (
    order: number,
    text: string,
    extra: Partial<EpisodeSegmentDraft> = {},
  ): EpisodeSegmentDraft => ({ order, kind: "narration", text, ...extra });

  const twoChoice = (
    order: number,
    extra: Partial<EpisodeSegmentDraft> = {},
  ): EpisodeSegmentDraft => ({
    order,
    kind: "interaction",
    text: "我们去森林还是去河边？",
    interactionType: "two_choice",
    options: {
      choices: [
        { key: "forest", text: "森林", reply: "好呀，我们去森林！" },
        { key: "river", text: "河边", reply: "走，我们去河边！" },
      ],
    },
    fallbackText: "没关系，那我替你选森林吧！",
    exitText: "好呀，那我们明天接着玩。",
    rewardStar: true,
    ...extra,
  });

  const valid = (): EpisodeContentDraft => ({
    title: "听风原野第一天",
    recap: "上次 Elly 找到了风铃。",
    segments: [
      narration(0, "今天 Elly 要出门啦。"),
      twoChoice(1),
      narration(2, "森林里有只小松鼠。"),
    ],
  });

  const codes = (issues: LintIssue[]) => issues.map((issue) => issue.code);

  it("accepts a well-formed episode without errors", () => {
    const report = lintEpisode(identity, valid());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("always reports an error for a broken episode and never says ok", () => {
    const report = lintEpisode(identity, { title: "", segments: [] });
    expect(report.ok).toBe(false);
    expect(codes(report.errors)).toContain("TITLE_REQUIRED");
    expect(codes(report.errors)).toContain("NO_SEGMENTS");
  });

  it("separates errors from warnings", () => {
    const report = lintEpisode(identity, {
      ...valid(),
      recap: null,
    });
    expect(report.errors).toEqual([]);
    expect(codes(report.warnings)).toContain("RECAP_EMPTY");
    expect(report.ok).toBe(true);
  });

  describe("identity", () => {
    it("rejects a season other than 1", () => {
      const report = lintEpisode({ ...identity, season: 2 }, valid());
      expect(codes(report.errors)).toContain("SEASON_UNSUPPORTED");
    });

    it("rejects an unknown character key", () => {
      const report = lintEpisode(
        { ...identity, characterKey: "dumbo" as never },
        valid(),
      );
      expect(codes(report.errors)).toContain("UNKNOWN_CHARACTER_KEY");
    });

    it("rejects a non-positive or fractional episode number", () => {
      expect(
        codes(lintEpisode({ ...identity, episodeNumber: 0 }, valid()).errors),
      ).toContain("INVALID_EPISODE_NUMBER");
      expect(
        codes(lintEpisode({ ...identity, episodeNumber: 1.5 }, valid()).errors),
      ).toContain("INVALID_EPISODE_NUMBER");
    });

    it("rejects a business key already used by another episode", () => {
      const report = lintEpisode(identity, valid(), {
        takenBusinessKeys: ["elly/1/1"],
      });
      expect(codes(report.errors)).toContain("BUSINESS_KEY_TAKEN");
    });

    it("does not flag the episode's own business key when editing it", () => {
      const report = lintEpisode(identity, valid(), {
        takenBusinessKeys: ["elly/1/1"],
        ownBusinessKey: "elly/1/1",
      });
      expect(codes(report.errors)).not.toContain("BUSINESS_KEY_TAKEN");
    });

    it("blocks publishing episode 3 while episode 2 is still unpublished", () => {
      const report = lintEpisode({ ...identity, episodeNumber: 3 }, valid(), {
        forPublish: true,
        publishedEpisodeNumbers: [1],
      });
      expect(codes(report.errors)).toContain("PREDECESSOR_NOT_PUBLISHED");
    });

    it("allows publishing episode 1 with no predecessors", () => {
      const report = lintEpisode(identity, valid(), {
        forPublish: true,
        publishedEpisodeNumbers: [],
      });
      expect(codes(report.errors)).not.toContain("PREDECESSOR_NOT_PUBLISHED");
    });

    it("does not apply the publish-order rule to a plain draft save", () => {
      const report = lintEpisode({ ...identity, episodeNumber: 3 }, valid(), {
        publishedEpisodeNumbers: [],
      });
      expect(codes(report.errors)).not.toContain("PREDECESSOR_NOT_PUBLISHED");
    });
  });

  describe("segment ordering", () => {
    it("rejects an episode with no segments", () => {
      const report = lintEpisode(identity, { title: "t", segments: [] });
      expect(codes(report.errors)).toContain("NO_SEGMENTS");
    });

    it("rejects a gap in order because the engine would misjudge completion", () => {
      const report = lintEpisode(identity, {
        ...valid(),
        segments: [narration(0, "a"), narration(2, "b")],
      });
      expect(codes(report.errors)).toContain("SEGMENT_ORDER_GAP");
    });

    it("rejects a duplicated order", () => {
      const report = lintEpisode(identity, {
        ...valid(),
        segments: [narration(0, "a"), narration(0, "b")],
      });
      expect(codes(report.errors)).toContain("SEGMENT_ORDER_DUPLICATE");
    });

    it("rejects an order that does not start at zero", () => {
      const report = lintEpisode(identity, {
        ...valid(),
        segments: [narration(1, "a"), narration(2, "b")],
      });
      expect(codes(report.errors)).toContain("SEGMENT_ORDER_GAP");
    });

    it("accepts unsorted input as long as the order set is contiguous", () => {
      const report = lintEpisode(identity, {
        ...valid(),
        segments: [narration(2, "c"), narration(0, "a"), narration(1, "b")],
      });
      expect(codes(report.errors)).not.toContain("SEGMENT_ORDER_GAP");
    });

    it("rejects an unknown kind and an empty text", () => {
      const report = lintEpisode(identity, {
        title: "t",
        segments: [
          { order: 0, kind: "cutscene" as never, text: "a" },
          narration(1, "   "),
        ],
      });
      expect(codes(report.errors)).toContain("UNKNOWN_SEGMENT_KIND");
      expect(codes(report.errors)).toContain("SEGMENT_TEXT_REQUIRED");
    });
  });

  describe("interaction segments", () => {
    it("requires an interactionType on an interaction segment", () => {
      const report = lintEpisode(identity, {
        ...valid(),
        segments: [
          narration(0, "a"),
          { order: 1, kind: "interaction", text: "你想去哪？" },
        ],
      });
      expect(codes(report.errors)).toContain("INTERACTION_TYPE_REQUIRED");
    });

    it("rejects an interactionType outside the whitelist", () => {
      const report = lintEpisode(identity, {
        ...valid(),
        segments: [
          narration(0, "a"),
          {
            order: 1,
            kind: "interaction",
            text: "你想去哪？",
            interactionType: "multiple_choice" as never,
          },
        ],
      });
      expect(codes(report.errors)).toContain("UNKNOWN_INTERACTION_TYPE");
    });

    it("warns when a narration carries an interactionType the engine ignores", () => {
      const report = lintEpisode(identity, {
        ...valid(),
        segments: [
          narration(0, "a", { interactionType: "open_question" }),
          narration(1, "b"),
        ],
      });
      expect(codes(report.warnings)).toContain(
        "NARRATION_WITH_INTERACTION_TYPE",
      );
    });

    it("requires fallback and exit text on every reply-waiting interaction", () => {
      const report = lintEpisode(identity, {
        ...valid(),
        segments: [
          narration(0, "a"),
          twoChoice(1, { fallbackText: null, exitText: "" }),
          narration(2, "b"),
        ],
      });
      expect(codes(report.errors)).toContain("FALLBACK_TEXT_REQUIRED");
      expect(codes(report.errors)).toContain("EXIT_TEXT_REQUIRED");
    });

    it("does not demand fallback text from a reward segment that never waits", () => {
      const report = lintEpisode(identity, {
        ...valid(),
        segments: [
          narration(0, "a"),
          {
            order: 1,
            kind: "interaction",
            text: "你做到了！",
            interactionType: "reward",
            rewardStar: true,
          },
          narration(2, "b"),
        ],
      });
      expect(codes(report.errors)).not.toContain("FALLBACK_TEXT_REQUIRED");
      expect(codes(report.errors)).not.toContain("EXIT_TEXT_REQUIRED");
    });

    it("warns about a reward segment that awards no star", () => {
      const report = lintEpisode(identity, {
        ...valid(),
        segments: [
          narration(0, "a"),
          {
            order: 1,
            kind: "interaction",
            text: "你做到了！",
            interactionType: "reward",
            rewardStar: false,
          },
          narration(2, "b"),
        ],
      });
      expect(codes(report.warnings)).toContain("REWARD_WITHOUT_STAR");
    });
  });

  describe("two_choice options", () => {
    const withChoices = (choices: unknown) => ({
      ...valid(),
      segments: [
        narration(0, "a"),
        twoChoice(1, { options: choices as never }),
        narration(2, "b"),
      ],
    });

    it("requires at least two choices", () => {
      expect(
        codes(lintEpisode(identity, withChoices({ choices: [] })).errors),
      ).toContain("CHOICES_REQUIRED");
      expect(
        codes(
          lintEpisode(
            identity,
            withChoices({
              choices: [{ key: "forest", text: "森林", reply: "好" }],
            }),
          ).errors,
        ),
      ).toContain("CHOICES_REQUIRED");
      expect(codes(lintEpisode(identity, withChoices(null)).errors)).toContain(
        "CHOICES_REQUIRED",
      );
    });

    it("requires key, text and reply on every choice", () => {
      const report = lintEpisode(
        identity,
        withChoices({
          choices: [
            { key: "forest", text: "森林", reply: "" },
            { key: "river", text: "", reply: "走" },
          ],
        }),
      );
      expect(codes(report.errors)).toContain("CHOICE_REPLY_REQUIRED");
      expect(codes(report.errors)).toContain("CHOICE_TEXT_INVALID");
    });

    it("rejects a one-character key because ASR matching uses substring includes", () => {
      const report = lintEpisode(
        identity,
        withChoices({
          choices: [
            { key: "a", text: "森林", reply: "好" },
            { key: "river", text: "河边", reply: "走" },
          ],
        }),
      );
      expect(codes(report.errors)).toContain("CHOICE_KEY_INVALID");
    });

    it("rejects a key containing whitespace because ASR never emits it", () => {
      const report = lintEpisode(
        identity,
        withChoices({
          choices: [
            { key: "go forest", text: "森林", reply: "好" },
            { key: "river", text: "河边", reply: "走" },
          ],
        }),
      );
      expect(codes(report.errors)).toContain("CHOICE_KEY_INVALID");
    });

    it("rejects a one-character choice text for the same substring reason", () => {
      const report = lintEpisode(
        identity,
        withChoices({
          choices: [
            { key: "forest", text: "林", reply: "好" },
            { key: "river", text: "河边", reply: "走" },
          ],
        }),
      );
      expect(codes(report.errors)).toContain("CHOICE_TEXT_INVALID");
    });

    it("rejects duplicated keys or texts", () => {
      const dupKey = lintEpisode(
        identity,
        withChoices({
          choices: [
            { key: "forest", text: "森林", reply: "好" },
            { key: "forest", text: "河边", reply: "走" },
          ],
        }),
      );
      expect(codes(dupKey.errors)).toContain("CHOICE_KEY_DUPLICATE");

      const dupText = lintEpisode(
        identity,
        withChoices({
          choices: [
            { key: "forest", text: "森林", reply: "好" },
            { key: "river", text: "森林", reply: "走" },
          ],
        }),
      );
      expect(codes(dupText.errors)).toContain("CHOICE_TEXT_DUPLICATE");
    });

    it("rejects a choice text that is a substring of another because find() would silently take the wrong branch", () => {
      const report = lintEpisode(
        identity,
        withChoices({
          choices: [
            { key: "forest", text: "森林", reply: "好" },
            { key: "river", text: "森林里的小河", reply: "走" },
          ],
        }),
      );
      expect(codes(report.errors)).toContain("CHOICE_TEXT_SUBSTRING");
    });

    it("attaches the offending segment order to the issue", () => {
      const report = lintEpisode(identity, withChoices(null));
      const issue = report.errors.find((i) => i.code === "CHOICES_REQUIRED");
      expect(issue?.segmentOrder).toBe(1);
    });
  });

  describe("repeat_after_me options", () => {
    const withPraise = (options: unknown) => ({
      ...valid(),
      segments: [
        narration(0, "a"),
        {
          order: 1,
          kind: "interaction" as const,
          text: "跟我念：wind",
          interactionType: "repeat_after_me" as const,
          options: options as never,
          fallbackText: "没关系，我们继续。",
          exitText: "好呀，明天接着玩。",
        },
        narration(2, "b"),
      ],
    });

    it("requires a non-empty praise line", () => {
      expect(codes(lintEpisode(identity, withPraise(null)).errors)).toContain(
        "PRAISE_REQUIRED",
      );
      expect(
        codes(lintEpisode(identity, withPraise({ praise: "  " })).errors),
      ).toContain("PRAISE_REQUIRED");
    });

    it("accepts a praise line", () => {
      const report = lintEpisode(
        identity,
        withPraise({ praise: "说得真好，给你鼓掌！" }),
      );
      expect(codes(report.errors)).not.toContain("PRAISE_REQUIRED");
    });
  });

  describe("content quality warnings", () => {
    it("warns when a narration exceeds the spoken-length budget", () => {
      const long = "字".repeat(
        DEFAULT_LINT_THRESHOLDS.maxNarrationTextChars + 1,
      );
      const report = lintEpisode(identity, {
        ...valid(),
        segments: [narration(0, long), narration(1, "短")],
      });
      expect(codes(report.warnings)).toContain("NARRATION_TEXT_LONG");
      expect(report.errors).toEqual([]);
    });

    it("warns when an interaction prompt exceeds the budget", () => {
      const long = "字".repeat(
        DEFAULT_LINT_THRESHOLDS.maxInteractionTextChars + 1,
      );
      const report = lintEpisode(identity, {
        ...valid(),
        segments: [narration(0, "a"), twoChoice(1, { text: long })],
      });
      expect(codes(report.warnings)).toContain("INTERACTION_TEXT_LONG");
    });

    it("honours overridden thresholds", () => {
      const report = lintEpisode(
        identity,
        {
          ...valid(),
          segments: [narration(0, "一二三四五"), narration(1, "b")],
        },
        {},
        { maxNarrationTextChars: 3 },
      );
      expect(codes(report.warnings)).toContain("NARRATION_TEXT_LONG");
    });

    it("warns when an episode hands out too many stars", () => {
      const segments = [narration(0, "开场")];
      for (
        let i = 1;
        i <= DEFAULT_LINT_THRESHOLDS.maxStarsPerEpisode + 1;
        i++
      ) {
        segments.push(twoChoice(i, { rewardStar: true }));
        segments.push(narration(i + 100, `过场${i}`));
      }
      const ordered = segments.map((segment, index) => ({
        ...segment,
        order: index,
      }));
      const report = lintEpisode(identity, { ...valid(), segments: ordered });
      expect(codes(report.warnings)).toContain("TOO_MANY_STARS");
      expect(report.errors).toEqual([]);
    });

    it("blocks a forbidden word rather than merely warning", () => {
      const report = lintEpisode(
        identity,
        { ...valid(), segments: [narration(0, "这里有把刀子。")] },
        {},
        { forbiddenWords: ["刀子"] },
      );
      expect(codes(report.errors)).toContain("FORBIDDEN_WORD");
      expect(report.ok).toBe(false);
    });

    it("warns when the episode opens with a question and no context", () => {
      const report = lintEpisode(identity, {
        ...valid(),
        segments: [twoChoice(0), narration(1, "b")],
      });
      expect(codes(report.warnings)).toContain("FIRST_SEGMENT_INTERACTION");
    });

    it("warns when the last segment leaves the child waiting for a reply", () => {
      const report = lintEpisode(identity, {
        ...valid(),
        segments: [narration(0, "a"), twoChoice(1)],
      });
      expect(codes(report.warnings)).toContain("EPISODE_ENDS_AWAITING_REPLY");
    });

    it("warns about an over-long title", () => {
      const report = lintEpisode(identity, {
        ...valid(),
        title: "题".repeat(DEFAULT_LINT_THRESHOLDS.maxTitleChars + 1),
      });
      expect(codes(report.warnings)).toContain("TITLE_TOO_LONG");
    });
  });

  it("emits a human-readable Chinese message with the business key for every issue", () => {
    const report = lintEpisode({ ...identity, season: 2 }, valid());
    const issue = report.errors[0];
    expect(issue.message.length).toBeGreaterThan(0);
    expect(issue.businessKey).toBe("elly/2/1");
    expect(issue.severity).toBe("error");
  });
});
