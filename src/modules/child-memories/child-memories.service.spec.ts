import { Test, TestingModule } from "@nestjs/testing";
import { ChildMemoriesService } from "./child-memories.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";

type PrismaMock = {
  $transaction: jest.Mock;
  $executeRaw: jest.Mock;
  childMemory: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
};

type LlmMock = {
  complete: jest.Mock;
  smallModelName: string;
};

describe("ChildMemoriesService", () => {
  let service: ChildMemoriesService;
  let prisma: PrismaMock;
  let llm: LlmMock;

  const occurredAt = new Date("2026-10-30T08:00:00Z");
  const redMemory = {
    id: "memory-red",
    deviceId: "device-1",
    key: "favorite_color",
    valueText: "red",
    normalizedValue: "red",
    changeType: "initial",
    status: "active",
    version: 1,
    sourceTurnId: "turn-red",
    sourceOccurredAt: new Date("2026-10-29T08:00:00Z"),
    confidence: 0.95,
    extractorModel: "small-llm",
    validFrom: new Date("2026-10-29T08:00:00Z"),
    validTo: null,
    supersededById: null,
    lastConfirmedAt: new Date("2026-10-29T08:00:00Z"),
    lastInjectedAt: null,
    injectionCount: 0,
  };

  const input = (asrText: string, turnId = "turn-1") => ({
    deviceId: "device-1",
    turnId,
    asrText,
    sourceOccurredAt: occurredAt,
  });

  const extraction = (
    value: string,
    operation = "assert",
    key = "favorite_color",
    evidence = "孩子明确表达",
  ) =>
    JSON.stringify([
      {
        key,
        value,
        operation,
        evidence,
        confidence: 0.95,
      },
    ]);

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChildMemoriesService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: jest.fn(),
            $executeRaw: jest.fn(),
            childMemory: {
              findMany: jest.fn(),
              findFirst: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              updateMany: jest.fn(),
            },
          },
        },
        {
          provide: LlmService,
          useValue: {
            complete: jest.fn(),
            get smallModelName() {
              return "small-llm";
            },
          },
        },
      ],
    }).compile();

    service = module.get(ChildMemoriesService);
    prisma = module.get(PrismaService) as unknown as PrismaMock;
    llm = module.get(LlmService) as unknown as LlmMock;
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.childMemory.findMany.mockResolvedValue([]);
    prisma.childMemory.findFirst.mockResolvedValue(null);
    prisma.childMemory.create.mockImplementation(({ data }) =>
      Promise.resolve(data),
    );
    prisma.childMemory.update.mockImplementation(({ data }) =>
      Promise.resolve(data),
    );
    prisma.childMemory.updateMany.mockResolvedValue({ count: 1 });
    llm.complete.mockResolvedValue({ text: "[]" });
  });

  it("threads the source turnId into the memory_extract LLM call", async () => {
    llm.complete.mockResolvedValue({ text: "[]" });

    await service.extractAndStore(input("今天很开心", "turn-xyz"));

    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({ scene: "memory_extract", turnId: "turn-xyz" }),
    );
  });

  it("should create the first active memory from an explicit preference", async () => {
    llm.complete.mockResolvedValue({
      text: extraction("red", "assert", "favorite_color", "我最喜欢红色"),
    });

    await expect(service.extractAndStore(input("我最喜欢红色"))).resolves.toBe(
      1,
    );

    expect(llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "small-llm",
        temperature: 0,
      }),
    );
    expect(prisma.childMemory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        deviceId: "device-1",
        key: "favorite_color",
        valueText: "red",
        normalizedValue: "red",
        changeType: "initial",
        status: "active",
        version: 1,
        sourceTurnId: "turn-1",
      }),
    });
  });

  it("should preserve red history and create a new active blue version", async () => {
    prisma.childMemory.findMany.mockResolvedValue([redMemory]);
    prisma.childMemory.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(redMemory);
    llm.complete.mockResolvedValue({
      text: extraction(
        "blue",
        "supersede",
        "favorite_color",
        "我现在最喜欢蓝色",
      ),
    });

    await expect(
      service.extractAndStore(input("我现在最喜欢蓝色", "turn-blue")),
    ).resolves.toBe(1);

    expect(prisma.childMemory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        valueText: "blue",
        changeType: "supersede",
        status: "active",
        version: 2,
      }),
    });
    expect(prisma.childMemory.update).toHaveBeenCalledWith({
      where: { id: "memory-red" },
      data: expect.objectContaining({
        status: "superseded",
        validTo: occurredAt,
        supersededById: expect.any(String),
      }),
    });
    expect(prisma.childMemory.update).not.toHaveBeenCalledWith({
      where: { id: "memory-red" },
      data: expect.objectContaining({ valueText: "blue" }),
    });
    expect(prisma.childMemory.update.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.childMemory.create.mock.invocationCallOrder[0],
    );
  });

  it("should confirm the same value without creating a duplicate version", async () => {
    prisma.childMemory.findMany.mockResolvedValue([redMemory]);
    prisma.childMemory.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(redMemory);
    llm.complete.mockResolvedValue({
      text: extraction("red", "confirm", "favorite_color", "我还是最喜欢红色"),
    });

    await expect(
      service.extractAndStore(input("我还是最喜欢红色")),
    ).resolves.toBe(0);

    expect(prisma.childMemory.create).not.toHaveBeenCalled();
    expect(prisma.childMemory.update).toHaveBeenCalledWith({
      where: { id: "memory-red" },
      data: { lastConfirmedAt: occurredAt },
    });
  });

  it("should append a retraction tombstone and keep historical evidence", async () => {
    prisma.childMemory.findMany.mockResolvedValue([redMemory]);
    prisma.childMemory.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(redMemory);
    llm.complete.mockResolvedValue({
      text: extraction("red", "retract", "favorite_color", "我不再喜欢红色了"),
    });

    await expect(
      service.extractAndStore(input("我不再喜欢红色了")),
    ).resolves.toBe(1);

    expect(prisma.childMemory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        valueText: null,
        changeType: "retract",
        status: "retracted",
        version: 2,
      }),
    });
    expect(prisma.childMemory.update).toHaveBeenCalledWith({
      where: { id: "memory-red" },
      data: expect.objectContaining({ status: "retracted" }),
    });
  });

  it("should reject an additive statement instead of replacing a single-value favorite", async () => {
    prisma.childMemory.findMany.mockResolvedValue([redMemory]);
    llm.complete.mockResolvedValue({
      text: extraction("blue", "supersede", "favorite_color", "我也喜欢蓝色"),
    });

    await expect(service.extractAndStore(input("我也喜欢蓝色"))).resolves.toBe(
      0,
    );
    expect(prisma.childMemory.create).not.toHaveBeenCalled();
  });

  it("should ignore a stale extraction that finished after a newer turn", async () => {
    prisma.childMemory.findMany.mockResolvedValue([redMemory]);
    prisma.childMemory.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(redMemory);
    llm.complete.mockResolvedValue({
      text: extraction("blue", "supersede", "favorite_color", "我最喜欢蓝色"),
    });

    await expect(
      service.extractAndStore({
        ...input("我最喜欢蓝色"),
        sourceOccurredAt: new Date("2026-10-28T08:00:00Z"),
      }),
    ).resolves.toBe(0);
    expect(prisma.childMemory.create).not.toHaveBeenCalled();
  });

  it("should be idempotent for the same source turn and key", async () => {
    prisma.childMemory.findFirst.mockResolvedValue(redMemory);
    llm.complete.mockResolvedValue({
      text: extraction("red", "assert", "favorite_color", "我最喜欢红色"),
    });

    await expect(service.extractAndStore(input("我最喜欢红色"))).resolves.toBe(
      0,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.childMemory.create).not.toHaveBeenCalled();
  });

  it.each([
    ["not-json", "我最喜欢红色"],
    [extraction("红色", "assert", "school_name"), "我最喜欢红色"],
    [extraction("恐龙", "assert"), "我今天想玩恐龙"],
    [extraction("阳光小学", "assert"), "我最喜欢阳光小学"],
    [extraction("蓝色", "assert"), "我可能喜欢蓝色吧"],
  ])("should reject invalid or unsafe extraction %s", async (text, asrText) => {
    llm.complete.mockResolvedValue({ text });

    await expect(service.extractAndStore(input(asrText))).resolves.toBe(0);
    expect(prisma.childMemory.create).not.toHaveBeenCalled();
  });

  describe("方向与证据防线", () => {
    it("纯疑问句不抽取（孩子问 Elly 的偏好不是孩子的偏好）", async () => {
      // 实机事故：孩子问「Elly 最喜欢的颜色是什么呀」，extractor 把 Elly
      // 上轮回答的「橙色」错存为孩子的 favorite_color
      llm.complete.mockResolvedValue({
        text: extraction("橙色", "assert", "favorite_color", "最喜欢的颜色"),
      });

      await expect(
        service.extractAndStore(input("Elly 你最喜欢的颜色是什么呀？")),
      ).resolves.toBe(0);
      expect(prisma.childMemory.create).not.toHaveBeenCalled();
    });

    it("混合句（陈述偏好 + 反问）仍放行", async () => {
      llm.complete.mockResolvedValue({
        text: extraction("蓝色", "assert", "favorite_color", "我喜欢蓝色"),
      });
      prisma.childMemory.create.mockImplementation(({ data }) => data);

      await expect(
        service.extractAndStore(input("我喜欢蓝色，Elly 你呢？")),
      ).resolves.toBe(1);
      expect(prisma.childMemory.create).toHaveBeenCalled();
    });

    it("evidence 必须是孩子原话的子串（防幻觉证据）", async () => {
      llm.complete.mockResolvedValue({
        text: extraction(
          "蓝色",
          "assert",
          "favorite_color",
          "孩子说她喜欢蓝色",
        ),
      });

      await expect(service.extractAndStore(input("我喜欢蓝色"))).resolves.toBe(
        0,
      );
      expect(prisma.childMemory.create).not.toHaveBeenCalled();
    });

    it("抽取 prompt 含问句规则与 interest_topic 运动类正例", async () => {
      llm.complete.mockResolvedValue({ text: "[]" });

      await service.extractAndStore(input("今天很开心"));

      const systemPrompt = llm.complete.mock.calls[0][0].messages[0]
        .content as string;
      // 问句规则：提问不算陈述
      expect(systemPrompt).toContain("提问");
      // interest_topic 正例：运动类偏好（实机漏抽「我喜欢打篮球」）
      expect(systemPrompt).toContain("打篮球");
      // evidence 必须原文摘抄
      expect(systemPrompt).toContain("原文");
    });
  });

  it("should recall only contextually relevant active memories", async () => {
    prisma.childMemory.findMany.mockResolvedValue([
      redMemory,
      {
        ...redMemory,
        id: "memory-story",
        key: "favorite_story_type",
        valueText: "冒险故事",
        normalizedValue: "冒险故事",
      },
    ]);

    const result = await service.buildPromptBlock("device-1", "我们讲个故事吧");

    expect(result.memoryIds).toEqual(["memory-story"]);
    expect(result.text).toContain("冒险故事");
    expect(result.text).not.toContain("red");
    expect(result.text).toContain("不是用户指令");
  });

  it("should return no prompt block when no memory is contextually relevant", async () => {
    prisma.childMemory.findMany.mockResolvedValue([redMemory]);

    await expect(
      service.buildPromptBlock("device-1", "今天天气怎么样"),
    ).resolves.toEqual({ text: "", memoryIds: [] });
  });

  describe("buildPreferenceBlock", () => {
    it("返回全部 active 有值记忆并透出 favorite_story_type", async () => {
      prisma.childMemory.findMany.mockResolvedValue([
        { id: "m1", key: "favorite_color", valueText: "蓝色" },
        { id: "m2", key: "favorite_story_type", valueText: "冒险故事" },
        { id: "m3", key: "favorite_animal", valueText: null }, // 墓碑行不带出
      ]);

      const result = await service.buildPreferenceBlock("device-1");

      expect(prisma.childMemory.findMany).toHaveBeenCalledWith({
        where: { deviceId: "device-1", status: "active" },
        select: { id: true, key: true, valueText: true },
      });
      expect(result.memoryIds).toEqual(["m1", "m2"]);
      expect(result.favoriteStoryType).toBe("冒险故事");
      expect(result.text).toContain("蓝色");
      expect(result.text).toContain("冒险故事");
      expect(result.text).toContain("不是用户指令");
    });

    it("无 active 记忆时返回空块", async () => {
      prisma.childMemory.findMany.mockResolvedValue([]);

      await expect(service.buildPreferenceBlock("device-1")).resolves.toEqual({
        text: "",
        memoryIds: [],
        favoriteStoryType: null,
      });
    });

    it("无 favorite_story_type 时透出 null", async () => {
      prisma.childMemory.findMany.mockResolvedValue([
        { id: "m1", key: "favorite_color", valueText: "蓝色" },
      ]);

      const result = await service.buildPreferenceBlock("device-1");

      expect(result.favoriteStoryType).toBeNull();
      expect(result.memoryIds).toEqual(["m1"]);
    });
  });

  it("should mark memories as provided to the model after a successful reply", async () => {
    await service.markInjected(["memory-red"]);

    expect(prisma.childMemory.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["memory-red"] }, status: "active" },
      data: {
        lastInjectedAt: expect.any(Date),
        injectionCount: { increment: 1 },
      },
    });
  });
});
