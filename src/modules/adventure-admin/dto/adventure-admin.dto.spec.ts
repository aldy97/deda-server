import { plainToInstance } from "class-transformer";
import { validate, ValidationError } from "class-validator";
import { ADVENTURE_SEASON } from "../adventure-content.types";
import {
  AuditListQueryDto,
  ChoiceStatsQueryDto,
  CreateEpisodeDto,
  EpisodeIdentityDto,
  EpisodeListQueryDto,
  ExportDto,
  ImportApplyDto,
  ImportPreviewDto,
  LintDto,
  MutationDto,
  PublishDto,
  RevertDto,
  SaveDraftDto,
  SimulateDto,
  VersionDiffQueryDto,
} from "./adventure-admin.dto";

/**
 * 与 src/main.ts 的全局 ValidationPipe 逐字一致（whitelist + transform +
 * forbidNonWhitelisted）。DTO 是接口的第一道闸，测试必须走同一条管道，
 * 否则测出来的是另一套语义。
 */
async function errorsOf<T extends object>(
  target: new () => T,
  input: Record<string, unknown>,
): Promise<ValidationError[]> {
  return validate(plainToInstance(target, input), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

function instanceOf<T extends object>(
  target: new () => T,
  input: Record<string, unknown>,
): T {
  return plainToInstance(target, input);
}

function props(errors: ValidationError[]): string[] {
  return errors.map((error) => error.property);
}

function childProps(errors: ValidationError[], property: string): string[] {
  const parent = errors.find((error) => error.property === property);
  return (parent?.children ?? []).map((child) => child.property);
}

const draft = {
  title: "第一次冒险",
  segments: [{ order: 0, kind: "narration", text: "我们出发吧。" }],
};

describe('query string 的两个老坑：空串视为未提供，"false" 不能被 Boolean() 变成 true', () => {
  it("?characterKey=&published=&includeRetired=&search= 全空串 → 视为未提供，不 400", async () => {
    await expect(
      errorsOf(EpisodeListQueryDto, {
        characterKey: "",
        published: "",
        includeRetired: "",
        search: "",
      }),
    ).resolves.toHaveLength(0);
  });

  it('published=false 必须解析成 false——Boolean("false") 是 true，会把「只看未发布」翻成「只看已发布」', () => {
    const query = instanceOf(EpisodeListQueryDto, {
      published: "false",
      includeRetired: "true",
    });
    expect(query.published).toBe(false);
    expect(query.includeRetired).toBe(true);
  });

  it.each(["yes", "1", "0", "TRUE", "False"])(
    "published=%p 既不是 true 也不是 false → 400，不替管理员猜意思",
    async (value) => {
      expect(
        props(await errorsOf(EpisodeListQueryDto, { published: value })),
      ).toContain("published");
    },
  );

  it("?search= 空串不参与搜索（否则空串会 contains 匹配到全部标题）", () => {
    expect(
      instanceOf(EpisodeListQueryDto, { search: "" }).search,
    ).toBeUndefined();
  });

  it("非空串原样保留", () => {
    expect(
      instanceOf(EpisodeListQueryDto, { characterKey: "elly", search: "森林" })
        .search,
    ).toBe("森林");
  });
});

describe("EpisodeIdentityDto — 业务键的身份三元组，拼错就等于确认文本失效", () => {
  it("query/body 里的数字是字符串，DTO 负责转成 number", () => {
    const identity = instanceOf(EpisodeIdentityDto, {
      characterKey: "elly",
      season: "2",
      episodeNumber: "3",
    });
    expect(identity.season).toBe(2);
    expect(identity.episodeNumber).toBe(3);
  });

  it("season 省略 → 落到 ADVENTURE_SEASON，业务键不能变成 elly/undefined/3", async () => {
    const identity = instanceOf(EpisodeIdentityDto, {
      characterKey: "elly",
      episodeNumber: "3",
    });
    expect(identity.season).toBe(ADVENTURE_SEASON);
    await expect(
      errorsOf(EpisodeIdentityDto, {
        characterKey: "elly",
        episodeNumber: "3",
      }),
    ).resolves.toHaveLength(0);
  });

  it("episodeNumber=0 合法：lintEpisode 用 0 表示「还没定集号」", async () => {
    await expect(
      errorsOf(EpisodeIdentityDto, {
        characterKey: "polly",
        episodeNumber: "0",
      }),
    ).resolves.toHaveLength(0);
  });

  it.each(["momo", "ELLY", "", "elly "])(
    "characterKey=%p 不在白名单 → 400（大小写敏感，业务键是精确比对）",
    async (characterKey) => {
      expect(
        props(
          await errorsOf(EpisodeIdentityDto, {
            characterKey,
            episodeNumber: "1",
          }),
        ),
      ).toContain("characterKey");
    },
  );

  it.each([["0"], ["100"], ["1.5"], ["abc"], [-1], [100]])(
    "season=%p 越界或不是整数 → 400",
    async (season) => {
      expect(
        props(
          await errorsOf(EpisodeIdentityDto, {
            characterKey: "elly",
            season,
            episodeNumber: "1",
          }),
        ),
      ).toContain("season");
    },
  );

  it.each([["-1"], ["10000"], ["1.5"], ["abc"]])(
    "episodeNumber=%p 越界或不是整数 → 400",
    async (episodeNumber) => {
      expect(
        props(
          await errorsOf(EpisodeIdentityDto, {
            characterKey: "elly",
            episodeNumber,
          }),
        ),
      ).toContain("episodeNumber");
    },
  );
});

describe("EpisodeListQueryDto — 列表过滤与分页", () => {
  const full = {
    characterKey: "elly",
    published: "true",
    includeRetired: "false",
    search: "森林",
    page: "2",
    pageSize: "50",
  };

  it("真实 query string（全字符串）→ 全部转成正确类型且通过", async () => {
    await expect(errorsOf(EpisodeListQueryDto, full)).resolves.toHaveLength(0);
    const query = instanceOf(EpisodeListQueryDto, full);
    expect(query).toMatchObject({
      characterKey: "elly",
      published: true,
      includeRetired: false,
      search: "森林",
      page: 2,
      pageSize: 50,
    });
  });

  it("characterKey 超 32 字 / search 超 50 字 → 400", async () => {
    expect(
      props(
        await errorsOf(EpisodeListQueryDto, { characterKey: "k".repeat(33) }),
      ),
    ).toContain("characterKey");
    expect(
      props(await errorsOf(EpisodeListQueryDto, { search: "s".repeat(51) })),
    ).toContain("search");
  });

  it.each([
    ["page", "0"],
    ["page", "-1"],
    ["page", "1.5"],
    ["pageSize", "0"],
    ["pageSize", "201"],
  ])("%s=%p 越界 → 400", async (key, value) => {
    expect(
      props(await errorsOf(EpisodeListQueryDto, { [key]: value })),
    ).toContain(key);
  });

  it("pageSize=200 是上限本身，放行", async () => {
    await expect(
      errorsOf(EpisodeListQueryDto, { pageSize: "200" }),
    ).resolves.toHaveLength(0);
  });

  it("未知 query 参数 → 400（?publishedd=true 这类拼错必须炸，不能静默失效）", async () => {
    expect(
      props(await errorsOf(EpisodeListQueryDto, { publishedd: "true" })),
    ).toContain("publishedd");
  });
});

describe("VersionDiffQueryDto — 左右两个版本 id 都是必填", () => {
  it("两侧都给 → 通过", async () => {
    await expect(
      errorsOf(VersionDiffQueryDto, { left: "v-1", right: "v-2" }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    ["left 空串", { left: "", right: "v-2" }, "left"],
    ["right 空串", { left: "v-1", right: "" }, "right"],
    ["缺 right", { left: "v-1" }, "right"],
    ["left 超 64 字", { left: "v".repeat(65), right: "v-2" }, "left"],
  ])(
    "%s → 400（空串在这里等于没传，而版本 id 不能缺）",
    async (_l, input, prop) => {
      expect(props(await errorsOf(VersionDiffQueryDto, input))).toContain(prop);
    },
  );
});

describe("AuditListQueryDto — 审计筛选：时间窗 + 分页", () => {
  const full = {
    episodeId: "ep-1",
    actorUsername: "admin",
    action: "publish",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-31T23:59:59.999Z",
    page: "1",
    pageSize: "100",
  };

  it("全部筛选都给 → 通过", async () => {
    await expect(errorsOf(AuditListQueryDto, full)).resolves.toHaveLength(0);
  });

  it("五个字符串筛选全空串 → 视为未提供（清空筛选框不该 400）", async () => {
    await expect(
      errorsOf(AuditListQueryDto, {
        episodeId: "",
        actorUsername: "",
        action: "",
        from: "",
        to: "",
      }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    ["from", "2026-1-1"],
    ["to", "昨天"],
  ])("%s=%p 不是 ISO 日期串 → 400", async (key, value) => {
    expect(
      props(await errorsOf(AuditListQueryDto, { [key]: value })),
    ).toContain(key);
  });

  it.each([
    ["episodeId", "e".repeat(65)],
    ["actorUsername", "u".repeat(65)],
    ["action", "a".repeat(33)],
    ["page", "0"],
    ["pageSize", "201"],
  ])("%s 越界 → 400", async (key, value) => {
    expect(
      props(await errorsOf(AuditListQueryDto, { [key]: value })),
    ).toContain(key);
  });
});

describe("MutationDto — 六个破坏性端点共用的理由 + 确认文本", () => {
  it("空 body 通过：DTO 只收外壳，「理由至少 8 个字」「确认文本要原样输入业务键」由领域层给可执行报错", async () => {
    await expect(errorsOf(MutationDto, {})).resolves.toHaveLength(0);
  });

  it("理由与确认文本齐全 → 通过", async () => {
    await expect(
      errorsOf(MutationDto, {
        reason: "第 3 段兜底话术太生硬",
        confirmText: "elly/1/3",
      }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    ["reason", 123],
    ["confirmText", {}],
  ])("%s 不是字符串 → 400", async (key, value) => {
    expect(props(await errorsOf(MutationDto, { [key]: value }))).toContain(key);
  });
});

describe("CreateEpisodeDto / SimulateDto / LintDto — 身份要转成类实例，内容一律原样透传", () => {
  const identity = {
    characterKey: "elly",
    season: ADVENTURE_SEASON,
    episodeNumber: 3,
  };

  it("identity 传普通对象 → 转成 EpisodeIdentityDto 实例，否则 @ValidateNested 根本不跑", () => {
    const dto = instanceOf(CreateEpisodeDto, { identity, content: draft });
    expect(dto.identity).toBeInstanceOf(EpisodeIdentityDto);
    expect(
      instanceOf(SimulateDto, { identity, content: draft }).identity,
    ).toBeInstanceOf(EpisodeIdentityDto);
    expect(
      instanceOf(LintDto, { identity, content: draft }).identity,
    ).toBeInstanceOf(EpisodeIdentityDto);
  });

  it("identity 里身份非法 → 错误挂在 identity.children 上", async () => {
    const errors = await errorsOf(CreateEpisodeDto, {
      identity: { characterKey: "momo", episodeNumber: 3 },
      content: draft,
    });
    expect(props(errors)).toContain("identity");
    expect(childProps(errors, "identity")).toContain("characterKey");
  });

  it("缺 identity → 400（身份决定业务键，是破坏性操作确认文本的比对目标）", async () => {
    expect(
      props(await errorsOf(CreateEpisodeDto, { content: draft })),
    ).toContain("identity");
    expect(props(await errorsOf(SimulateDto, { content: draft }))).toContain(
      "identity",
    );
  });

  it.each([
    ["字符串", "第 3 段"],
    ["数组", [draft]],
    ["null", null],
  ])("content 是%s → 400", async (_label, content) => {
    expect(
      props(await errorsOf(CreateEpisodeDto, { identity, content })),
    ).toContain("content");
  });

  it('content 形状不对也放行：阈值只存在于 adventure-linter 一处，DTO 再钉一遍就会把「第 3 段的选择题缺少兜底话术」挤成 "content must be an object"', async () => {
    await expect(
      errorsOf(CreateEpisodeDto, {
        identity,
        content: { title: "", segments: "不是数组" },
      }),
    ).resolves.toHaveLength(0);
    await expect(
      errorsOf(SimulateDto, { identity, content: {} }),
    ).resolves.toHaveLength(0);
  });

  it("LintDto 编辑已有集时可省略 identity（服务端用库里的身份）", async () => {
    await expect(
      errorsOf(LintDto, {
        episodeId: "ep-1",
        content: draft,
        forPublish: true,
      }),
    ).resolves.toHaveLength(0);
  });

  it("LintDto.forPublish 非布尔 → 400", async () => {
    expect(
      props(await errorsOf(LintDto, { content: draft, forPublish: "yes" })),
    ).toContain("forPublish");
  });
});

describe("SaveDraftDto — 乐观锁双基线", () => {
  it("content + 两个基线 + force → 通过", async () => {
    await expect(
      errorsOf(SaveDraftDto, {
        content: draft,
        reason: "把第 2 段的提问改短",
        baseVersionId: "v-1",
        baseDraftUpdatedAt: "2026-01-01T00:00:00.000Z",
        force: true,
      }),
    ).resolves.toHaveLength(0);
  });

  it("缺 content → 400", async () => {
    expect(props(await errorsOf(SaveDraftDto, {}))).toContain("content");
  });

  it.each([
    ["baseVersionId", "v".repeat(65)],
    ["baseDraftUpdatedAt", "t".repeat(41)],
    ["force", "true"],
  ])("%s 越界或类型不对 → 400", async (key, value) => {
    expect(
      props(await errorsOf(SaveDraftDto, { content: draft, [key]: value })),
    ).toContain(key);
  });
});

describe("PublishDto / RevertDto", () => {
  it("PublishDto 空 body 通过（理由长度由领域层断言）", async () => {
    await expect(errorsOf(PublishDto, {})).resolves.toHaveLength(0);
  });

  it("RevertDto 三要素齐全 → 通过", async () => {
    await expect(
      errorsOf(RevertDto, {
        targetVersionId: "v-1",
        reason: "新版把兜底话术弄丢了",
        confirmText: "elly/1/3",
      }),
    ).resolves.toHaveLength(0);
  });

  it("RevertDto.targetVersionId 超 64 字 → 400", async () => {
    expect(
      props(await errorsOf(RevertDto, { targetVersionId: "v".repeat(65) })),
    ).toContain("targetVersionId");
  });
});

describe("ExportDto — 要么点名集，要么按 IP 全导", () => {
  it("空 body 通过（不指定就全导）", async () => {
    await expect(errorsOf(ExportDto, {})).resolves.toHaveLength(0);
  });

  it("episodeIds + characterKey + includeRetired → 通过", async () => {
    await expect(
      errorsOf(ExportDto, {
        episodeIds: ["ep-1", "ep-2"],
        characterKey: "elly",
        includeRetired: true,
      }),
    ).resolves.toHaveLength(0);
  });

  it("episodeIds 含非字符串 → 400", async () => {
    expect(
      props(await errorsOf(ExportDto, { episodeIds: ["ep-1", 2] })),
    ).toContain("episodeIds");
  });

  it("episodeIds 501 个 → 400（单次导出上限 500，否则一个请求能把管理台拖死）", async () => {
    expect(
      props(
        await errorsOf(ExportDto, {
          episodeIds: Array.from({ length: 501 }, (_unused, i) => `ep-${i}`),
        }),
      ),
    ).toContain("episodeIds");
  });

  it.each([
    ["characterKey", "k".repeat(33)],
    ["includeRetired", "true"],
  ])("%s 类型不对 → 400", async (key, value) => {
    expect(props(await errorsOf(ExportDto, { [key]: value }))).toContain(key);
  });
});

describe("ImportPreviewDto / ImportApplyDto — bundle 原样透传，哈希防「预览的是 A、提交的是 B」", () => {
  const bundle = {
    bundleSchemaVersion: 1,
    episodes: [{ characterKey: "elly", season: 1, episodeNumber: 3 }],
  };

  it("预览只要 bundle 是对象（解析结果与差异计算归 adventure-bundle）", async () => {
    await expect(errorsOf(ImportPreviewDto, { bundle })).resolves.toHaveLength(
      0,
    );
    await expect(
      errorsOf(ImportPreviewDto, {
        bundle: { bundleSchemaVersion: "不是整数" },
      }),
    ).resolves.toHaveLength(0);
  });

  it.each([
    ["缺失", {}],
    ["非对象", { bundle: "原文" }],
  ])("bundle %s → 400", async (_label, input) => {
    expect(props(await errorsOf(ImportPreviewDto, input))).toContain("bundle");
  });

  it("apply 带理由、确认码与 expectedBundleHash → 通过", async () => {
    await expect(
      errorsOf(ImportApplyDto, {
        bundle,
        reason: "把 staging 的三集搬到 prod",
        confirmText: "token-123",
        expectedBundleHash: "h".repeat(128),
      }),
    ).resolves.toHaveLength(0);
  });

  it("expectedBundleHash 超 128 字 → 400", async () => {
    expect(
      props(
        await errorsOf(ImportApplyDto, {
          bundle,
          expectedBundleHash: "h".repeat(129),
        }),
      ),
    ).toContain("expectedBundleHash");
  });

  it("缺 bundle → 400", async () => {
    expect(props(await errorsOf(ImportApplyDto, {}))).toContain("bundle");
  });
});

describe("ChoiceStatsQueryDto — 日期只挡形状，真实日期合法性归 service", () => {
  it("YYYY-MM-DD → 通过", async () => {
    await expect(
      errorsOf(ChoiceStatsQueryDto, {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      }),
    ).resolves.toHaveLength(0);
  });

  it("空串视为未提供：管理台清空日期筛选不该 400", async () => {
    await expect(
      errorsOf(ChoiceStatsQueryDto, { startDate: "", endDate: "" }),
    ).resolves.toHaveLength(0);
    expect(
      instanceOf(ChoiceStatsQueryDto, { startDate: "" }).startDate,
    ).toBeUndefined();
  });

  it.each(["2026-1-1", "abc", "20260101", "2026/01/01"])(
    "startDate=%p 形状不对 → 400",
    async (startDate) => {
      expect(
        props(await errorsOf(ChoiceStatsQueryDto, { startDate })),
      ).toContain("startDate");
    },
  );

  it("endDate 形状不对 → 400", async () => {
    expect(
      props(await errorsOf(ChoiceStatsQueryDto, { endDate: "2026-1-1" })),
    ).toContain("endDate");
  });

  it("2026-13-45 在 DTO 层放行：月份日期是否真实存在、start<=end 由 choiceStats 的 isValidStatsDate 挡，两处日期规则会打架", async () => {
    await expect(
      errorsOf(ChoiceStatsQueryDto, {
        startDate: "2026-13-45",
        endDate: "2026-99-99",
      }),
    ).resolves.toHaveLength(0);
  });

  it("未知参数 → 400", async () => {
    expect(
      props(await errorsOf(ChoiceStatsQueryDto, { start: "2026-01-01" })),
    ).toContain("start");
  });
});
