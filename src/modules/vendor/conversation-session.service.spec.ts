import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import { SleepConfigsService } from "@/modules/sleep-configs/sleep-configs.service";
import { ConversationSessionService } from "./conversation-session.service";
import {
  PROMPT_REGISTRY_PROVIDER,
  makePromptRegistry,
} from "@/modules/prompt-registry/prompt-registry.testing";

type ConversationSessionMock = {
  findUnique: jest.Mock;
  upsert: jest.Mock;
};

type PrismaMock = {
  conversationSession: ConversationSessionMock;
};

type SleepConfigsMock = {
  getByDeviceId: jest.Mock;
};

describe("ConversationSessionService", () => {
  // 北京时间 13:00：默认落在 21:30 哄睡时段之外，用于门禁用例
  const now = new Date("2026-10-31T05:00:00.000Z");
  // 北京时间 22:00：落在 21:30 哄睡时段之内
  const inWindowNow = new Date("2026-10-31T14:00:00.000Z");
  let service: ConversationSessionService;
  let prisma: PrismaMock;
  let llmService: jest.Mocked<LlmService>;
  let sleepConfigs: SleepConfigsMock;

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

  /**
   * 哄睡配置夹具。默认 sleepTime="00:00"（全天都在窗口内）且
   * enabled/forceSleep 均关闭，这样与时段无关的既有用例（TTL、模式切换、
   * 兜底）不被门禁干扰；门禁与 forceSleep 用例各自显式覆盖这些字段。
   */
  const sleepConfig = (overrides: Record<string, unknown> = {}) => ({
    id: "sleep-config-1",
    deviceId: "device-1",
    enabled: false,
    durationMode: "default",
    durationMinutes: null,
    contentType: "story",
    sleepTime: "00:00",
    forceSleep: false,
    lastTriggeredDate: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(now);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PROMPT_REGISTRY_PROVIDER,
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
        {
          provide: SleepConfigsService,
          useValue: {
            getByDeviceId: jest.fn().mockResolvedValue(sleepConfig()),
          },
        },
      ],
    }).compile();

    service = module.get(ConversationSessionService);
    prisma = module.get(PrismaService) as unknown as PrismaMock;
    llmService = module.get(LlmService) as jest.Mocked<LlmService>;
    sleepConfigs = module.get(
      SleepConfigsService,
    ) as unknown as SleepConfigsMock;
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

  // 契约变更：前置关键词过滤已移除，普通闲聊也交给小模型做语义判定，
  // 因此「不调模型」不再是 free_chat 的判定依据；free_chat 仍不写会话。
  it("routes ordinary chat to free_chat via the classifier without a database write", async () => {
    llmService.complete.mockResolvedValue({
      text: "free_chat",
    } as Awaited<ReturnType<LlmService["complete"]>>);

    await expect(service.resolve("device-1", "今天天气怎么样")).resolves.toBe(
      "free_chat",
    );

    expect(llmService.complete).toHaveBeenCalledTimes(1);
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

  // 契约变更：活跃会话内的普通接话现在也会调模型做语义判定，
  // 只有模型判为 free_chat 时才维持原会话（滑动续期），
  // 这样「Elly 困了嘛」这类语义切换不会被会话粘滞吞掉。
  it("keeps an active session for an ordinary answer and slides expiration", async () => {
    prisma.conversationSession.findUnique.mockResolvedValue(
      activeSession("idiom_story"),
    );
    llmService.complete.mockResolvedValue({
      text: "free_chat",
    } as Awaited<ReturnType<LlmService["complete"]>>);

    await expect(service.resolve("device-1", "因为他很诚实")).resolves.toBe(
      "idiom_story",
    );

    expect(llmService.complete).toHaveBeenCalledTimes(1);
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
    llmService.complete.mockResolvedValue({
      text: "free_chat",
    } as Awaited<ReturnType<LlmService["complete"]>>);

    await expect(service.resolve("device-1", "我们今天玩什么")).resolves.toBe(
      "free_chat",
    );

    expect(prisma.conversationSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { currentMode: "free_chat", expiresAt: null },
      }),
    );
    expect(llmService.complete).toHaveBeenCalledTimes(1);
  });

  it("restores an active session after the service is reconstructed", async () => {
    prisma.conversationSession.findUnique.mockResolvedValue(
      activeSession("english_story"),
    );
    llmService.complete.mockResolvedValue({
      text: "free_chat",
    } as Awaited<ReturnType<LlmService["complete"]>>);
    const reconstructed = new ConversationSessionService(
      prisma as unknown as PrismaService,
      llmService,
      sleepConfigs as unknown as SleepConfigsService,
      makePromptRegistry(),
    );

    await expect(
      reconstructed.resolve("device-1", "我看到了小狗"),
    ).resolves.toBe("english_story");
    expect(sleepConfigs.getByDeviceId).toHaveBeenCalledWith("device-1");
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
   * 排查「孩子说要听故事却在闲聊」时必须能区分：模型分错 / 标签非法走兜底 /
   * 续听或接话维持原会话 / 强制哄睡覆写 / 哄睡时段门禁降级。
   * 前置关键词过滤已移除，除续听、显式退出与强制哄睡外每轮都会调分类器。
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

    // 契约变更：pre_filter_skip 已随前置关键词过滤一起移除，
    // 普通闲聊改由分类器判定，来源记为 model。
    it("model：普通闲聊也由分类器判定（前置过滤已移除）", async () => {
      mockModel("free_chat");

      const decision = await service.resolveWithSource(
        "device-1",
        "今天天气怎么样",
      );

      expect(decision).toEqual({ intent: "free_chat", source: "model" });
      expect(llmService.complete).toHaveBeenCalledTimes(1);
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

    // 契约变更：session_sticky 不再是「没调模型」，而是「模型判为 free_chat
    // 后维持原会话」。其余标签一律采纳，这样活跃会话内的语义切换不会被吞掉。
    it("session_sticky：活跃会话中模型判为 free_chat 时维持原会话", async () => {
      prisma.conversationSession.findUnique.mockResolvedValue(
        activeSession("sleep_story"),
      );
      mockModel("free_chat");

      const decision = await service.resolveWithSource(
        "device-1",
        "我喜欢这个故事",
      );

      expect(decision).toEqual({
        intent: "sleep_story",
        source: "session_sticky",
      });
      expect(llmService.complete).toHaveBeenCalledTimes(1);
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

    it("过期会话不参与粘滞：按模型重新判定", async () => {
      prisma.conversationSession.findUnique.mockResolvedValue(
        activeSession("english_story", new Date("2026-10-31T04:00:00.000Z")),
      );
      mockModel("free_chat");

      const decision = await service.resolveWithSource(
        "device-1",
        "今天天气怎么样",
      );

      expect(decision).toEqual({ intent: "free_chat", source: "model" });
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

    it("八种 source 互不相同，可在看板上分桶", async () => {
      const sources = new Set<string>();

      mockModel("free_chat");
      sources.add((await service.resolveWithSource("d", "我想听故事")).source);

      mockModel("garbage_label");
      sources.add((await service.resolveWithSource("d", "我想听故事")).source);

      llmService.complete.mockRejectedValue(new Error("boom"));
      sources.add((await service.resolveWithSource("d", "我想听故事")).source);

      prisma.conversationSession.findUnique.mockResolvedValue(
        activeSession("english_story"),
      );
      llmService.complete.mockReset();
      sources.add((await service.resolveWithSource("d", "继续")).source);
      mockModel("free_chat");
      sources.add(
        (await service.resolveWithSource("d", "我喜欢这个故事")).source,
      );
      llmService.complete.mockReset();
      sources.add((await service.resolveWithSource("d", "不想听了")).source);

      prisma.conversationSession.findUnique.mockResolvedValue(null);
      sleepConfigs.getByDeviceId.mockResolvedValue(
        sleepConfig({ enabled: true, forceSleep: true }),
      );
      sources.add(
        (await service.resolveWithSource("d", "随便说点什么")).source,
      );

      sleepConfigs.getByDeviceId.mockResolvedValue(
        sleepConfig({ sleepTime: "21:30" }),
      );
      mockModel("sleep_story");
      sources.add((await service.resolveWithSource("d", "我困了")).source);

      expect(sources).toEqual(
        new Set([
          "model",
          "fallback_invalid_label",
          "fallback_error",
          "continuation",
          "session_sticky",
          "explicit_exit",
          "force_sleep",
          "sleep_window_closed",
        ]),
      );
    });
  });

  describe("forceSleep 强制哄睡", () => {
    const forcedConfig = (overrides: Record<string, unknown> = {}) =>
      sleepConfig({
        enabled: true,
        forceSleep: true,
        sleepTime: "21:30",
        ...overrides,
      });

    it("enabled + forceSleep + 在哄睡时段内：一开口即进入 sleep_story，不调模型", async () => {
      jest.setSystemTime(inWindowNow);
      sleepConfigs.getByDeviceId.mockResolvedValue(forcedConfig());

      await expect(
        service.resolveWithSource("device-1", "今天幼儿园玩了滑梯"),
      ).resolves.toEqual({ intent: "sleep_story", source: "force_sleep" });

      expect(llmService.complete).not.toHaveBeenCalled();
      expect(prisma.conversationSession.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            currentMode: "sleep_story",
            expiresAt: new Date("2026-10-31T14:45:00.000Z"),
          },
        }),
      );
    });

    it("enabled=false 时不强制（总开关优先）", async () => {
      jest.setSystemTime(inWindowNow);
      sleepConfigs.getByDeviceId.mockResolvedValue(
        forcedConfig({ enabled: false }),
      );
      llmService.complete.mockResolvedValue({
        text: "free_chat",
      } as Awaited<ReturnType<LlmService["complete"]>>);

      await expect(
        service.resolveWithSource("device-1", "今天幼儿园玩了滑梯"),
      ).resolves.toEqual({ intent: "free_chat", source: "model" });
    });

    it("forceSleep=false 时不强制", async () => {
      jest.setSystemTime(inWindowNow);
      sleepConfigs.getByDeviceId.mockResolvedValue(
        forcedConfig({ forceSleep: false }),
      );
      llmService.complete.mockResolvedValue({
        text: "free_chat",
      } as Awaited<ReturnType<LlmService["complete"]>>);

      await expect(
        service.resolveWithSource("device-1", "今天幼儿园玩了滑梯"),
      ).resolves.toEqual({ intent: "free_chat", source: "model" });
    });

    it("未到 sleepTime 时不强制（北京时间 13:00 < 21:30）", async () => {
      sleepConfigs.getByDeviceId.mockResolvedValue(forcedConfig());
      llmService.complete.mockResolvedValue({
        text: "free_chat",
      } as Awaited<ReturnType<LlmService["complete"]>>);

      await expect(
        service.resolveWithSource("device-1", "今天幼儿园玩了滑梯"),
      ).resolves.toEqual({ intent: "free_chat", source: "model" });
    });

    it("次日凌晨 00:00 之后不再强制（窗口至当日 24:00 结束）", async () => {
      jest.setSystemTime(new Date("2026-10-31T16:00:00.000Z"));
      sleepConfigs.getByDeviceId.mockResolvedValue(forcedConfig());
      llmService.complete.mockResolvedValue({
        text: "free_chat",
      } as Awaited<ReturnType<LlmService["complete"]>>);

      await expect(
        service.resolveWithSource("device-1", "我还想玩"),
      ).resolves.toEqual({ intent: "free_chat", source: "model" });
    });

    it("优先于显式退出：强制期内说「不想听了」也不退出哄睡", async () => {
      jest.setSystemTime(inWindowNow);
      sleepConfigs.getByDeviceId.mockResolvedValue(forcedConfig());
      prisma.conversationSession.findUnique.mockResolvedValue(
        activeSession("sleep_story"),
      );

      await expect(
        service.resolveWithSource("device-1", "我不想听了，停止吧"),
      ).resolves.toEqual({ intent: "sleep_story", source: "force_sleep" });

      expect(prisma.conversationSession.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({
          update: { currentMode: "free_chat", expiresAt: null },
        }),
      );
    });

    // 防劫持：applyVoiceUpdate 的类型白名单挡住了 enabled/forceSleep，
    // 但挡不住 sleepTime；而强制窗口由 sleepTime 算出，若放行 sleep_config，
    // 孩子一句「哄睡改成 23:50」就能把窗口压缩到 10 分钟、事实上关掉强制哄睡。
    it("优先于 sleep_config：强制期内不允许用语音改哄睡设置", async () => {
      jest.setSystemTime(inWindowNow);
      sleepConfigs.getByDeviceId.mockResolvedValue(forcedConfig());

      await expect(
        service.resolveWithSource("device-1", "哄睡改成23点50分"),
      ).resolves.toEqual({ intent: "sleep_story", source: "force_sleep" });

      expect(llmService.complete).not.toHaveBeenCalled();
    });

    it("无配置行时不强制", async () => {
      jest.setSystemTime(inWindowNow);
      sleepConfigs.getByDeviceId.mockResolvedValue(null);
      llmService.complete.mockResolvedValue({
        text: "free_chat",
      } as Awaited<ReturnType<LlmService["complete"]>>);

      await expect(
        service.resolveWithSource("device-1", "今天幼儿园玩了滑梯"),
      ).resolves.toEqual({ intent: "free_chat", source: "model" });
    });

    it("读取配置失败时不强制、不抛出，退回正常判定", async () => {
      jest.setSystemTime(inWindowNow);
      sleepConfigs.getByDeviceId.mockRejectedValue(new Error("db down"));
      llmService.complete.mockResolvedValue({
        text: "free_chat",
      } as Awaited<ReturnType<LlmService["complete"]>>);

      await expect(
        service.resolveWithSource("device-1", "今天幼儿园玩了滑梯"),
      ).resolves.toEqual({ intent: "free_chat", source: "model" });
    });
  });

  describe("哄睡时段门禁", () => {
    const mockModel = (text: string) =>
      llmService.complete.mockResolvedValue({
        text,
      } as Awaited<ReturnType<LlmService["complete"]>>);

    it("白天（北京 13:00）说困了：降级为 free_chat，不进哄睡", async () => {
      sleepConfigs.getByDeviceId.mockResolvedValue(
        sleepConfig({ sleepTime: "21:30" }),
      );
      mockModel("sleep_story");

      await expect(
        service.resolveWithSource("device-1", "我困了"),
      ).resolves.toEqual({
        intent: "free_chat",
        source: "sleep_window_closed",
      });
    });

    it("降级时不写入 sleep_story 会话，避免占用 45 分钟粘滞", async () => {
      sleepConfigs.getByDeviceId.mockResolvedValue(
        sleepConfig({ sleepTime: "21:30" }),
      );
      mockModel("sleep_story");

      await service.resolveWithSource("device-1", "我困了");

      expect(prisma.conversationSession.upsert).not.toHaveBeenCalled();
    });

    it("到了 sleepTime（北京 22:00）同样一句话正常进入哄睡", async () => {
      jest.setSystemTime(inWindowNow);
      sleepConfigs.getByDeviceId.mockResolvedValue(
        sleepConfig({ sleepTime: "21:30" }),
      );
      mockModel("sleep_story");

      await expect(
        service.resolveWithSource("device-1", "我困了"),
      ).resolves.toEqual({ intent: "sleep_story", source: "model" });
    });

    it("无配置行时按 schema 默认 21:30 门禁", async () => {
      sleepConfigs.getByDeviceId.mockResolvedValue(null);
      mockModel("sleep_story");

      await expect(
        service.resolveWithSource("device-1", "我困了"),
      ).resolves.toEqual({
        intent: "free_chat",
        source: "sleep_window_closed",
      });
    });

    it("门禁与 enabled 无关：enabled=false 也拦白天误入", async () => {
      sleepConfigs.getByDeviceId.mockResolvedValue(
        sleepConfig({ enabled: false, sleepTime: "21:30" }),
      );
      mockModel("sleep_story");

      await expect(
        service.resolveWithSource("device-1", "我困了"),
      ).resolves.toEqual({
        intent: "free_chat",
        source: "sleep_window_closed",
      });
    });

    it("关键词兜底同样受门禁约束（模型挂了也不能白天进哄睡）", async () => {
      sleepConfigs.getByDeviceId.mockResolvedValue(
        sleepConfig({ sleepTime: "21:30" }),
      );
      llmService.complete.mockRejectedValue(
        new Error("classifier unavailable"),
      );

      await expect(
        service.resolveWithSource("device-1", "我要听睡前儿歌"),
      ).resolves.toEqual({
        intent: "free_chat",
        source: "sleep_window_closed",
      });
    });

    it("不拦 sleep_config：白天也能改哄睡设置", async () => {
      sleepConfigs.getByDeviceId.mockResolvedValue(
        sleepConfig({ sleepTime: "21:30" }),
      );
      mockModel("sleep_config");

      await expect(
        service.resolveWithSource("device-1", "以后睡前都听儿歌"),
      ).resolves.toEqual({ intent: "sleep_config", source: "model" });
    });

    it.each([
      ["english_story", "我想听英语故事"],
      ["idiom_story", "讲一个成语故事"],
      ["free_story", "给我讲个故事"],
      ["adventure_story", "我想玩每日冒险"],
    ])("不拦其他故事意图：%s 白天照常进入", async (label, text) => {
      sleepConfigs.getByDeviceId.mockResolvedValue(
        sleepConfig({ sleepTime: "21:30" }),
      );
      mockModel(label);

      await expect(
        service.resolveWithSource("device-1", text),
      ).resolves.toEqual({ intent: label, source: "model" });
    });

    it("不拦续听：活跃哄睡会话跨零点后「继续」仍保持 sleep_story", async () => {
      jest.setSystemTime(new Date("2026-10-31T16:10:00.000Z"));
      sleepConfigs.getByDeviceId.mockResolvedValue(
        sleepConfig({ sleepTime: "21:30" }),
      );
      prisma.conversationSession.findUnique.mockResolvedValue(
        activeSession("sleep_story", new Date("2026-10-31T16:40:00.000Z")),
      );

      await expect(
        service.resolveWithSource("device-1", "继续"),
      ).resolves.toEqual({ intent: "sleep_story", source: "continuation" });
    });
  });

  describe("语义识别（不再依赖关键词穷举）", () => {
    const mockModel = (text: string) =>
      llmService.complete.mockResolvedValue({
        text,
      } as Awaited<ReturnType<LlmService["complete"]>>);

    it.each([
      "我困了",
      "Elly困了嘛",
      "进入睡眠模式",
      "我好累想躺下",
      "眼皮打架了",
    ])("困意表达 %s 会送进分类器，不被前置词表拦掉", async (text) => {
      jest.setSystemTime(inWindowNow);
      sleepConfigs.getByDeviceId.mockResolvedValue(
        sleepConfig({ sleepTime: "21:30" }),
      );
      mockModel("sleep_story");

      await expect(
        service.resolveWithSource("device-1", text),
      ).resolves.toEqual({ intent: "sleep_story", source: "model" });
      expect(llmService.complete).toHaveBeenCalledTimes(1);
    });

    it("活跃英语会话内说「Elly困了嘛」能语义切到哄睡", async () => {
      jest.setSystemTime(inWindowNow);
      sleepConfigs.getByDeviceId.mockResolvedValue(
        sleepConfig({ sleepTime: "21:30" }),
      );
      prisma.conversationSession.findUnique.mockResolvedValue(
        activeSession("english_story"),
      );
      mockModel("sleep_story");

      await expect(
        service.resolveWithSource("device-1", "Elly困了嘛"),
      ).resolves.toEqual({ intent: "sleep_story", source: "model" });
      expect(prisma.conversationSession.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ currentMode: "sleep_story" }),
        }),
      );
    });

    it("活跃英语会话内的普通接话不会误切模式", async () => {
      prisma.conversationSession.findUnique.mockResolvedValue(
        activeSession("english_story"),
      );
      mockModel("free_chat");

      await expect(
        service.resolveWithSource("device-1", "我今天在幼儿园看到了小狗"),
      ).resolves.toEqual({ intent: "english_story", source: "session_sticky" });
    });

    it("模型挂掉时关键词兜底仍认得「困」", async () => {
      jest.setSystemTime(inWindowNow);
      sleepConfigs.getByDeviceId.mockResolvedValue(
        sleepConfig({ sleepTime: "21:30" }),
      );
      llmService.complete.mockRejectedValue(
        new Error("classifier unavailable"),
      );

      await expect(
        service.resolveWithSource("device-1", "我困了"),
      ).resolves.toEqual({ intent: "sleep_story", source: "fallback_error" });
    });

    it("模型挂掉时关键词兜底仍认得「进入睡眠模式」", async () => {
      jest.setSystemTime(inWindowNow);
      sleepConfigs.getByDeviceId.mockResolvedValue(
        sleepConfig({ sleepTime: "21:30" }),
      );
      llmService.complete.mockRejectedValue(
        new Error("classifier unavailable"),
      );

      await expect(
        service.resolveWithSource("device-1", "进入睡眠模式"),
      ).resolves.toEqual({ intent: "sleep_story", source: "fallback_error" });
    });

    it("分类器 prompt 覆盖困意语义，并声明时段门禁由服务端决定", async () => {
      mockModel("free_chat");

      await service.resolveWithSource("device-1", "我困了");

      const systemPrompt = llmService.complete.mock.calls[0][0].messages[0]
        ?.content as string;
      expect(systemPrompt).toContain("困意");
      expect(systemPrompt).toContain("Elly困了嘛");
      expect(systemPrompt).toContain("时段门禁");
    });
  });
});
