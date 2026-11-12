import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import { ConversationSessionService } from "./conversation-session.service";

type ConversationSessionMock = {
  findUnique: jest.Mock;
  upsert: jest.Mock;
};

type PrismaMock = {
  conversationSession: ConversationSessionMock;
};

describe("ConversationSessionService", () => {
  const now = new Date("2026-10-31T05:00:00.000Z");
  let service: ConversationSessionService;
  let prisma: PrismaMock;
  let llmService: jest.Mocked<LlmService>;

  const activeSession = (
    currentMode: "english_story" | "idiom_story" | "sleep_story",
    expiresAt = new Date("2026-10-31T05:10:00.000Z"),
  ) => ({
    id: "session-1",
    deviceId: "device-1",
    currentMode,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(now);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationSessionService,
        {
          provide: PrismaService,
          useValue: {
            conversationSession: {
              findUnique: jest.fn().mockResolvedValue(null),
              upsert: jest.fn().mockResolvedValue(undefined),
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

    service = module.get(ConversationSessionService);
    prisma = module.get(PrismaService) as unknown as PrismaMock;
    llmService = module.get(LlmService) as jest.Mocked<LlmService>;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ["free_chat", "free_chat"],
    ["adventure_story", "adventure_story"],
    ["english_story", "english_story"],
    ["idiom_story", "idiom_story"],
    ["sleep_story", "sleep_story"],
    ["free_story", "free_story"],
    ["sleep_config", "sleep_config"],
  ])(
    "accepts only the seven-label routing contract: %s",
    async (output, expected) => {
      llmService.complete.mockResolvedValue({
        text: output,
      } as Awaited<ReturnType<LlmService["complete"]>>);

      await expect(service.resolve("device-1", "我想听故事")).resolves.toBe(
        expected,
      );
      expect(llmService.complete).toHaveBeenCalledWith(
        expect.objectContaining({ model: "small-llm", temperature: 0 }),
      );
      const systemPrompt = llmService.complete.mock.calls[0][0].messages[0]
        ?.content as string;
      expect(systemPrompt).toContain("sleep_story");
      expect(systemPrompt).toContain("free_chat");
      expect(systemPrompt).not.toContain("not_story");
    },
  );

  it("threads turnId into intent classification when provided", async () => {
    llmService.complete.mockResolvedValue({
      text: "free_chat",
    } as Awaited<ReturnType<LlmService["complete"]>>);

    await service.resolve("device-1", "我想听故事", "turn-1");

    expect(llmService.complete).toHaveBeenCalledWith(
      expect.objectContaining({ scene: "intent_classify", turnId: "turn-1" }),
    );
  });

  it("routes ordinary chat without model classification or a database write", async () => {
    await expect(service.resolve("device-1", "今天天气怎么样")).resolves.toBe(
      "free_chat",
    );

    expect(llmService.complete).not.toHaveBeenCalled();
    expect(prisma.conversationSession.upsert).not.toHaveBeenCalled();
  });

  it("routes sleep-config modification speech to sleep_config without a persistent session", async () => {
    llmService.complete.mockResolvedValue({
      text: "sleep_config",
    } as Awaited<ReturnType<LlmService["complete"]>>);

    await expect(service.resolve("device-1", "以后睡前都听儿歌")).resolves.toBe(
      "sleep_config",
    );

    // 配置修改是即时动作，不进入 45 分钟会话
    expect(prisma.conversationSession.upsert).not.toHaveBeenCalled();
  });

  it("falls back to sleep_config for modification keywords when classification fails", async () => {
    llmService.complete.mockRejectedValue(new Error("llm down"));

    await expect(service.resolve("device-1", "哄睡改成20分钟")).resolves.toBe(
      "sleep_config",
    );
  });

  it("still falls back to sleep_story for entry keywords when classification fails", async () => {
    llmService.complete.mockRejectedValue(new Error("llm down"));

    await expect(service.resolve("device-1", "我要听睡前儿歌")).resolves.toBe(
      "sleep_story",
    );
  });

  it("keeps an active English session for continuation without classification", async () => {
    prisma.conversationSession.findUnique.mockResolvedValue(
      activeSession("english_story"),
    );

    await expect(service.resolve("device-1", "再讲一个")).resolves.toBe(
      "english_story",
    );

    expect(llmService.complete).not.toHaveBeenCalled();
    expect(prisma.conversationSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deviceId: "device-1" },
        update: {
          currentMode: "english_story",
          expiresAt: new Date("2026-10-31T05:20:00.000Z"),
        },
      }),
    );
  });

  it("keeps an active session for an ordinary answer and slides expiration", async () => {
    prisma.conversationSession.findUnique.mockResolvedValue(
      activeSession("idiom_story"),
    );

    await expect(service.resolve("device-1", "因为他很诚实")).resolves.toBe(
      "idiom_story",
    );

    expect(llmService.complete).not.toHaveBeenCalled();
    expect(prisma.conversationSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          currentMode: "idiom_story",
          expiresAt: new Date("2026-10-31T05:20:00.000Z"),
        },
      }),
    );
  });

  it("allows an explicit mode switch while another session is active", async () => {
    prisma.conversationSession.findUnique.mockResolvedValue(
      activeSession("english_story"),
    );
    llmService.complete.mockResolvedValue({
      text: "idiom_story",
    } as Awaited<ReturnType<LlmService["complete"]>>);

    await expect(service.resolve("device-1", "换成语故事吧")).resolves.toBe(
      "idiom_story",
    );

    expect(llmService.complete).toHaveBeenCalled();
    expect(prisma.conversationSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ currentMode: "idiom_story" }),
      }),
    );
  });

  it("allows an explicit adventure request to leave an active English session", async () => {
    prisma.conversationSession.findUnique.mockResolvedValue(
      activeSession("english_story"),
    );
    llmService.complete.mockResolvedValue({
      text: "adventure_story",
    } as Awaited<ReturnType<LlmService["complete"]>>);

    await expect(service.resolve("device-1", "我还想玩每日冒险")).resolves.toBe(
      "adventure_story",
    );

    expect(llmService.complete).toHaveBeenCalled();
    expect(prisma.conversationSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { currentMode: "free_chat", expiresAt: null },
      }),
    );
  });

  it("resets an active session on explicit exit", async () => {
    prisma.conversationSession.findUnique.mockResolvedValue(
      activeSession("sleep_story"),
    );

    await expect(
      service.resolve("device-1", "我不想听了，停止吧"),
    ).resolves.toBe("free_chat");

    expect(llmService.complete).not.toHaveBeenCalled();
    expect(prisma.conversationSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { currentMode: "free_chat", expiresAt: null },
      }),
    );
  });

  it("lazily expires a stale session before routing the next message", async () => {
    prisma.conversationSession.findUnique.mockResolvedValue(
      activeSession("english_story", new Date("2026-10-31T04:59:59.000Z")),
    );

    await expect(service.resolve("device-1", "我们今天玩什么")).resolves.toBe(
      "free_chat",
    );

    expect(prisma.conversationSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { currentMode: "free_chat", expiresAt: null },
      }),
    );
    expect(llmService.complete).not.toHaveBeenCalled();
  });

  it("restores an active session after the service is reconstructed", async () => {
    prisma.conversationSession.findUnique.mockResolvedValue(
      activeSession("english_story"),
    );
    const reconstructed = new ConversationSessionService(
      prisma as unknown as PrismaService,
      llmService,
    );

    await expect(
      reconstructed.resolve("device-1", "我看到了小狗"),
    ).resolves.toBe("english_story");
    expect(llmService.complete).not.toHaveBeenCalled();
  });

  it("uses a 45-minute sliding expiration for sleep stories", async () => {
    llmService.complete.mockResolvedValue({
      text: "sleep_story",
    } as Awaited<ReturnType<LlmService["complete"]>>);

    await expect(service.resolve("device-1", "我想听哄睡故事")).resolves.toBe(
      "sleep_story",
    );

    expect(prisma.conversationSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deviceId: "device-1" },
        create: {
          deviceId: "device-1",
          currentMode: "sleep_story",
          expiresAt: new Date("2026-10-31T05:45:00.000Z"),
        },
        update: {
          currentMode: "sleep_story",
          expiresAt: new Date("2026-10-31T05:45:00.000Z"),
        },
      }),
    );
  });

  it("uses keyword fallback for illegal model output", async () => {
    llmService.complete.mockResolvedValue({
      text: "not_story",
    } as Awaited<ReturnType<LlmService["complete"]>>);

    await expect(service.resolve("device-1", "我想听英语故事")).resolves.toBe(
      "english_story",
    );
  });

  it("uses keyword fallback when classification fails", async () => {
    llmService.complete.mockRejectedValue(new Error("classifier unavailable"));

    await expect(service.resolve("device-1", "讲一个成语故事")).resolves.toBe(
      "idiom_story",
    );
    expect(prisma.conversationSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ currentMode: "idiom_story" }),
      }),
    );
  });

  /**
   * resolveWithSource：暴露「intent 是怎么来的」。
   * 7 条决策出口里有 4 条根本不调小模型，排查「孩子说要听故事却在闲聊」时
   * 必须能区分：预筛没命中 / 模型分错 / 标签非法走兜底 / 会话粘住没退出。
   */
  describe("resolveWithSource 决策路径可观测", () => {
    const mockModel = (text: string) =>
      llmService.complete.mockResolvedValue({
        text,
      } as Awaited<ReturnType<LlmService["complete"]>>);

    it("model：预筛命中且模型给出合法标签", async () => {
      mockModel("idiom_story");

      await expect(
        service.resolveWithSource("device-1", "我想听故事"),
      ).resolves.toEqual({ intent: "idiom_story", source: "model" });
    });

    it("model：活跃会话中的显式模式切换也走模型", async () => {
      prisma.conversationSession.findUnique.mockResolvedValue(
        activeSession("english_story"),
      );
      mockModel("sleep_story");

      await expect(
        service.resolveWithSource("device-1", "我想听睡前故事"),
      ).resolves.toEqual({ intent: "sleep_story", source: "model" });
    });

    it("fallback_invalid_label：模型有响应但标签非法", async () => {
      mockModel("not_story");

      await expect(
        service.resolveWithSource("device-1", "我想听英语故事"),
      ).resolves.toEqual({
        intent: "english_story",
        source: "fallback_invalid_label",
      });
    });

    it("fallback_error：模型调用异常后关键词兜底", async () => {
      llmService.complete.mockRejectedValue(
        new Error("classifier unavailable"),
      );

      await expect(
        service.resolveWithSource("device-1", "讲一个成语故事"),
      ).resolves.toEqual({
        intent: "idiom_story",
        source: "fallback_error",
      });
    });

    it("pre_filter_skip：非路由候选词直接 free_chat，不调模型", async () => {
      const decision = await service.resolveWithSource(
        "device-1",
        "今天天气怎么样",
      );

      expect(decision).toEqual({
        intent: "free_chat",
        source: "pre_filter_skip",
      });
      expect(llmService.complete).not.toHaveBeenCalled();
    });

    it("continuation：活跃会话中的「继续」不调模型", async () => {
      prisma.conversationSession.findUnique.mockResolvedValue(
        activeSession("english_story"),
      );

      const decision = await service.resolveWithSource("device-1", "继续");

      expect(decision).toEqual({
        intent: "english_story",
        source: "continuation",
      });
      expect(llmService.complete).not.toHaveBeenCalled();
    });

    it("session_sticky：活跃会话中的普通接话不调模型", async () => {
      prisma.conversationSession.findUnique.mockResolvedValue(
        activeSession("sleep_story"),
      );

      const decision = await service.resolveWithSource(
        "device-1",
        "我喜欢这个故事",
      );

      expect(decision).toEqual({
        intent: "sleep_story",
        source: "session_sticky",
      });
      expect(llmService.complete).not.toHaveBeenCalled();
    });

    it("explicit_exit：显式退出重置会话且不调模型", async () => {
      prisma.conversationSession.findUnique.mockResolvedValue(
        activeSession("english_story"),
      );

      const decision = await service.resolveWithSource("device-1", "不想听了");

      expect(decision).toEqual({
        intent: "free_chat",
        source: "explicit_exit",
      });
      expect(llmService.complete).not.toHaveBeenCalled();
    });

    it("过期会话不参与粘滞：按预筛/模型重新判定", async () => {
      prisma.conversationSession.findUnique.mockResolvedValue(
        activeSession("english_story", new Date("2026-10-31T04:00:00.000Z")),
      );
      mockModel("free_chat");

      const decision = await service.resolveWithSource(
        "device-1",
        "今天天气怎么样",
      );

      expect(decision).toEqual({
        intent: "free_chat",
        source: "pre_filter_skip",
      });
    });

    it("resolve() 委托 resolveWithSource()：intent 完全一致（老链路契约不变）", async () => {
      mockModel("sleep_config");

      const [plain, withSource] = await Promise.all([
        service.resolve("device-1", "以后睡前都听儿歌"),
        service.resolveWithSource("device-1", "以后睡前都听儿歌"),
      ]);

      expect(plain).toBe(withSource.intent);
      expect(plain).toBe("sleep_config");
    });

    it("七种 source 互不相同，可在看板上分桶", async () => {
      const sources = new Set<string>();

      mockModel("free_chat");
      sources.add((await service.resolveWithSource("d", "我想听故事")).source);

      mockModel("garbage_label");
      sources.add((await service.resolveWithSource("d", "我想听故事")).source);

      llmService.complete.mockRejectedValue(new Error("boom"));
      sources.add((await service.resolveWithSource("d", "我想听故事")).source);

      llmService.complete.mockReset();
      sources.add(
        (await service.resolveWithSource("d", "今天天气怎么样")).source,
      );

      prisma.conversationSession.findUnique.mockResolvedValue(
        activeSession("english_story"),
      );
      sources.add((await service.resolveWithSource("d", "继续")).source);
      sources.add(
        (await service.resolveWithSource("d", "我喜欢这个故事")).source,
      );
      sources.add((await service.resolveWithSource("d", "不想听了")).source);

      expect(sources).toEqual(
        new Set([
          "model",
          "fallback_invalid_label",
          "fallback_error",
          "pre_filter_skip",
          "continuation",
          "session_sticky",
          "explicit_exit",
        ]),
      );
    });
  });
});
