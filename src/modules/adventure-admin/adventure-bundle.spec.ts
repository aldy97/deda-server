import {
  AdventureBundle,
  BUNDLE_SCHEMA_VERSION,
  bundleContentHash,
  buildBundle,
  canonicalJson,
  diffEpisodes,
  episodeContentHash,
  parseBundle,
  planBundleImport,
  toBundleEpisode,
  toDraftEpisode,
} from "./adventure-bundle";
import {
  EpisodeContentDraft,
  EpisodeIdentity,
  EpisodeSegmentDraft,
} from "./adventure-content.types";

/**
 * staging → prod 搬运的安全边界。
 * 核心不变量：同样的内容在任何环境算出同样的 hash（否则 already_up_to_date 永远判不出来），
 * 且 bundle 里绝不携带 UUID / 时间戳 / 发布态（否则会把 staging 的行身份和发布状态带进 prod）。
 */
describe("adventure-bundle", () => {
  const identity: EpisodeIdentity = {
    characterKey: "elly",
    season: 1,
    episodeNumber: 1,
  };

  const content = (
    overrides: Partial<EpisodeContentDraft> = {},
  ): EpisodeContentDraft => ({
    title: "听风原野第一天",
    recap: "上次 Elly 找到了风铃。",
    segments: [
      { order: 0, kind: "narration", text: "今天 Elly 要出门啦。" },
      {
        order: 1,
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
        rewardStar: true,
      },
      { order: 2, kind: "narration", text: "森林里有只小松鼠。" },
    ],
    ...overrides,
  });

  describe("canonicalJson", () => {
    it("sorts object keys recursively so key order never changes the output", () => {
      expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe(
        canonicalJson({ a: { c: 3, d: 4 }, b: 1 }),
      );
      expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    it("keeps array order significant", () => {
      expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    });

    it("drops undefined but keeps null", () => {
      expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    });

    it("serializes nested arrays of objects deterministically", () => {
      const a = [
        { y: 1, x: 2 },
        { x: 3, y: 4 },
      ];
      const b = [
        { x: 2, y: 1 },
        { y: 4, x: 3 },
      ];
      expect(canonicalJson(a)).toBe(canonicalJson(b));
    });

    it("serializes a Date as its ISO string so hashes are stable across processes", () => {
      const date = new Date("2026-01-02T03:04:05.000Z");
      expect(canonicalJson(date)).toBe('"2026-01-02T03:04:05.000Z"');
      expect(canonicalJson({ at: date })).toBe('{"at":"2026-01-02T03:04:05.000Z"}');
    });
  });

  describe("content hashing", () => {
    it("is stable for semantically identical episodes with different key order", () => {
      const a = toBundleEpisode(identity, content());
      const b = toBundleEpisode(identity, content());
      expect(episodeContentHash(a)).toBe(episodeContentHash(b));
      expect(episodeContentHash(a)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("changes when a segment text changes", () => {
      const before = toBundleEpisode(identity, content());
      const after = toBundleEpisode(
        identity,
        content({
          segments: content().segments.map((segment) =>
            segment.order === 0
              ? { ...segment, text: "改过的旁白。" }
              : segment,
          ),
        }),
      );
      expect(episodeContentHash(before)).not.toBe(episodeContentHash(after));
    });

    it("changes when the episode number changes but not when only defaults are re-filled", () => {
      const base = toBundleEpisode(identity, content());
      const otherNumber = toBundleEpisode(
        { ...identity, episodeNumber: 2 },
        content(),
      );
      expect(episodeContentHash(base)).not.toBe(
        episodeContentHash(otherNumber),
      );

      const sparse = toBundleEpisode(identity, {
        ...content(),
        segments: content().segments.map((segment) =>
          segment.kind === "narration"
            ? ({
                order: segment.order,
                kind: segment.kind,
                text: segment.text,
              } as never)
            : segment,
        ),
      });
      expect(episodeContentHash(base)).toBe(episodeContentHash(sparse));
    });

    it("ignores exportedAt and sourceProfile so the same content hashes the same across environments", () => {
      const bundle = buildBundle([{ identity, content: content() }], {
        sourceProfile: "authoring",
      });
      const prodSide: AdventureBundle = {
        ...bundle,
        exportedAt: "2030-01-01T00:00:00.000Z",
        sourceProfile: "readonly",
      };
      expect(bundleContentHash(bundle)).toBe(bundleContentHash(prodSide));
    });

    it("changes when any episode in the bundle changes", () => {
      const a = buildBundle([{ identity, content: content() }], {
        sourceProfile: "authoring",
      });
      const b = buildBundle(
        [{ identity, content: content({ title: "换了标题" }) }],
        { sourceProfile: "authoring" },
      );
      expect(bundleContentHash(a)).not.toBe(bundleContentHash(b));
    });
  });

  describe("toBundleEpisode", () => {
    it("strips ids, timestamps and publish state coming from a database row", () => {
      const rowLike = {
        ...content(),
        id: "ep-uuid-should-not-travel",
        episodeId: "nope",
        currentVersionId: "v-uuid",
        published: true,
        retiredAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        segments: content().segments.map((segment) => ({
          ...segment,
          id: `s-${segment.order}`,
          episodeId: "ep-uuid-should-not-travel",
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      };
      const episode = toBundleEpisode(identity, rowLike as never);
      const serialized = JSON.stringify(episode);
      expect(serialized).not.toContain("ep-uuid-should-not-travel");
      expect(serialized).not.toContain("currentVersionId");
      expect(serialized).not.toContain("published");
      expect(serialized).not.toContain("retiredAt");
      expect(serialized).not.toContain("createdAt");
      expect(serialized).not.toContain("updatedAt");
    });

    it("normalizes optional fields to explicit nulls and false", () => {
      const episode = toBundleEpisode(identity, {
        title: "t",
        segments: [{ order: 0, kind: "narration", text: "a" }],
      });
      expect(episode.recap).toBeNull();
      expect(episode.segments[0]).toEqual({
        order: 0,
        kind: "narration",
        text: "a",
        interactionType: null,
        options: null,
        fallbackText: null,
        rewardStar: false,
      });
    });

    // 历史内容里还带着逐段退出话术（旧版本快照、旧 bundle 都是这个形状），但它
    // 已经收归全局常量：既不进形状，也不进指纹。否则同一集只因为删掉一句再也没人
    // 会念的话术，就会被跨环境导入判成「内容变了」，白制造一次全量 replace。
    it("drops a legacy per-segment exitText from both the shape and the hash", () => {
      const withLegacyExitText = {
        ...content(),
        segments: content().segments.map((segment) =>
          segment.order === 1
            ? { ...segment, exitText: "好呀，那我们明天接着玩。" }
            : segment,
        ),
      } as unknown as EpisodeContentDraft;

      const episode = toBundleEpisode(identity, withLegacyExitText);

      expect(episode.segments[1]).not.toHaveProperty("exitText");
      expect(episodeContentHash(episode)).toBe(
        episodeContentHash(toBundleEpisode(identity, content())),
      );
    });

    it("sorts segments by order so the array order never affects the hash", () => {
      const shuffled = toBundleEpisode(identity, {
        ...content(),
        segments: [
          content().segments[2],
          content().segments[0],
          content().segments[1],
        ],
      });
      expect(shuffled.segments.map((s) => s.order)).toEqual([0, 1, 2]);
      expect(episodeContentHash(shuffled)).toBe(
        episodeContentHash(toBundleEpisode(identity, content())),
      );
    });

    it("still drops an empty-text segment because a bundle must never carry silence", () => {
      const episode = toBundleEpisode(identity, {
        ...content(),
        segments: [
          { order: 0, kind: "narration", text: "今天 Elly 要出门啦。" },
          { order: 1, kind: "narration", text: "   " },
        ],
      });
      expect(episode.segments).toHaveLength(1);
    });

    it("two_choice 的 choices 不是数组 → options 整体置空，而不是崩", () => {
      const episode = toBundleEpisode(
        identity,
        content({
          segments: [
            {
              order: 0,
              kind: "interaction",
              text: "选一个。",
              interactionType: "two_choice",
              options: { choices: "不是数组" },
            } as unknown as EpisodeSegmentDraft,
          ],
        }),
      );
      expect(episode.segments[0].options).toBeNull();
    });

    it("two_choice 的 choices 里 null 元素被过滤，合法项原样保留", () => {
      const episode = toBundleEpisode(
        identity,
        content({
          segments: [
            {
              order: 0,
              kind: "interaction",
              text: "选一个。",
              interactionType: "two_choice",
              options: {
                choices: [null, { key: "a", text: "甲", reply: "好呀" }],
              },
            } as unknown as EpisodeSegmentDraft,
          ],
        }),
      );
      expect(episode.segments[0].options).toEqual({
        choices: [{ key: "a", text: "甲", reply: "好呀" }],
      });
    });

    it("repeat_after_me：有 praise 保留为 {praise}，空白 praise 整体置空", () => {
      const withPraise = toBundleEpisode(
        identity,
        content({
          segments: [
            {
              order: 0,
              kind: "interaction",
              text: "跟我念。",
              interactionType: "repeat_after_me",
              options: { praise: "真棒！" },
            } as unknown as EpisodeSegmentDraft,
          ],
        }),
      );
      expect(withPraise.segments[0].options).toEqual({ praise: "真棒！" });

      const blankPraise = toBundleEpisode(
        identity,
        content({
          segments: [
            {
              order: 0,
              kind: "interaction",
              text: "跟我念。",
              interactionType: "repeat_after_me",
              options: { praise: "   " },
            } as unknown as EpisodeSegmentDraft,
          ],
        }),
      );
      expect(blankPraise.segments[0].options).toBeNull();
    });

    it("segments 不是数组或含非对象元素 → 按空处理，不崩", () => {
      const noArray = toBundleEpisode(identity, content({ segments: undefined }));
      expect(noArray.segments).toEqual([]);

      const withNull = toBundleEpisode(
        identity,
        content({
          segments: [
            null as unknown as EpisodeSegmentDraft,
            { order: 0, kind: "narration", text: "保留下来的。" },
          ],
        }),
      );
      expect(withNull.segments).toHaveLength(1);
      expect(withNull.segments[0].text).toBe("保留下来的。");
    });

    it("interaction 段的 options 不是对象，或类型不需要选项 → 归一化成 null", () => {
      const badOptions = toBundleEpisode(
        identity,
        content({
          segments: [
            {
              order: 0,
              kind: "interaction",
              text: "选一个。",
              interactionType: "two_choice",
              options: "不是对象",
            } as unknown as EpisodeSegmentDraft,
          ],
        }),
      );
      expect(badOptions.segments[0].options).toBeNull();

      const openQuestion = toBundleEpisode(
        identity,
        content({
          segments: [
            {
              order: 0,
              kind: "interaction",
              text: "你想去哪？",
              interactionType: "open_question",
              options: {
                choices: [{ key: "a", text: "甲", reply: "好呀" }],
              },
            } as unknown as EpisodeSegmentDraft,
          ],
        }),
      );
      expect(openQuestion.segments[0].options).toBeNull();
    });
  });

  /**
   * 草稿是可变行，作者需要能把「写到一半」的稿子停下来：新加了一段还没来得及写字，
   * 不该因此存不进库——存不进去等于浏览器一关整集内容全丢。
   * 但 bundle 是跨环境运输件，必须继续严格。所以拆成两个规范化函数，
   * 而不是给 toBundleEpisode 加开关：开关迟早会被误用到导出链路上。
   */
  describe("toDraftEpisode", () => {
    it("keeps a segment whose text is still empty so work in progress can be parked", () => {
      const draft = toDraftEpisode(identity, {
        ...content(),
        segments: [
          { order: 0, kind: "narration", text: "今天 Elly 要出门啦。" },
          { order: 1, kind: "narration", text: "" },
        ],
      });
      expect(draft.segments).toHaveLength(2);
      expect(draft.segments[1]).toMatchObject({ order: 1, text: "" });
    });

    it("still drops structurally malformed segments: those are garbage, not work in progress", () => {
      const draft = toDraftEpisode(identity, {
        ...content(),
        segments: [
          { order: 0, kind: "narration", text: "开场" },
          { order: 1, kind: "banana" as never, text: "类型非法" },
          { order: 1.5, kind: "narration", text: "段号非法" },
        ],
      });
      expect(draft.segments).toHaveLength(1);
    });

    it("strips database row identity exactly like the bundle normalizer does", () => {
      const draft = toDraftEpisode(identity, {
        ...content(),
        segments: content().segments.map((segment) => ({
          ...segment,
          id: `s-${segment.order}`,
          episodeId: "ep-uuid-should-not-travel",
        })),
      } as never);
      expect(JSON.stringify(draft)).not.toContain("ep-uuid-should-not-travel");
    });
  });

  describe("buildBundle", () => {
    it("orders episodes deterministically by character, season and number", () => {
      const bundle = buildBundle(
        [
          {
            identity: { characterKey: "polly", season: 1, episodeNumber: 2 },
            content: content(),
          },
          { identity, content: content() },
          {
            identity: { characterKey: "polly", season: 1, episodeNumber: 1 },
            content: content(),
          },
        ],
        { sourceProfile: "authoring" },
      );
      expect(
        bundle.episodes.map(
          (episode) =>
            `${episode.characterKey}/${episode.season}/${episode.episodeNumber}`,
        ),
      ).toEqual(["elly/1/1", "polly/1/1", "polly/1/2"]);
      expect(bundle.bundleSchemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
      expect(bundle.sourceProfile).toBe("authoring");
      expect(typeof bundle.exportedAt).toBe("string");
    });
  });

  describe("parseBundle", () => {
    const roundTrip = (bundle: AdventureBundle) =>
      parseBundle(JSON.parse(JSON.stringify(bundle)));

    it("round-trips a freshly built bundle with an identical content hash", () => {
      const bundle = buildBundle([{ identity, content: content() }], {
        sourceProfile: "authoring",
      });
      const parsed = roundTrip(bundle);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }
      expect(bundleContentHash(parsed.bundle)).toBe(bundleContentHash(bundle));
    });

    it("rejects a bundle from a newer schema version instead of guessing", () => {
      const bundle = buildBundle([{ identity, content: content() }], {
        sourceProfile: "authoring",
      });
      const parsed = parseBundle({
        ...bundle,
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION + 1,
      });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) {
        return;
      }
      expect(parsed.errors.join(" ")).toContain("bundleSchemaVersion");
    });

    // 版本号提升是「形状变了」的告示，不是拒绝旧文件的理由：早先从 staging 导出的
    // v1 bundle 里还带着 exitText，必须仍能导入（只出 warning、字段被白名单丢弃），
    // 否则一次字段下线会让所有历史导出文件变成废纸。
    it("still imports an older v1 bundle and drops its exitText with a warning", () => {
      const bundle = buildBundle([{ identity, content: content() }], {
        sourceProfile: "authoring",
      });
      const legacyRaw = JSON.parse(JSON.stringify(bundle)) as Record<
        string,
        unknown
      >;
      legacyRaw.bundleSchemaVersion = 1;
      const episodes = legacyRaw.episodes as Array<{
        segments: Array<Record<string, unknown>>;
      }>;
      episodes[0].segments[1].exitText = "好呀，那我们明天接着玩。";

      const parsed = parseBundle(legacyRaw);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }
      expect(parsed.warnings.join(" ")).toContain("bundleSchemaVersion");
      expect(parsed.bundle.episodes[0].segments[1]).not.toHaveProperty(
        "exitText",
      );
      // 丢掉那句没人会念的话术之后，指纹与新导出的 bundle 完全一致
      expect(bundleContentHash(parsed.bundle)).toBe(bundleContentHash(bundle));
    });

    it("rejects malformed input with actionable messages", () => {
      for (const bad of [null, "nope", 42, [], { bundleSchemaVersion: 1 }]) {
        const parsed = parseBundle(bad);
        expect(parsed.ok).toBe(false);
      }
      const parsed = parseBundle({
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        episodes: [],
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors.join(" ")).toContain("episodes");
      }
    });

    it("rejects an episode without a usable identity", () => {
      const bundle = buildBundle([{ identity, content: content() }], {
        sourceProfile: "authoring",
      });
      const broken = JSON.parse(JSON.stringify(bundle));
      delete broken.episodes[0].episodeNumber;
      const parsed = parseBundle(broken);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors.join(" ")).toContain("episodeNumber");
      }
    });

    it("drops unknown fields so a hand-edited bundle cannot smuggle row ids or publish state", () => {
      const bundle = buildBundle([{ identity, content: content() }], {
        sourceProfile: "authoring",
      });
      const tampered = JSON.parse(JSON.stringify(bundle));
      tampered.episodes[0].id = "smuggled-uuid";
      tampered.episodes[0].published = true;
      tampered.episodes[0].segments[0].episodeId = "smuggled-uuid";
      tampered.episodes[0].__proto__ = { polluted: true };

      const parsed = parseBundle(tampered);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }
      const serialized = JSON.stringify(parsed.bundle.episodes[0]);
      expect(serialized).not.toContain("smuggled-uuid");
      expect(parsed.bundle.episodes[0]).not.toHaveProperty("published");
      expect(parsed.bundle.episodes[0].segments[0]).not.toHaveProperty(
        "episodeId",
      );
      expect({} as Record<string, unknown>).not.toHaveProperty("polluted");
    });

    it("normalizes segments and drops malformed ones rather than failing the whole bundle", () => {
      const bundle = buildBundle([{ identity, content: content() }], {
        sourceProfile: "authoring",
      });
      const edited = JSON.parse(JSON.stringify(bundle));
      edited.episodes[0].segments.push({ order: 3, kind: "narration" });
      edited.episodes[0].segments.push("not-an-object");

      const parsed = parseBundle(edited);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }
      expect(parsed.bundle.episodes[0].segments).toHaveLength(3);
    });

    it.each([
      {
        label: "bundleSchemaVersion 是字符串",
        mutate: (b: Record<string, unknown>) => {
          b.bundleSchemaVersion = "1";
        },
        fragment: "bundleSchemaVersion 缺失或不是整数",
      },
      {
        label: "bundleSchemaVersion 是小数",
        mutate: (b: Record<string, unknown>) => {
          b.bundleSchemaVersion = 1.5;
        },
        fragment: "bundleSchemaVersion 缺失或不是整数",
      },
      {
        label: "episodes[0] 不是对象",
        mutate: (b: Record<string, unknown>) => {
          (b.episodes as unknown[])[0] = "不是对象";
        },
        fragment: "episodes[0] 不是对象",
      },
      {
        label: "characterKey 不在白名单",
        mutate: (b: Record<string, unknown>) => {
          (b.episodes as Array<Record<string, unknown>>)[0].characterKey =
            "momo";
        },
        fragment: "不在白名单内",
      },
      {
        label: "season 是 0",
        mutate: (b: Record<string, unknown>) => {
          (b.episodes as Array<Record<string, unknown>>)[0].season = 0;
        },
        fragment: "不是不小于 1 的整数",
      },
      {
        label: "title 是空白串",
        mutate: (b: Record<string, unknown>) => {
          (b.episodes as Array<Record<string, unknown>>)[0].title = "   ";
        },
        fragment: "title 不能为空",
      },
      {
        label: "segments 不是数组",
        mutate: (b: Record<string, unknown>) => {
          (b.episodes as Array<Record<string, unknown>>)[0].segments =
            "不是数组";
        },
        fragment: "segments 缺失或不是数组",
      },
    ])("$label → ok=false 且报错含「$fragment」", ({ mutate, fragment }) => {
      const bundle = buildBundle([{ identity, content: content() }], {
        sourceProfile: "authoring",
      });
      const tampered = JSON.parse(JSON.stringify(bundle)) as Record<
        string,
        unknown
      >;
      mutate(tampered);

      const parsed = parseBundle(tampered);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors.join(" ")).toContain(fragment);
      }
    });

    it("hand-made bundle 缺 exportedAt / sourceProfile → 落 now 与 unknown", () => {
      const parsed = parseBundle({
        bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
        episodes: [
          JSON.parse(JSON.stringify(toBundleEpisode(identity, content()))),
        ],
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        return;
      }
      expect(parsed.bundle.sourceProfile).toBe("unknown");
      expect(parsed.bundle.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("diffEpisodes", () => {
    const episode = toBundleEpisode(identity, content());

    it("reports an added episode when there is no target", () => {
      const diff = diffEpisodes(null, episode);
      expect(diff.change).toBe("added");
      expect(diff.businessKey).toBe("elly/1/1");
      expect(diff.segmentDiffs.every((d) => d.change === "added")).toBe(true);
    });

    it("reports identical content with no segment diffs", () => {
      const diff = diffEpisodes(episode, toBundleEpisode(identity, content()));
      expect(diff.change).toBe("identical");
      expect(diff.segmentDiffs).toEqual([]);
      expect(diff.titleChanged).toBe(false);
      expect(diff.recapChanged).toBe(false);
    });

    it("reports a modified field with before and after values", () => {
      const after = toBundleEpisode(
        identity,
        content({
          segments: content().segments.map((segment) =>
            segment.order === 0
              ? { ...segment, text: "改过的旁白。" }
              : segment,
          ),
        }),
      );
      const diff = diffEpisodes(episode, after);
      expect(diff.change).toBe("replaced");
      expect(diff.segmentDiffs).toContainEqual(
        expect.objectContaining({
          order: 0,
          change: "modified",
          field: "text",
          before: "今天 Elly 要出门啦。",
          after: "改过的旁白。",
        }),
      );
    });

    it("reports added and removed segments separately", () => {
      const shorter = toBundleEpisode(
        identity,
        content({ segments: content().segments.slice(0, 2) }),
      );
      expect(diffEpisodes(episode, shorter).segmentDiffs).toContainEqual(
        expect.objectContaining({ order: 2, change: "removed" }),
      );
      expect(diffEpisodes(shorter, episode).segmentDiffs).toContainEqual(
        expect.objectContaining({ order: 2, change: "added" }),
      );
    });

    it("sorts segment diffs by order even when the incoming array is shuffled", () => {
      const base = content();
      const shuffled = toBundleEpisode(
        identity,
        content({
          segments: [
            { ...base.segments[2], text: "改过的结尾。" },
            { ...base.segments[0], text: "改过的开场。" },
          ],
        }),
      );
      const orders = diffEpisodes(episode, shuffled).segmentDiffs.map(
        (diff) => diff.order,
      );
      expect(orders.length).toBeGreaterThan(1);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
    });

    it("reports title and recap changes", () => {
      const diff = diffEpisodes(
        episode,
        toBundleEpisode(identity, content({ title: "新标题", recap: null })),
      );
      expect(diff.titleChanged).toBe(true);
      expect(diff.recapChanged).toBe(true);
      expect(diff.change).toBe("replaced");
    });

    it("reports interaction option changes as a modified options field", () => {
      const after = toBundleEpisode(
        identity,
        content({
          segments: content().segments.map((segment) =>
            segment.order === 1
              ? {
                  ...segment,
                  options: {
                    choices: [
                      { key: "forest", text: "森林", reply: "改过的接话。" },
                      { key: "river", text: "河边", reply: "走，我们去河边！" },
                    ],
                  },
                }
              : segment,
          ),
        }),
      );
      const diff = diffEpisodes(episode, after);
      expect(diff.segmentDiffs).toContainEqual(
        expect.objectContaining({
          order: 1,
          change: "modified",
          field: "options",
        }),
      );
    });
  });

  describe("planBundleImport", () => {
    const bundle = () =>
      buildBundle([{ identity, content: content() }], {
        sourceProfile: "authoring",
      });

    it("plans an add when the business key does not exist yet", () => {
      const plan = planBundleImport(bundle(), []);
      expect(plan.ok).toBe(true);
      expect(plan.adds).toBe(1);
      expect(plan.items[0].action).toBe("add");
      expect(plan.items[0].businessKey).toBe("elly/1/1");
    });

    it("plans already_up_to_date when the incoming hash matches the published one", () => {
      const episode = toBundleEpisode(identity, content());
      const plan = planBundleImport(bundle(), [
        {
          id: "ep1",
          characterKey: "elly",
          season: 1,
          episodeNumber: 1,
          published: true,
          retiredAt: null,
          currentContentHash: episodeContentHash(episode),
        },
      ]);
      expect(plan.items[0].action).toBe("already_up_to_date");
      expect(plan.upToDate).toBe(1);
      expect(plan.replaces).toBe(0);
    });

    it("plans a replace with a segment-level diff when the content differs", () => {
      const plan = planBundleImport(bundle(), [
        {
          id: "ep1",
          characterKey: "elly",
          season: 1,
          episodeNumber: 1,
          published: true,
          retiredAt: null,
          currentContentHash: "deadbeef",
        },
      ]);
      expect(plan.items[0].action).toBe("replace");
      expect(plan.replaces).toBe(1);
      expect(plan.items[0].episodeId).toBe("ep1");
      expect(plan.items[0].diff?.segmentDiffs.length).toBeGreaterThan(0);
    });

    it("refuses to import over a retired episode and tells the admin to restore first", () => {
      const plan = planBundleImport(bundle(), [
        {
          id: "ep1",
          characterKey: "elly",
          season: 1,
          episodeNumber: 1,
          published: true,
          retiredAt: new Date(),
          currentContentHash: "deadbeef",
        },
      ]);
      expect(plan.ok).toBe(false);
      expect(plan.items[0].action).toBe("reject");
      expect(plan.items[0].reason).toContain("retire");
      expect(plan.rejects).toBe(1);
    });

    it("renders a non-Date retiredAt as its string form in the reject reason", () => {
      const plan = planBundleImport(bundle(), [
        {
          id: "ep1",
          characterKey: "elly",
          season: 1,
          episodeNumber: 1,
          published: true,
          retiredAt: "2026-05-01T00:00:00Z",
          currentContentHash: null,
        },
      ]);
      expect(plan.items[0].action).toBe("reject");
      expect(plan.items[0].reason).toContain("2026-05-01T00:00:00Z");
    });

    it("rejects a bundle that lists the same business key twice", () => {
      const duplicated = buildBundle(
        [
          { identity, content: content() },
          { identity, content: content({ title: "重复的一集" }) },
        ],
        { sourceProfile: "authoring" },
      );
      const plan = planBundleImport(duplicated, []);
      expect(plan.ok).toBe(false);
      expect(plan.rejects).toBe(2);
      expect(plan.items.every((item) => item.action === "reject")).toBe(true);
    });

    it("keeps planning the rest when one episode is rejected", () => {
      const mixed = buildBundle(
        [
          { identity, content: content() },
          {
            identity: { characterKey: "polly", season: 1, episodeNumber: 1 },
            content: content(),
          },
        ],
        { sourceProfile: "authoring" },
      );
      const plan = planBundleImport(mixed, [
        {
          id: "ep-retired",
          characterKey: "polly",
          season: 1,
          episodeNumber: 1,
          published: true,
          retiredAt: new Date(),
          currentContentHash: null,
        },
      ]);
      expect(plan.ok).toBe(false);
      expect(plan.adds).toBe(1);
      expect(plan.rejects).toBe(1);
    });

    it("reports the incoming hash so the audit trail can be reconciled later", () => {
      const plan = planBundleImport(bundle(), []);
      expect(plan.items[0].incomingHash).toMatch(/^[0-9a-f]{64}$/);
      expect(plan.bundleHash).toBe(bundleContentHash(bundle()));
    });
  });
});
