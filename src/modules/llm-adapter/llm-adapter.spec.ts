import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { LlmAdapterService } from "./llm-adapter.service";
import { LlmAdapterController } from "./llm-adapter.controller";
import {
  parseChatCompletionRequest,
  ChatCompletionRequest,
} from "./dto/chat-completion.dto";
import { LlmService, LlmUpstreamError } from "@/modules/llm/llm.service";
import { ChildSafetyService } from "@/modules/vendor/child-safety.service";
import { ChildMemoriesService } from "@/modules/child-memories/child-memories.service";
import { ConversationSessionService } from "@/modules/vendor/conversation-session.service";
import { SleepVoiceConfigService } from "@/modules/sleep-configs/sleep-voice-config.service";
import { SleepConfigsService } from "@/modules/sleep-configs/sleep-configs.service";
import { AdventureService } from "@/modules/adventure/adventure.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { TurnDecisionRecorder } from "@/modules/turn-decision/turn-decision-recorder.service";
import { OpenAiExceptionFilter } from "./filters/openai-exception.filter";
import { PROMPT_REGISTRY_PROVIDER } from "@/modules/prompt-registry/prompt-registry.testing";

const VALID_TOKEN = "test-adapter-key";

describe("LlmAdapterModule", () => {
  let service: LlmAdapterService;
  let controller: LlmAdapterController;
  let llm: {
    buildEnglishTutorPrompt: jest.Mock;
    buildFillerPrompt: jest.Mock;
    buildFillerHandoffMessage: jest.Mock;
    complete: jest.Mock;
    completeStream: jest.Mock;
    smallModelName: string;
  };
  let configGet: jest.Mock;
  let childSafety: {
    checkL1: jest.Mock;
    classifyL2: jest.Mock;
    cannedReply: jest.Mock;
  };
  let prisma: {
    device: { findFirst: jest.Mock; create: jest.Mock };
    message: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
    };
    deviceConfig: { findFirst: jest.Mock };
    childProfile: { findUnique: jest.Mock };
  };
  let memories: {
    buildPromptBlock: jest.Mock;
    buildPreferenceBlock: jest.Mock;
    extractAndStore: jest.Mock;
    markInjected: jest.Mock;
  };
  let session: { resolveWithSource: jest.Mock; reset: jest.Mock };
  let turnDecisions: { record: jest.Mock };
  let sleepVoice: { handle: jest.Mock };
  let sleepConfigs: { applyVoiceUpdate: jest.Mock; getByDeviceId: jest.Mock };
  let adventure: {
    handleChildReply: jest.Mock;
    startToday: jest.Mock;
    isCompletedToday: jest.Mock;
    recordEntryBlocked: jest.Mock;
    recordPresented: jest.Mock;
    markPromptPlaybackComplete: jest.Mock;
    registerTimeoutListener: jest.Mock;
  };

  const makeStream = (chunks: string[]) =>
    async function* () {
      for (const c of chunks) yield c;
    };

  beforeEach(async () => {
    llm = {
      buildEnglishTutorPrompt: jest.fn((asrText: string) => [
        { role: "system", content: "built-system" },
        { role: "user", content: asrText },
      ]),
      buildFillerPrompt: jest
        .fn()
        .mockReturnValue([{ role: "system", content: "filler-sys" }]),
      buildFillerHandoffMessage: jest.fn((text: string) => ({
        role: "system",
        content: `handoff:${text}`,
      })),
      complete: jest.fn().mockResolvedValue({ text: "嗯——" }),
      completeStream: jest.fn(),
      smallModelName: "small-model",
    };
    configGet = jest.fn((key: string) => {
      if (key === "LLM_ADAPTER_API_KEY") return VALID_TOKEN;
      // 测试默认关闭 filler，filler 用例内显式开启，避免干扰存量断言
      if (key === "LLM_ADAPTER_FILLER") return "false";
      return undefined;
    });
    childSafety = {
      checkL1: jest.fn().mockReturnValue({
        blocked: false,
        category: null,
        layer: null,
        source: "l1_regex",
      }),
      classifyL2: jest.fn().mockResolvedValue({
        blocked: false,
        category: "safe",
        layer: "L2",
        source: "l2_model",
      }),
      cannedReply: jest.fn().mockReturnValue("这个话题不适合小朋友聊哦。"),
    };
    prisma = {
      device: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      message: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      deviceConfig: { findFirst: jest.fn().mockResolvedValue(null) },
      childProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    memories = {
      buildPromptBlock: jest
        .fn()
        .mockResolvedValue({ text: "", memoryIds: [] }),
      buildPreferenceBlock: jest.fn().mockResolvedValue({
        text: "",
        memoryIds: [],
        favoriteStoryType: null,
      }),
      extractAndStore: jest.fn().mockResolvedValue(0),
      markInjected: jest.fn().mockResolvedValue(undefined),
    };
    session = {
      resolveWithSource: jest
        .fn()
        .mockResolvedValue({ intent: "free_chat", source: "model" }),
      reset: jest.fn().mockResolvedValue(undefined),
    };
    turnDecisions = { record: jest.fn() };
    sleepVoice = {
      handle: jest.fn().mockResolvedValue({
        replyText: "好呀，以后哄睡时间就改成 20 分钟啦！",
        applied: true,
        field: "durationMinutes",
      }),
    };
    sleepConfigs = {
      applyVoiceUpdate: jest.fn().mockResolvedValue({}),
      getByDeviceId: jest.fn().mockResolvedValue({ contentType: "story" }),
    };
    adventure = {
      handleChildReply: jest.fn().mockResolvedValue(null),
      startToday: jest.fn().mockResolvedValue(null),
      isCompletedToday: jest.fn().mockResolvedValue(false),
      recordEntryBlocked: jest.fn().mockResolvedValue(undefined),
      recordPresented: jest.fn().mockResolvedValue(undefined),
      markPromptPlaybackComplete: jest.fn().mockResolvedValue(undefined),
      registerTimeoutListener: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LlmAdapterController],
      providers: [
        PROMPT_REGISTRY_PROVIDER,
        LlmAdapterService,
        { provide: LlmService, useValue: llm },
        { provide: ChildSafetyService, useValue: childSafety },
        { provide: ChildMemoriesService, useValue: memories },
        { provide: ConversationSessionService, useValue: session },
        { provide: SleepVoiceConfigService, useValue: sleepVoice },
        { provide: SleepConfigsService, useValue: sleepConfigs },
        { provide: AdventureService, useValue: adventure },
        { provide: PrismaService, useValue: prisma },
        { provide: TurnDecisionRecorder, useValue: turnDecisions },
        {
          provide: ConfigService,
          useValue: { get: configGet },
        },
      ],
    }).compile();

    service = module.get(LlmAdapterService);
    controller = module.get(LlmAdapterController);
  });

  describe("intent routing & modes (2B)", () => {
    const deviceRow = { id: "dev-internal-1", deviceId: "dev-1001" };
    const boundRequest: ChatCompletionRequest = {
      model: "deda-english-tutor",
      stream: true,
      user: "dev-1001",
      messages: [{ role: "user", content: "讲一个英语故事" }],
    };

    const collect = async (gen: AsyncGenerator<string>): Promise<string[]> => {
      const out: string[] = [];
      for await (const c of gen) out.push(c);
      return out;
    };

    it("resolves intent per turn and snapshots the resolved mode on messages", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "english_story",
        source: "model",
      });
      llm.completeStream.mockReturnValue(makeStream(["Once upon..."])());
      await collect(service.streamReply(boundRequest));
      expect(session.resolveWithSource).toHaveBeenCalledWith(
        "dev-internal-1",
        "讲一个英语故事",
        expect.any(String),
      );
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.mode).toBe("english_story");
      // 历史按解析出的模式过滤，与老链路口径一致
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ mode: "english_story" }),
        }),
      );
      // 故事模式注入故事 prompt（经 promptTemplate 传给 prompt 组装）；
      // 记忆走轻量偏好块（非相关性召回），保证跨模式「Elly 懂我」
      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "讲一个英语故事",
        expect.any(Array),
        expect.objectContaining({
          mode: "english_story",
          promptTemplate: expect.stringContaining("English story"),
        }),
      );
      expect(memories.buildPromptBlock).not.toHaveBeenCalled();
      expect(memories.buildPreferenceBlock).toHaveBeenCalledWith(
        "dev-internal-1",
      );
    });

    it("故事话术按 favorite_story_type 主动选题", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "idiom_story",
        source: "model",
      });
      memories.buildPreferenceBlock.mockResolvedValue({
        text: "PREFS",
        memoryIds: ["m9"],
        favoriteStoryType: "冒险故事",
      });
      llm.completeStream.mockReturnValue(makeStream(["ok"])());

      const req: ChatCompletionRequest = {
        ...boundRequest,
        messages: [{ role: "user", content: "讲一个成语故事" }],
      };
      await collect(service.streamReply(req));

      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "讲一个成语故事",
        expect.any(Array),
        expect.objectContaining({
          mode: "idiom_story",
          promptTemplate: expect.stringContaining("冒险故事"),
        }),
      );
      expect(memories.markInjected).toHaveBeenCalledWith(["m9"]);
    });

    it("short-circuits sleep_config to a deterministic reply without the main LLM", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "sleep_config",
        source: "model",
      });
      const req: ChatCompletionRequest = {
        ...boundRequest,
        messages: [{ role: "user", content: "哄睡改成二十分钟" }],
      };
      const chunks = await collect(service.streamReply(req));
      expect(chunks).toEqual(["好呀，以后哄睡时间就改成 20 分钟啦！"]);
      expect(sleepVoice.handle).toHaveBeenCalledWith(
        "dev-internal-1",
        "哄睡改成二十分钟",
      );
      expect(llm.completeStream).not.toHaveBeenCalled();
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.rawPayload).toMatchObject({
        sleepConfig: "durationMinutes",
      });
    });

    it("persists voice content preference on sleep_story with 儿歌 keyword", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "sleep_story",
        source: "model",
      });
      const req: ChatCompletionRequest = {
        ...boundRequest,
        messages: [{ role: "user", content: "我要听睡前儿歌" }],
      };
      llm.completeStream.mockReturnValue(makeStream(["晚安故事来了"])());
      await collect(service.streamReply(req));
      expect(sleepConfigs.applyVoiceUpdate).toHaveBeenCalledWith(
        "dev-internal-1",
        { contentType: "song" },
      );
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.mode).toBe("sleep_story");
      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "我要听睡前儿歌",
        expect.any(Array),
        expect.objectContaining({
          mode: "sleep_story",
          promptTemplate: expect.stringContaining("哄睡"),
        }),
      );
    });

    /**
     * 儿歌/催眠曲内容源尚未就绪：哄睡一律出故事。
     * 但「家长配了 song、实际讲了 story」必须留下可查证据，
     * 否则运营看到的永远是「配置生效了」的假象。
     */
    it.each([["song"], ["mixed"]])(
      "contentType=%s 时记录降级并仍讲故事",
      async (contentType) => {
        prisma.device.findFirst.mockResolvedValue(deviceRow);
        sleepConfigs.getByDeviceId.mockResolvedValue({ contentType });
        session.resolveWithSource.mockResolvedValue({
          intent: "sleep_story",
          source: "model",
        });
        const warnSpy = jest
          .spyOn(
            (service as unknown as { logger: { warn: (m: string) => void } })
              .logger,
            "warn",
          )
          .mockImplementation(() => undefined);
        llm.completeStream.mockReturnValue(makeStream(["晚安故事来了"])());

        await collect(
          service.streamReply({
            ...boundRequest,
            messages: [{ role: "user", content: "我要听睡前儿歌" }],
          }),
        );

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(`contentType=${contentType}`),
        );
        const assistantCall = prisma.message.create.mock.calls[1][0];
        expect(assistantCall.data.rawPayload).toMatchObject({
          sleepContentDegraded: {
            requested: contentType,
            served: "story",
          },
        });
        // 降级不改行为：仍按哄睡故事 prompt 出内容
        expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
          "我要听睡前儿歌",
          expect.any(Array),
          expect.objectContaining({
            promptTemplate: expect.stringContaining("哄睡"),
          }),
        );
        warnSpy.mockRestore();
      },
    );

    it("contentType=story 时不写降级标记", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      sleepConfigs.getByDeviceId.mockResolvedValue({ contentType: "story" });
      session.resolveWithSource.mockResolvedValue({
        intent: "sleep_story",
        source: "model",
      });
      llm.completeStream.mockReturnValue(makeStream(["晚安故事来了"])());

      await collect(service.streamReply(boundRequest));

      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.rawPayload).not.toHaveProperty(
        "sleepContentDegraded",
      );
    });

    it("读取哄睡配置失败时只告警，不阻塞本轮回复", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      sleepConfigs.getByDeviceId.mockRejectedValue(new Error("db down"));
      session.resolveWithSource.mockResolvedValue({
        intent: "sleep_story",
        source: "model",
      });
      const warnSpy = jest
        .spyOn(
          (service as unknown as { logger: { warn: (m: string) => void } })
            .logger,
          "warn",
        )
        .mockImplementation(() => undefined);
      llm.completeStream.mockReturnValue(makeStream(["晚安故事来了"])());

      const chunks = await collect(service.streamReply(boundRequest));

      expect(chunks.join("")).toContain("晚安故事来了");
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.status).toBe("completed");
      expect(assistantCall.data.rawPayload).not.toHaveProperty(
        "sleepContentDegraded",
      );
      warnSpy.mockRestore();
    });

    // 哄睡时段门禁在 ConversationSessionService 内完成降级，编排层只需
    // 尊重结果：白天说困了 → free_chat，不得再写哄睡语音偏好。
    it("时段门禁降级为 free_chat 时不触发哄睡语音配置写入", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "free_chat",
        source: "sleep_window_closed",
      });
      llm.completeStream.mockReturnValue(makeStream(["有点困啦？"])());

      await collect(
        service.streamReply({
          ...boundRequest,
          messages: [{ role: "user", content: "我困了" }],
        }),
      );

      expect(sleepConfigs.applyVoiceUpdate).not.toHaveBeenCalled();
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.mode).toBe("free_chat");
    });

    it("routes free_story to free_story mode with a no-adventure-promise prompt", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "free_story",
        source: "model",
      });
      llm.completeStream.mockReturnValue(makeStream(["故事来了"])());
      await collect(service.streamReply(boundRequest));
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.mode).toBe("free_story");
    });

    it("uses deviceConfig english_chat when intent is free_chat", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "english_chat",
      });
      session.resolveWithSource.mockResolvedValue({
        intent: "free_chat",
        source: "model",
      });
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      await collect(service.streamReply(boundRequest));
      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "讲一个英语故事",
        [],
        expect.objectContaining({ mode: "english_chat" }),
      );
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.mode).toBe("english_chat");
    });

    it("uses no prompt template for free_chat intent", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "free_chat",
      });
      session.resolveWithSource.mockResolvedValue({
        intent: "free_chat",
        source: "model",
      });
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      await collect(service.streamReply(boundRequest));
      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "讲一个英语故事",
        expect.any(Array),
        expect.objectContaining({
          promptTemplate: undefined,
        }),
      );
    });

    it("degrades to free_chat when intent resolution throws", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockRejectedValue(new Error("session db down"));
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual(["ok"]);
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.mode).toBe("free_chat");
    });

    it("skips intent resolution when anonymous", async () => {
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      await collect(
        service.streamReply({
          model: "m",
          stream: true,
          messages: [{ role: "user", content: "讲一个英语故事" }],
        }),
      );
      expect(session.resolveWithSource).not.toHaveBeenCalled();
      expect(sleepVoice.handle).not.toHaveBeenCalled();
    });
  });

  describe("adventure & filler (2C)", () => {
    const deviceRow = { id: "dev-internal-1", deviceId: "dev-1001" };
    const boundRequest: ChatCompletionRequest = {
      model: "deda-english-tutor",
      stream: true,
      user: "dev-1001",
      messages: [{ role: "user", content: "我想玩每日冒险" }],
    };

    const collect = async (gen: AsyncGenerator<string>): Promise<string[]> => {
      const out: string[] = [];
      for await (const c of gen) out.push(c);
      return out;
    };

    it("adventure awaiting_reply intercepts before intent routing", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      adventure.handleChildReply.mockResolvedValue({
        texts: ["段落一", "段落二"],
        action: "await_reply",
      });
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual(["段落一", "段落二"]);
      // 接管后不再做意图分类、不进主模型
      expect(session.resolveWithSource).not.toHaveBeenCalled();
      expect(llm.completeStream).not.toHaveBeenCalled();
      // user/assistant 成对落库，mode=adventure_story
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      const userCall = prisma.message.create.mock.calls[0][0];
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(userCall.data.mode).toBe("adventure_story");
      expect(assistantCall.data).toMatchObject({
        role: "assistant",
        content: "段落一\n段落二",
        mode: "adventure_story",
      });
      expect(assistantCall.data.turnId).toBe(userCall.data.turnId);
      // 审计事件落库
      expect(adventure.recordPresented).toHaveBeenCalledWith(
        "dev-internal-1",
        userCall.data.turnId,
        expect.objectContaining({ action: "await_reply" }),
      );
      // 降级锁定：新链路无推送通道，绝不启用 10s 沉默超时机制
      expect(adventure.markPromptPlaybackComplete).not.toHaveBeenCalled();
      expect(adventure.registerTimeoutListener).not.toHaveBeenCalled();
    });

    it("enters adventure on adventure_story intent when today is not completed", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "adventure_story",
        source: "model",
      });
      adventure.startToday.mockResolvedValue({
        texts: ["冒险开场"],
        action: "narrate",
      });
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual(["冒险开场"]);
      expect(adventure.startToday).toHaveBeenCalledWith("dev-internal-1", true);
      expect(session.reset).toHaveBeenCalledWith("dev-internal-1");
      expect(llm.completeStream).not.toHaveBeenCalled();
    });

    it("blocks entry and records it when today's adventure is completed", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "adventure_story",
        source: "model",
      });
      adventure.isCompletedToday.mockResolvedValue(true);
      llm.completeStream.mockReturnValue(makeStream(["自由故事"])());
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual(["自由故事"]);
      expect(adventure.startToday).not.toHaveBeenCalled();
      expect(adventure.recordEntryBlocked).toHaveBeenCalledWith(
        "dev-internal-1",
        "free_story",
      );
      // 门禁后按自由创作降级
      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "我想玩每日冒险",
        expect.any(Array),
        expect.objectContaining({
          promptTemplate: expect.stringContaining("不要承诺开始"),
        }),
      );
      // 门禁后落 free_story 模式
      expect(prisma.message.create.mock.calls[0][0].data.mode).toBe(
        "free_story",
      );
    });

    it("falls back to free-story prompt when no episode is available", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "adventure_story",
        source: "model",
      });
      adventure.startToday.mockResolvedValue(null);
      llm.completeStream.mockReturnValue(makeStream(["自由故事"])());
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual(["自由故事"]);
      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "我想玩每日冒险",
        expect.any(Array),
        expect.objectContaining({
          promptTemplate: expect.stringContaining("不要承诺开始"),
        }),
      );
      // 无集可播时落 free_story 模式
      expect(prisma.message.create.mock.calls[0][0].data.mode).toBe(
        "free_story",
      );
    });

    it("persists free_story intent messages with mode free_story", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "free_story",
        source: "model",
      });
      llm.completeStream.mockReturnValue(makeStream(["好的，给你讲个故事"])());
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual(["好的，给你讲个故事"]);
      expect(prisma.message.create.mock.calls[0][0].data.mode).toBe(
        "free_story",
      );
    });

    it("persists free_chat intent as english_chat when device config is english_chat", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      prisma.deviceConfig.findFirst.mockResolvedValue({ mode: "english_chat" });
      session.resolveWithSource.mockResolvedValue({
        intent: "free_chat",
        source: "model",
      });
      llm.completeStream.mockReturnValue(
        makeStream(["The weather is nice."])(),
      );
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual(["The weather is nice."]);
      expect(prisma.message.create.mock.calls[0][0].data.mode).toBe(
        "english_chat",
      );
    });

    const enableFiller = () =>
      configGet.mockImplementation((key: string) =>
        key === "LLM_ADAPTER_API_KEY" ? VALID_TOKEN : undefined,
      );

    /** filler 与主模型都走 completeStream，按 scene 分流 mock */
    const mockStreamsByScene = (
      fillerChunks: string[] | Error,
      mainChunks: string[],
    ) => {
      llm.completeStream.mockImplementation((opts: { scene: string }) => {
        if (opts.scene === "filler") {
          if (fillerChunks instanceof Error) {
            return (async function* () {
              throw fillerChunks;
            })();
          }
          return makeStream(fillerChunks)();
        }
        return makeStream(mainChunks)();
      });
    };

    /** 只看 filler 场景的调用（completeStream 同时服务主模型） */
    const fillerCalls = () =>
      llm.completeStream.mock.calls.filter(
        (call: Array<{ scene: string }>) => call[0].scene === "filler",
      );
    const mainCalls = () =>
      llm.completeStream.mock.calls.filter(
        (call: Array<{ scene: string }>) => call[0].scene === "chat_main",
      );

    it("流式 filler 头部校验后先行播出并持久化边界，原文经 handoff 消息注入主模型", async () => {
      // 显式开启 filler（生产默认开，测试默认关）
      enableFiller();
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      // filler 分三段：首段满 8 字头部缓冲 → 校验通过立即外发，后续直通
      mockStreamsByScene(
        ["嗯——冒险呀，让", "我想想呢", "……"],
        ["正式", "答案"],
      );
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual([
        "嗯——冒险呀，让",
        "我想想呢",
        "……",
        "正式",
        "答案",
      ]);
      // filler 改走小模型流式（首音提前到 TTFT）：scene/model/上限/超时
      expect(llm.completeStream).toHaveBeenCalledWith(
        expect.objectContaining({
          scene: "filler",
          model: "small-model",
          maxTokens: 60,
          timeoutMs: expect.any(Number),
        }),
      );
      // 串行：filler 流先完成，主模型才启动
      expect(llm.completeStream.mock.calls[0][0].scene).toBe("filler");
      expect(llm.completeStream.mock.calls[1][0].scene).toBe("chat_main");
      // handoff（方案 B）：filler 原文作为独立 system 消息贴在本轮 user
      // 消息前注入，离生成点最近
      const mainMessages = mainCalls()[0][0].messages;
      expect(mainMessages[mainMessages.length - 2]).toEqual({
        role: "system",
        content: "handoff:嗯——冒险呀，让我想想呢……",
      });
      expect(mainMessages[mainMessages.length - 1]).toEqual({
        role: "user",
        content: "我想玩每日冒险",
      });
      // buildEnglishTutorPrompt 不再携带 fillerHeard（handoff 已外移）
      const promptOptions = llm.buildEnglishTutorPrompt.mock.calls[0][2];
      expect(promptOptions).not.toHaveProperty("fillerHeard");
      expect(llm.buildFillerPrompt).toHaveBeenCalledWith(
        "我想玩每日冒险",
        [],
        expect.objectContaining({
          intent: "free_chat",
          adventureDeclined: false,
        }),
      );
      // 落库边界：content 为播报全文，filler/answer 结构化存 rawPayload
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.rawPayload).toEqual({
        filler: "嗯——冒险呀，让我想想呢……",
        answer: "正式答案",
      });
      expect(assistantCall.data.content).toBe(
        "嗯——冒险呀，让我想想呢……\n正式答案",
      );
    });

    it("filler 生成失败时回落兜底模板池，过渡音覆盖不缺席", async () => {
      // dashboard 实测：filler 缺失轮完全没有防死空气缓冲。
      // 失败不再静默跳过，兜底模板（≥15 字）保证每轮都有覆盖
      enableFiller();
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      mockStreamsByScene(new Error("small model down"), ["答案"]);
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toHaveLength(2);
      expect([...chunks[0]].length).toBeGreaterThanOrEqual(15);
      expect(chunks[1]).toBe("答案");
      // 模板 filler 同样注入 handoff 并落库
      const mainMessages = mainCalls()[0][0].messages;
      expect(mainMessages[mainMessages.length - 2]).toEqual({
        role: "system",
        content: `handoff:${chunks[0]}`,
      });
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.rawPayload.filler).toBe(chunks[0]);
    });

    it("filler 以孩子名字开头时中止重试，违规内容一字不外发", async () => {
      // 实机事故：每句 filler 都以「贝果，」开头，结构性复读
      enableFiller();
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      prisma.childProfile.findUnique.mockResolvedValue({
        name: "贝果",
        englishName: null,
        birthday: "2020-06-01",
        gender: "female",
      });
      let attempt = 0;
      llm.completeStream.mockImplementation((opts: { scene: string }) => {
        if (opts.scene === "filler") {
          attempt += 1;
          // 首次：语气词+孩子名开头（规避不了——剥离语气词后仍是名字）
          return makeStream(
            attempt === 1
              ? ["呀，贝果是不是心里有点闷闷的呀……"]
              : ["听到你说心里闷闷的呀，我陪你呢……"],
          )();
        }
        return makeStream(["答"])();
      });
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks[0]).toBe("听到你说心里闷闷的呀，我陪你呢……");
      expect(chunks.join("")).not.toContain("贝果");
      expect(fillerCalls()).toHaveLength(2);
      // 重试带强禁令
      const retryMessages = fillerCalls()[1][0].messages;
      expect(retryMessages[retryMessages.length - 1].content).toContain(
        "被拒绝了",
      );
    });

    it("filler 以英文名开头同样硬禁（childName 优先 englishName）", async () => {
      enableFiller();
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      prisma.childProfile.findUnique.mockResolvedValue({
        name: "莉莉",
        englishName: "Lily",
        birthday: "2020-06-01",
        gender: "female",
      });
      let attempt = 0;
      llm.completeStream.mockImplementation((opts: { scene: string }) => {
        if (opts.scene === "filler") {
          attempt += 1;
          return makeStream(
            attempt === 1
              ? ["Lily, you drew a cat? Lovely!"]
              : ["Drawing a cat sounds so much fun!"],
          )();
        }
        return makeStream(["答"])();
      });
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks[0]).toBe("Drawing a cat sounds so much fun!");
      expect(fillerCalls()).toHaveLength(2);
    });

    it("filler 含人设名时中止重试；重试仍违规回落兜底模板池", async () => {
      // 实机事故：连续 8 轮「小象 Elly：X 真 Y 呀」同构口癖（名标签开头）；
      // 以及「小象 Elly 听到风在笑呢」式第三人称自称（头部出现人设名）
      enableFiller();
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      mockStreamsByScene(["小象 Elly：蓝色真美呢"], ["答"]);
      const chunks = await collect(service.streamReply(boundRequest));
      expect(fillerCalls()).toHaveLength(2); // 初次 + 一次重试，有上限
      expect(chunks[0]).not.toContain("小象 Elly");
      expect([...chunks[0]].length).toBeGreaterThanOrEqual(15); // 模板池兜底
      expect(chunks[1]).toBe("答");
    });

    it("filler 与近 5 轮逐字重复时仍播出（流式不可撤回），告警并依赖 prompt 禁用清单", async () => {
      // 流式权衡：全文去重无法在外发前定论，硬门让位给首音延迟，
      // 防线 = prompt 禁用清单 + 事后 warn 供 dashboard/日志观测
      enableFiller();
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      prisma.message.findMany.mockResolvedValue([
        {
          role: "assistant",
          content: "嗯——冒险真让人期待呀……\n上一轮回答",
          rawPayload: {
            filler: "嗯——冒险真让人期待呀……",
            answer: "上一轮回答",
          },
        },
      ]);
      const warnSpy = jest
        .spyOn(
          (service as unknown as { logger: { warn: (m: string) => void } })
            .logger,
          "warn",
        )
        .mockImplementation(() => undefined);
      mockStreamsByScene(["嗯——冒险真让人期待呀……"], ["答"]);
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks[0]).toBe("嗯——冒险真让人期待呀……");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("repeated"));
      warnSpy.mockRestore();
    });

    it("filler 低于 15 字下限时仍播出但告警（流式不可撤回）", async () => {
      enableFiller();
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      const warnSpy = jest
        .spyOn(
          (service as unknown as { logger: { warn: (m: string) => void } })
            .logger,
          "warn",
        )
        .mockImplementation(() => undefined);
      mockStreamsByScene(["嗯——我在听"], ["答"]);
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks[0]).toBe("嗯——我在听");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("floor"));
      warnSpy.mockRestore();
    });

    it("filler 外发后断流：保留已播部分，不重试不回补，主模型照常", async () => {
      // 半截 filler 已播给孩子，撤回/重试都会让孩子听到冲突内容
      enableFiller();
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockImplementation((opts: { scene: string }) => {
        if (opts.scene === "filler") {
          return (async function* () {
            yield "哇，你说的话真有意思";
            throw new Error("socket hang up");
          })();
        }
        return makeStream(["答"])();
      });
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual(["哇，你说的话真有意思", "答"]);
      expect(fillerCalls()).toHaveLength(1); // 不重试
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.rawPayload.filler).toBe("哇，你说的话真有意思");
    });

    it("身份/偏好问句的 filler 走确定性模板（≥15 字），不调用小模型", async () => {
      // 实机事故：「你叫什么名字」filler 抢答出名字，主模型又答一遍；
      // 「你最喜欢什么颜色」filler 主客颠倒成「你喜欢什么颜色呀」
      enableFiller();
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(makeStream(["我叫小象 Elly"])());
      const req: ChatCompletionRequest = {
        ...boundRequest,
        messages: [{ role: "user", content: "你叫什么名字" }],
      };
      const chunks = await collect(service.streamReply(req));
      expect(fillerCalls()).toHaveLength(0);
      expect(llm.buildFillerPrompt).not.toHaveBeenCalled();
      expect(chunks[0]).toContain("名字");
      expect([...chunks[0]].length).toBeGreaterThanOrEqual(15);
      // 模板 filler 同样注入主模型 handoff
      const mainMessages = mainCalls()[0][0].messages;
      expect(mainMessages[mainMessages.length - 2]).toEqual({
        role: "system",
        content: `handoff:${chunks[0]}`,
      });
    });

    it("never touches the adventure engine when anonymous", async () => {
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      await collect(
        service.streamReply({
          model: "m",
          stream: true,
          messages: [{ role: "user", content: "我想玩每日冒险" }],
        }),
      );
      expect(adventure.handleChildReply).not.toHaveBeenCalled();
      expect(adventure.startToday).not.toHaveBeenCalled();
      expect(adventure.isCompletedToday).not.toHaveBeenCalled();
    });
  });

  describe("upstream failure fallback & retry (P0)", () => {
    const deviceRow = { id: "dev-internal-1", deviceId: "dev-1001" };
    const boundRequest: ChatCompletionRequest = {
      model: "deda-english-tutor",
      stream: true,
      user: "dev-1001",
      messages: [{ role: "user", content: "讲一个成语故事" }],
    };
    const FALLBACK = "小象 Elly 刚刚走神啦，再说一次好不好呀？";
    const failingStream = (error: unknown) =>
      (async function* () {
        throw error;
      })();
    const enableFiller = () =>
      configGet.mockImplementation((key: string) =>
        key === "LLM_ADAPTER_API_KEY" ? VALID_TOKEN : undefined,
      );

    const collect = async (gen: AsyncGenerator<string>): Promise<string[]> => {
      const out: string[] = [];
      for await (const c of gen) out.push(c);
      return out;
    };

    it("filler 已播但主模型零输出失败时仍播兜底话术，不让孩子面对沉默", async () => {
      // 实机事故（2026-11-10 成语故事模式「甲醇盆」）：filler 433ms 已播出，
      // 主模型 10.7s 后 socket 断流零输出。旧条件 !answerText && !fillerText
      // 不兜底，孩子听完半句 filler 后死寂
      enableFiller();
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockImplementation((opts: { scene: string }) =>
        opts.scene === "filler"
          ? makeStream(["嗯——"])()
          : failingStream(
              new LlmUpstreamError(
                "upstream_error",
                "ECONNRESET: socket hang up",
                false,
              ),
            ),
      );
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual(["嗯——", FALLBACK]);
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.status).toBe("failed");
      expect(assistantCall.data.rawPayload).toEqual({
        filler: "嗯——",
        answer: FALLBACK,
      });
    });

    it("filler 未播且主模型零输出失败时播兜底话术", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(
        failingStream(
          new LlmUpstreamError(
            "upstream_error",
            "HTTP 400: bad request",
            false,
          ),
        ),
      );
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual([FALLBACK]);
    });

    it("主模型说出残句后断流时不播兜底、不重试，仅标 failed", async () => {
      // mid-stream 断流：残句已播给孩子，再播兜底或重试都会让孩子
      // 听到「前半句 + 另一段」的冲突内容，故只落库标 failed
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(
        (async function* () {
          yield "守株待兔讲的是";
          throw new LlmUpstreamError(
            "upstream_error",
            "ECONNRESET: socket hang up",
            true,
          );
        })(),
      );
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual(["守株待兔讲的是"]);
      expect(llm.completeStream).toHaveBeenCalledTimes(1); // 不重试
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.status).toBe("failed");
      expect(assistantCall.data.rawPayload.answer).toBe("守株待兔讲的是");
    });

    it("可重试的上游失败自动重试一次，第二次成功则整轮正常", async () => {
      // filler 播报 2.5-3.5s 正好掩盖一次重试延迟，孩子侧无感
      enableFiller();
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      let mainAttempts = 0;
      llm.completeStream.mockImplementation((opts: { scene: string }) => {
        if (opts.scene === "filler") {
          return makeStream(["嗯——"])();
        }
        mainAttempts += 1;
        return mainAttempts === 1
          ? failingStream(
              new LlmUpstreamError(
                "upstream_error",
                "ECONNRESET: socket hang up",
                true,
              ),
            )
          : makeStream(["正式", "答案"])();
      });
      const chunks = await collect(service.streamReply(boundRequest));
      // 主模型初次 + 一次重试（filler 不算在内）
      expect(
        llm.completeStream.mock.calls.filter(
          (call: Array<{ scene: string }>) => call[0].scene === "chat_main",
        ),
      ).toHaveLength(2);
      expect(chunks).toEqual(["嗯——", "正式", "答案"]);
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.status).toBe("completed");
    });

    it("重试仍失败才播兜底，且最多重试一次", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      const err = new LlmUpstreamError("timeout", "timeout of 30000ms", true);
      llm.completeStream
        .mockReturnValueOnce(failingStream(err))
        .mockReturnValueOnce(failingStream(err));
      const chunks = await collect(service.streamReply(boundRequest));
      expect(llm.completeStream).toHaveBeenCalledTimes(2); // 初次 + 一次重试，有上限
      expect(chunks).toEqual([FALLBACK]);
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.status).toBe("failed");
    });

    it("不可重试的上游失败（4xx）不重试，直接兜底", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(
        failingStream(
          new LlmUpstreamError(
            "upstream_error",
            "HTTP 400: bad request",
            false,
          ),
        ),
      );
      const chunks = await collect(service.streamReply(boundRequest));
      expect(llm.completeStream).toHaveBeenCalledTimes(1);
      expect(chunks).toEqual([FALLBACK]);
    });

    it("主模型流正常结束但零内容（empty_response）时也播兜底", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(makeStream([])());
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual([FALLBACK]);
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.status).toBe("failed");
    });

    it("兜底话术按设备 characterKey 解析，角色文案未上线前回落 Elly 默认", async () => {
      // 为 Polly 等后续批次预留：映射表只有 elly，polly 命中默认值
      prisma.device.findFirst.mockResolvedValue({
        ...deviceRow,
        characterKey: "polly",
      });
      llm.completeStream.mockReturnValue(
        failingStream(
          new LlmUpstreamError("upstream_error", "ECONNRESET: reset", false),
        ),
      );
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual([FALLBACK]);
    });
  });

  describe("parseChatCompletionRequest", () => {
    it("accepts a minimal valid request", () => {
      const result = parseChatCompletionRequest({
        model: "deda-english-tutor",
        messages: [{ role: "user", content: "hello" }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.stream).toBe(false);
        expect(result.value.model).toBe("deda-english-tutor");
      }
    });

    it("tolerates unknown fields injected via llm_eb", () => {
      const result = parseChatCompletionRequest({
        messages: [{ role: "user", content: "hello" }],
        thinking: { type: "disabled" },
        user: "deda-toy",
        stream: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.stream).toBe(true);
    });

    it("captures the OpenAI user field as device hint", () => {
      const result = parseChatCompletionRequest({
        messages: [{ role: "user", content: "hello" }],
        user: "AA:BB:CC:DD:EE:FF",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.user).toBe("AA:BB:CC:DD:EE:FF");
    });

    it("captures deviceid injected via llm_eb as device hint", () => {
      const result = parseChatCompletionRequest({
        messages: [{ role: "user", content: "hello" }],
        deviceid: "9c230cb5d3d4",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.deviceid).toBe("9c230cb5d3d4");
    });

    it("leaves deviceid undefined when absent, not a string, or blank", () => {
      const absent = parseChatCompletionRequest({
        messages: [{ role: "user", content: "hello" }],
      });
      expect(absent.ok && absent.value.deviceid).toBeUndefined();
      const nonString = parseChatCompletionRequest({
        messages: [{ role: "user", content: "hello" }],
        deviceid: 42,
      });
      expect(nonString.ok && nonString.value.deviceid).toBeUndefined();
      const blank = parseChatCompletionRequest({
        messages: [{ role: "user", content: "hello" }],
        deviceid: "   ",
      });
      expect(blank.ok && blank.value.deviceid).toBeUndefined();
    });

    it("leaves user undefined when absent or not a string", () => {
      const absent = parseChatCompletionRequest({
        messages: [{ role: "user", content: "hello" }],
      });
      expect(absent.ok && absent.value.user).toBeUndefined();
      const nonString = parseChatCompletionRequest({
        messages: [{ role: "user", content: "hello" }],
        user: 42,
      });
      expect(nonString.ok && nonString.value.user).toBeUndefined();
    });

    it("rejects non-object body", () => {
      expect(parseChatCompletionRequest(null).ok).toBe(false);
      expect(parseChatCompletionRequest("x").ok).toBe(false);
    });

    it("rejects missing or empty messages", () => {
      expect(parseChatCompletionRequest({}).ok).toBe(false);
      expect(parseChatCompletionRequest({ messages: [] }).ok).toBe(false);
    });

    it("rejects messages without any user message", () => {
      const result = parseChatCompletionRequest({
        messages: [{ role: "system", content: "sys" }],
      });
      expect(result.ok).toBe(false);
    });

    it("rejects malformed message entries", () => {
      const result = parseChatCompletionRequest({
        messages: [{ role: "user" }],
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("validateToken", () => {
    it("returns true for the correct bearer token", () => {
      expect(service.validateToken(`Bearer ${VALID_TOKEN}`)).toBe(true);
    });

    it("returns false for missing header, wrong scheme, wrong token", () => {
      expect(service.validateToken(undefined)).toBe(false);
      expect(service.validateToken("Basic abc")).toBe(false);
      expect(service.validateToken("Bearer wrong")).toBe(false);
      expect(service.validateToken(`Bearer ${VALID_TOKEN}-suffix`)).toBe(false);
    });
  });

  describe("streamReply", () => {
    const request: ChatCompletionRequest = {
      model: "deda-english-tutor",
      stream: true,
      messages: [{ role: "user", content: "I like apples" }],
    };

    const collect = async (gen: AsyncGenerator<string>): Promise<string[]> => {
      const out: string[] = [];
      for await (const c of gen) out.push(c);
      return out;
    };

    it("streams upstream chunks for a normal request", async () => {
      llm.completeStream.mockReturnValue(makeStream(["Nice", " job!"])());
      const chunks = await collect(service.streamReply(request));
      expect(chunks).toEqual(["Nice", " job!"]);
      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "I like apples",
        [],
        expect.objectContaining({ mode: "free_chat" }),
      );
    });

    it("passes upstream thinking-disabled and keeps baidu system message first", async () => {
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      const req: ChatCompletionRequest = {
        ...request,
        messages: [
          { role: "system", content: "baidu-persona" },
          { role: "user", content: "hi" },
        ],
      };
      await collect(service.streamReply(req));
      const callArgs = llm.completeStream.mock.calls[0][0];
      expect(callArgs.thinking).toEqual({ type: "disabled" });
      expect(callArgs.messages[0]).toEqual({
        role: "system",
        content: "baidu-persona",
      });
      expect(callArgs.messages[1]).toEqual({
        role: "system",
        content: "built-system",
      });
    });

    it("maps prior turns into history excluding the last user message", async () => {
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      const req: ChatCompletionRequest = {
        ...request,
        messages: [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" },
        ],
      };
      await collect(service.streamReply(req));
      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "u2",
        [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
        ],
        expect.objectContaining({ mode: "free_chat" }),
      );
    });

    it("returns canned reply without calling upstream when L1 blocks", async () => {
      childSafety.checkL1.mockReturnValue({
        blocked: true,
        category: "violence",
        layer: "L1",
        matched: "x",
      });
      const chunks = await collect(service.streamReply(request));
      expect(chunks).toEqual(["这个话题不适合小朋友聊哦。"]);
      expect(childSafety.cannedReply).toHaveBeenCalledWith("violence");
      expect(llm.completeStream).not.toHaveBeenCalled();
    });

    it("runs L2 after L1 pass and blocks on L2 verdict without upstream call", async () => {
      childSafety.classifyL2.mockResolvedValue({
        blocked: true,
        category: "self_harm",
        layer: "L2",
      });
      const chunks = await collect(service.streamReply(request));
      expect(childSafety.classifyL2).toHaveBeenCalledWith(
        "I like apples",
        undefined,
        expect.any(String),
      );
      expect(chunks).toEqual(["这个话题不适合小朋友聊哦。"]);
      expect(childSafety.cannedReply).toHaveBeenCalledWith("self_harm");
      expect(llm.completeStream).not.toHaveBeenCalled();
    });

    it("injects emotional_harm guidance system message without blocking", async () => {
      childSafety.classifyL2.mockResolvedValue({
        blocked: false,
        category: "emotional_harm",
        layer: "L2",
      });
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      const chunks = await collect(service.streamReply(request));
      expect(chunks).toEqual(["ok"]);
      const callArgs = llm.completeStream.mock.calls[0][0];
      const systemContents = callArgs.messages
        .filter((m: { role: string }) => m.role === "system")
        .map((m: { content: string }) => m.content);
      expect(systemContents.some((c: string) => c.includes("共情"))).toBe(true);
    });

    it("fails open when L2 classification throws", async () => {
      childSafety.classifyL2.mockRejectedValue(new Error("small model down"));
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      const chunks = await collect(service.streamReply(request));
      expect(chunks).toEqual(["ok"]);
    });

    it("returns fallback sentence when upstream fails before first chunk", async () => {
      llm.completeStream.mockImplementation(async function* () {
        throw new Error("upstream down");
      });
      const chunks = await collect(service.streamReply(request));
      expect(chunks.length).toBe(1);
      expect(chunks[0].length).toBeGreaterThan(0);
    });

    it("stops silently when upstream fails mid-stream", async () => {
      llm.completeStream.mockImplementation(async function* () {
        yield "partial";
        throw new Error("mid-stream failure");
      });
      const chunks = await collect(service.streamReply(request));
      expect(chunks).toEqual(["partial"]);
    });

    it("throws BadRequest when streamReply gets no user message", async () => {
      const bad: ChatCompletionRequest = {
        model: "m",
        stream: true,
        messages: [{ role: "system", content: "only-system" }],
      };
      await expect(collect(service.streamReply(bad))).rejects.toThrow(
        "user message",
      );
    });
  });

  describe("device-bound behavior (2A)", () => {
    const deviceRow = { id: "dev-internal-1", deviceId: "dev-1001" };
    const boundRequest: ChatCompletionRequest = {
      model: "deda-english-tutor",
      stream: true,
      user: "dev-1001",
      messages: [{ role: "user", content: "hello deda" }],
    };

    const collect = async (gen: AsyncGenerator<string>): Promise<string[]> => {
      const out: string[] = [];
      for await (const c of gen) out.push(c);
      return out;
    };

    it("resolves device by deviceId and persists user before upstream, assistant after", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(makeStream(["Hi", " there"])());
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual(["Hi", " there"]);

      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      const userCall = prisma.message.create.mock.calls[0][0];
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(userCall.data).toMatchObject({
        deviceId: "dev-internal-1",
        role: "user",
        content: "hello deda",
        mode: "free_chat",
      });
      // user 落库必须先于上游调用，LLM 故障也不丢孩子的话
      expect(prisma.message.create.mock.invocationCallOrder[0]).toBeLessThan(
        llm.completeStream.mock.invocationCallOrder[0],
      );
      expect(assistantCall.data).toMatchObject({
        deviceId: "dev-internal-1",
        role: "assistant",
        content: "Hi there",
        status: "completed",
        mode: "free_chat",
      });
      expect(assistantCall.data.turnId).toBe(userCall.data.turnId);
      expect(assistantCall.data.rawPayload).toEqual({
        filler: null,
        answer: "Hi there",
      });
    });

    it("新一轮开始时对上一轮 assistant 回复做打断推断（fire-and-forget）", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      // 上一轮 assistant 回复 100 字、2 秒前发出 → 仍在估算播放窗口内
      prisma.message.findFirst.mockResolvedValue({
        id: "prev-assistant",
        content: "啊".repeat(100),
        spokeAt: new Date(Date.now() - 2000),
      });
      llm.completeStream.mockReturnValue(makeStream(["ok"])());

      await collect(service.streamReply(boundRequest));
      // fire-and-forget：等微任务/IO 队列排空再断言
      await new Promise((resolve) => setImmediate(resolve));

      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: {
          deviceId: "dev-internal-1",
          role: "assistant",
          status: "completed",
        },
        orderBy: { spokeAt: "desc" },
        select: { id: true, content: true, spokeAt: true },
      });
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: "prev-assistant" },
        data: { status: "interrupted" },
      });
    });

    it("匿名链路不做打断推断", async () => {
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      await collect(
        service.streamReply({
          model: "m",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      );
      expect(prisma.message.findFirst).not.toHaveBeenCalled();
    });

    it("creates the device when the hint is unknown", async () => {
      prisma.device.findFirst.mockResolvedValue(null);
      prisma.device.create.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      await collect(service.streamReply(boundRequest));
      expect(prisma.device.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ deviceId: "dev-1001" }),
      });
    });

    it("creates MAC-like devices with the normalized lowercase id", async () => {
      prisma.device.findFirst.mockResolvedValue(null);
      prisma.device.create.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      const req: ChatCompletionRequest = {
        ...boundRequest,
        user: "AA:BB:CC:DD:EE:FF",
      };
      await collect(service.streamReply(req));
      // 与 client-api loginMac 建档口径一致：MAC 形态一律归一化小写
      expect(prisma.device.create).toHaveBeenCalledWith({
        data: { deviceId: "aabbccddeeff", macAddress: "aabbccddeeff" },
      });
    });

    it("matches MAC-like hints case/separator-insensitively", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      const req: ChatCompletionRequest = {
        ...boundRequest,
        user: "AA:BB:CC:DD:EE:FF",
      };
      await collect(service.streamReply(req));
      const where = prisma.device.findFirst.mock.calls[0][0].where;
      const flat = JSON.stringify(where);
      expect(flat).toContain("aabbccddeeff");
      expect(flat).toContain("AA:BB:CC:DD:EE:FF");
    });

    it("prefers the explicit header over the user field", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      await collect(service.streamReply(boundRequest, "dev-header-9"));
      const where = prisma.device.findFirst.mock.calls[0][0];
      expect(JSON.stringify(where)).toContain("dev-header-9");
      expect(JSON.stringify(where)).not.toContain("dev-1001");
    });

    it("resolves device by the deviceid field and persists messages", async () => {
      prisma.device.findFirst.mockResolvedValue({
        id: "dev-internal-2",
        deviceId: "9c230cb5d3d4",
      });
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      const req: ChatCompletionRequest = {
        model: "deda-english-tutor",
        stream: true,
        deviceid: "9c230cb5d3d4",
        messages: [{ role: "user", content: "hello deda" }],
      };
      await collect(service.streamReply(req));
      const where = prisma.device.findFirst.mock.calls[0][0];
      expect(JSON.stringify(where)).toContain("9c230cb5d3d4");
      // 非匿名链路：消息正常落库
      expect(prisma.message.create).toHaveBeenCalled();
      expect(prisma.message.create.mock.calls[0][0].data.deviceId).toBe(
        "dev-internal-2",
      );
    });

    it("prefers deviceid over the legacy user field", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      const req: ChatCompletionRequest = {
        ...boundRequest,
        deviceid: "9c230cb5d3d4",
        user: "legacy-mac-user",
      };
      await collect(service.streamReply(req));
      const where = prisma.device.findFirst.mock.calls[0][0];
      expect(JSON.stringify(where)).toContain("9c230cb5d3d4");
      expect(JSON.stringify(where)).not.toContain("legacy-mac-user");
    });

    it("passes the device characterKey into the main prompt builder", async () => {
      prisma.device.findFirst.mockResolvedValue({
        ...deviceRow,
        characterKey: "polly",
      });
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      await collect(service.streamReply(boundRequest));
      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "hello deda",
        expect.any(Array),
        expect.objectContaining({ characterKey: "polly" }),
      );
    });

    it("passes adventureDeclined context to the filler when the gate blocks entry", async () => {
      // 显式开启 filler（生产默认开，测试默认关）
      configGet.mockImplementation((key: string) =>
        key === "LLM_ADAPTER_API_KEY" ? VALID_TOKEN : undefined,
      );
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "adventure_story",
        source: "model",
      });
      adventure.isCompletedToday.mockResolvedValue(true);
      llm.completeStream.mockImplementation((opts: { scene: string }) =>
        opts.scene === "filler"
          ? makeStream(["嗯——"])()
          : makeStream(["今天冒险完成啦"])(),
      );
      const req: ChatCompletionRequest = {
        ...boundRequest,
        messages: [{ role: "user", content: "继续冒险故事" }],
      };
      await collect(service.streamReply(req));
      expect(llm.buildFillerPrompt).toHaveBeenCalledWith(
        "继续冒险故事",
        expect.any(Array),
        expect.objectContaining({
          intent: "adventure_story",
          adventureDeclined: true,
        }),
      );
    });

    it("passes the character persona to the filler for identity consistency", async () => {
      configGet.mockImplementation((key: string) =>
        key === "LLM_ADAPTER_API_KEY" ? VALID_TOKEN : undefined,
      );
      prisma.device.findFirst.mockResolvedValue({
        ...deviceRow,
        characterKey: "polly",
      });
      llm.completeStream.mockImplementation((opts: { scene: string }) =>
        opts.scene === "filler"
          ? makeStream(["画小猫听起来真棒呀"])()
          : makeStream(["画得真好"])(),
      );
      const req: ChatCompletionRequest = {
        ...boundRequest,
        messages: [{ role: "user", content: "我今天画了一只小猫" }],
      };
      await collect(service.streamReply(req));
      expect(llm.buildFillerPrompt).toHaveBeenCalledWith(
        "我今天画了一只小猫",
        expect.any(Array),
        expect.objectContaining({
          persona: expect.stringContaining("小马 Polly"),
        }),
      );
    });

    it("孩子档案（含性别）传主模型，精简摘要传 filler", async () => {
      configGet.mockImplementation((key: string) =>
        key === "LLM_ADAPTER_API_KEY" ? VALID_TOKEN : undefined,
      );
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      prisma.childProfile.findUnique.mockResolvedValue({
        id: "cp-1",
        userId: "u-1",
        deviceId: "dev-internal-1",
        name: "莉莉",
        englishName: "Lily",
        birthday: "2020-06-01",
        gender: "female",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      llm.completeStream.mockImplementation((opts: { scene: string }) =>
        opts.scene === "filler"
          ? makeStream(["你好呀你在做什么呢"])()
          : makeStream(["Hi Lily"])(),
      );

      await collect(service.streamReply(boundRequest));

      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          childProfile: {
            name: "莉莉",
            birthday: "2020-06-01",
            englishName: "Lily",
            gender: "female",
          },
        }),
      );
      expect(llm.buildFillerPrompt).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          childBrief: expect.stringContaining("名叫 Lily"),
        }),
      );
    });

    it("raises main-stream maxTokens to 800 for story turns", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "idiom_story",
        source: "model",
      });
      llm.completeStream.mockReturnValue(makeStream(["从前有只小青蛙"])());
      const req: ChatCompletionRequest = {
        ...boundRequest,
        messages: [{ role: "user", content: "讲一个成语故事" }],
      };
      await collect(service.streamReply(req));
      expect(llm.completeStream).toHaveBeenCalledWith(
        expect.objectContaining({ scene: "chat_main", maxTokens: 800 }),
      );
    });

    it("keeps main-stream maxTokens at 200 for free chat turns", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      await collect(service.streamReply(boundRequest));
      expect(llm.completeStream).toHaveBeenCalledWith(
        expect.objectContaining({ scene: "chat_main", maxTokens: 200 }),
      );
    });

    it("uses DB history instead of client-supplied history when bound", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      prisma.message.findMany.mockResolvedValue([
        {
          role: "assistant",
          content: "db-a1-full",
          rawPayload: { filler: "f1", answer: "db-a1" },
        },
        { role: "user", content: "db-u1", rawPayload: null },
      ]);
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      const req: ChatCompletionRequest = {
        ...boundRequest,
        messages: [
          { role: "user", content: "client-u1" },
          { role: "assistant", content: "client-a1" },
          { role: "user", content: "hello deda" },
        ],
      };
      await collect(service.streamReply(req));
      // findMany 返回时间倒序，service 应翻转为正序且剥离 filler
      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "hello deda",
        [
          { role: "user", content: "db-u1" },
          { role: "assistant", content: "db-a1" },
        ],
        expect.objectContaining({ mode: "free_chat" }),
      );
    });

    it("injects the memory prompt block and marks injected on success", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      memories.buildPromptBlock.mockResolvedValue({
        text: "MEMBLOCK",
        memoryIds: ["m1", "m2"],
      });
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      await collect(service.streamReply(boundRequest));
      expect(memories.buildPromptBlock).toHaveBeenCalledWith(
        "dev-internal-1",
        [],
      );
      const callArgs = llm.completeStream.mock.calls[0][0];
      // 记忆块贴尾注入：位于本轮 user 之前，保住头部前缀缓存
      expect(callArgs.messages[callArgs.messages.length - 2]).toEqual({
        role: "system",
        content: "MEMBLOCK",
      });
      expect(callArgs.messages[callArgs.messages.length - 1]).toEqual({
        role: "user",
        content: "hello deda",
      });
      expect(memories.markInjected).toHaveBeenCalledWith(["m1", "m2"]);
    });

    it("同一轮 turnId 贯穿 safety_l2 / intent / chat_main / filler 与消息落库", async () => {
      // 实机事故：staging 仅 memory_extract 有 turnId，dashboard 按轮次
      // 只能捞出一条调用记录。turnId 必须在 L2/意图分类前生成并全程贯穿。
      configGet.mockImplementation((key: string) =>
        key === "LLM_ADAPTER_API_KEY" ? VALID_TOKEN : undefined,
      );
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(makeStream(["ok"])());

      await collect(service.streamReply(boundRequest));

      const turnId = prisma.message.create.mock.calls[0][0].data.turnId;
      expect(turnId).toBeTruthy();
      expect(childSafety.classifyL2).toHaveBeenCalledWith(
        expect.any(String),
        "dev-internal-1",
        turnId,
      );
      expect(session.resolveWithSource).toHaveBeenCalledWith(
        "dev-internal-1",
        expect.any(String),
        turnId,
      );
      for (const call of llm.completeStream.mock.calls) {
        expect(call[0].turnId).toBe(turnId);
      }
      for (const call of llm.complete.mock.calls) {
        expect(call[0].turnId).toBe(turnId);
      }
      expect(memories.extractAndStore).toHaveBeenCalledWith(
        expect.objectContaining({ turnId }),
      );
    });

    it("extracts memories asynchronously with the previous assistant turn", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      prisma.message.findMany.mockResolvedValue([
        {
          role: "assistant",
          content: "prev-full",
          rawPayload: { filler: null, answer: "prev-answer" },
        },
      ]);
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      await collect(service.streamReply(boundRequest));
      expect(memories.extractAndStore).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: "dev-internal-1",
          asrText: "hello deda",
          previousAssistant: "prev-answer",
        }),
      );
    });

    it("persists the safety pair on L1 block without calling upstream", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      childSafety.checkL1.mockReturnValue({
        blocked: true,
        category: "violence",
        layer: "L1",
        matched: "x",
      });
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual(["这个话题不适合小朋友聊哦。"]);
      expect(llm.completeStream).not.toHaveBeenCalled();
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.rawPayload).toMatchObject({
        safetyCategory: "violence",
        safetyLayer: "L1",
      });
    });

    it("marks assistant failed when the upstream fails before first chunk", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockImplementation(async function* () {
        throw new Error("upstream down");
      });
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks.length).toBe(1);
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.status).toBe("failed");
      expect(memories.markInjected).not.toHaveBeenCalled();
    });

    it("never touches prisma when anonymous", async () => {
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      await collect(
        service.streamReply({
          model: "m",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      );
      expect(prisma.device.findFirst).not.toHaveBeenCalled();
      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(memories.buildPromptBlock).not.toHaveBeenCalled();
      expect(memories.buildPreferenceBlock).not.toHaveBeenCalled();
      expect(memories.extractAndStore).not.toHaveBeenCalled();
    });
  });

  describe("service without configured api key", () => {
    it("rejects every token when LLM_ADAPTER_API_KEY is unset", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PROMPT_REGISTRY_PROVIDER,
          LlmAdapterService,
          { provide: LlmService, useValue: llm },
          { provide: ChildSafetyService, useValue: childSafety },
          { provide: ChildMemoriesService, useValue: memories },
          { provide: ConversationSessionService, useValue: session },
          { provide: SleepVoiceConfigService, useValue: sleepVoice },
          { provide: SleepConfigsService, useValue: sleepConfigs },
          { provide: AdventureService, useValue: adventure },
          { provide: PrismaService, useValue: prisma },
          { provide: TurnDecisionRecorder, useValue: turnDecisions },
          { provide: ConfigService, useValue: { get: () => undefined } },
        ],
      }).compile();
      const noKeyService = module.get(LlmAdapterService);
      expect(noKeyService.validateToken(`Bearer ${VALID_TOKEN}`)).toBe(false);
    });
  });

  describe("OpenAiExceptionFilter", () => {
    it("maps non-http exceptions to 500 server_error", () => {
      const res = {
        statusCode: 200,
        jsonBody: undefined as unknown,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(obj: unknown) {
          this.jsonBody = obj;
          return this;
        },
      };
      const host = {
        switchToHttp: () => ({ getResponse: () => res }),
      } as Parameters<OpenAiExceptionFilter["catch"]>[1];
      new OpenAiExceptionFilter().catch(new Error("boom"), host);
      expect(res.statusCode).toBe(500);
      expect(res.jsonBody).toMatchObject({
        error: { type: "server_error", message: "Internal server error" },
      });
    });
  });

  describe("controller", () => {
    interface FakeResponse {
      headers: Record<string, string>;
      body: string;
      statusCode: number;
      jsonBody: unknown;
      setHeader(k: string, v: string): void;
      write(s: string): void;
      end(): void;
      status(code: number): FakeResponse;
      json(obj: unknown): FakeResponse;
    }

    const makeRes = (): FakeResponse => ({
      headers: {},
      body: "",
      statusCode: 200,
      jsonBody: undefined,
      setHeader(k, v) {
        this.headers[k] = v;
      },
      write(s) {
        this.body += s;
      },
      end() {
        return;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(obj) {
        this.jsonBody = obj;
        return this;
      },
    });

    interface FakeRequest {
      headers: Record<string, string>;
      body: unknown;
    }

    const makeReq = (body: unknown, auth?: string): FakeRequest => ({
      headers: auth ? { authorization: auth } : {},
      body,
    });

    /**
     * 直接调用控制器方法时 Nest 不会走过滤器管线，
     * 手动把抛出的异常送进 OpenAiExceptionFilter，模拟真实组合行为。
     */
    const callController = async (
      req: FakeRequest,
      res: FakeResponse,
    ): Promise<void> => {
      const filter = new OpenAiExceptionFilter();
      const host = {
        switchToHttp: () => ({ getResponse: () => res }),
      } as Parameters<OpenAiExceptionFilter["catch"]>[1];
      try {
        await controller.chatCompletions(req as never, res as never);
      } catch (err) {
        filter.catch(err, host);
      }
    };

    it("rejects with OpenAI-style 401 when token is wrong", async () => {
      const res = makeRes();
      await callController(
        makeReq({ messages: [{ role: "user", content: "hi" }] }, "Bearer no"),
        res,
      );
      expect(res.statusCode).toBe(401);
      expect(res.jsonBody).toMatchObject({
        error: { type: "authentication_error" },
      });
    });

    it("rejects with OpenAI-style 400 on invalid body", async () => {
      const res = makeRes();
      await callController(
        makeReq({ messages: [] }, `Bearer ${VALID_TOKEN}`),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(res.jsonBody).toMatchObject({
        error: { type: "invalid_request_error" },
      });
    });

    it("forwards the x-deda-device-id header to the service", async () => {
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      const spy = jest.spyOn(service, "streamReply");
      const res = makeRes();
      const req = makeReq(
        {
          model: "deda-english-tutor",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        },
        `Bearer ${VALID_TOKEN}`,
      );
      req.headers["x-deda-device-id"] = "dev-header-9";
      await callController(req, res);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ stream: true }),
        "dev-header-9",
      );
    });

    it("returns aggregated JSON for non-stream requests", async () => {
      llm.completeStream.mockReturnValue(makeStream(["Hello", " there"])());
      const res = makeRes();
      await callController(
        makeReq(
          {
            model: "deda-english-tutor",
            messages: [{ role: "user", content: "hi" }],
          },
          `Bearer ${VALID_TOKEN}`,
        ),
        res,
      );
      expect(res.jsonBody).toMatchObject({
        object: "chat.completion",
        model: "deda-english-tutor",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello there" },
            finish_reason: "stop",
          },
        ],
      });
    });

    it("writes OpenAI SSE frames terminated by [DONE] for stream requests", async () => {
      llm.completeStream.mockReturnValue(makeStream(["Hi", "!"])());
      const res = makeRes();
      await callController(
        makeReq(
          {
            model: "deda-english-tutor",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          },
          `Bearer ${VALID_TOKEN}`,
        ),
        res,
      );
      expect(res.headers["Content-Type"]).toBe("text/event-stream");
      const frames = res.body
        .split("\n\n")
        .filter((f: string) => f.startsWith("data: "));
      expect(frames[frames.length - 1]).toBe("data: [DONE]");
      interface SseChunk {
        choices: Array<{
          delta: { role?: string; content?: string };
          finish_reason: string | null;
        }>;
        object: string;
        model: string;
      }
      const parseFrame = (f: string) => JSON.parse(f.slice(6)) as SseChunk;
      const first = parseFrame(frames[0]);
      expect(first.object).toBe("chat.completion.chunk");
      expect(first.model).toBe("deda-english-tutor");
      const contentChunks = frames
        .slice(0, -1)
        .map(parseFrame)
        .map((c) => c.choices[0].delta.content || "")
        .join("");
      expect(contentChunks).toBe("Hi!");
      const lastChunk = parseFrame(frames[frames.length - 2]);
      expect(lastChunk.choices[0].finish_reason).toBe("stop");
    });
  });

  /**
   * 判定审计埋点：每个编排出口都必须恰好落一条 turn_decision_logs，
   * 且「未评估 / 未路由 / 无设备」不能被伪装成「模型判 safe」或「free_chat」。
   * 这是安全看板可信度的地基——分母错了，拦截率和漏放率都是假数字。
   */
  describe("判定审计埋点（turn_decision_logs）", () => {
    const deviceRow = { id: "dev-internal-1", deviceId: "dev-1001" };
    const boundReq = (content: string): ChatCompletionRequest => ({
      model: "deda-english-tutor",
      stream: true,
      user: "dev-1001",
      messages: [{ role: "user", content }],
    });

    const collect = async (gen: AsyncGenerator<string>): Promise<string[]> => {
      const out: string[] = [];
      for await (const c of gen) out.push(c);
      return out;
    };

    /** 硬断言：一轮恰好一条判定记录，多写会让重试灌水，少写会漏掉盲区 */
    const recorded = () => {
      expect(turnDecisions.record).toHaveBeenCalledTimes(1);
      return turnDecisions.record.mock.calls[0][0];
    };

    it("L1 拦截：记 l1_regex + 命中词，intent 记 not_routed 而非 free_chat", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      childSafety.checkL1.mockReturnValue({
        blocked: true,
        category: "sexual",
        layer: "L1",
        source: "l1_regex",
        matched: "色情",
      });

      await collect(service.streamReply(boundReq("假数据-敏感表达")));

      const entry = recorded();
      expect(entry.safety).toMatchObject({
        blocked: true,
        category: "sexual",
        layer: "L1",
        source: "l1_regex",
        matched: "色情",
      });
      expect(entry).toMatchObject({
        deviceId: "dev-internal-1",
        intent: null,
        intentSource: "not_routed",
        asrText: "假数据-敏感表达",
      });
      expect(llm.completeStream).not.toHaveBeenCalled();
    });

    it("冒险接管：safety 记 not_evaluated、intent 记 adventure_takeover（盲区如实暴露）", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      adventure.handleChildReply.mockResolvedValue({
        texts: ["段落一"],
        action: "await_reply",
      });

      await collect(service.streamReply(boundReq("我选第一个")));

      expect(recorded()).toMatchObject({
        deviceId: "dev-internal-1",
        safety: null,
        safetySource: "not_evaluated",
        intent: null,
        intentSource: "adventure_takeover",
      });
      expect(childSafety.classifyL2).not.toHaveBeenCalled();
    });

    it("L2 拦截：记 l2_model 与类别，intent 记 not_routed，原话交给 recorder 判定是否留存", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      childSafety.classifyL2.mockResolvedValue({
        blocked: true,
        category: "violence",
        layer: "L2",
        source: "l2_model",
      });

      await collect(service.streamReply(boundReq("假数据-暴力表达")));

      const entry = recorded();
      expect(entry.safety).toMatchObject({
        blocked: true,
        category: "violence",
        layer: "L2",
        source: "l2_model",
      });
      expect(entry.intent).toBeNull();
      expect(entry.intentSource).toBe("not_routed");
      expect(entry.asrText).toBe("假数据-暴力表达");
    });

    it("L2 包装层异常（连 verdict 都没拿到）：记 l2_fail_open 而非 not_evaluated", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      childSafety.classifyL2.mockRejectedValue(new Error("small model down"));
      llm.completeStream.mockReturnValue(makeStream(["嗯，我在听"])());

      await collect(service.streamReply(boundReq("今天想聊什么")));

      expect(recorded()).toMatchObject({
        safety: null,
        safetySource: "l2_fail_open",
        intent: "free_chat",
        intentSource: "model",
      });
    });

    it("哄睡设置短链路：intent 记 sleep_config 并透传会话服务给出的 source", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "sleep_config",
        source: "fallback_invalid_label",
      });

      await collect(service.streamReply(boundReq("以后睡前都听儿歌")));

      expect(recorded()).toMatchObject({
        intent: "sleep_config",
        intentSource: "fallback_invalid_label",
      });
      expect(llm.completeStream).not.toHaveBeenCalled();
    });

    it("强制哄睡覆写：intentSource 记 force_sleep，可与模型判定分桶", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "sleep_story",
        source: "force_sleep",
      });
      llm.completeStream.mockReturnValue(makeStream(["晚安故事来了"])());

      await collect(service.streamReply(boundReq("今天幼儿园玩了滑梯")));

      expect(recorded()).toMatchObject({
        intent: "sleep_story",
        intentSource: "force_sleep",
      });
    });

    it("哄睡时段门禁：intentSource 记 sleep_window_closed，intent 记降级后的 free_chat", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "free_chat",
        source: "sleep_window_closed",
      });
      llm.completeStream.mockReturnValue(makeStream(["有点困啦？"])());

      await collect(service.streamReply(boundReq("我困了")));

      expect(recorded()).toMatchObject({
        intent: "free_chat",
        intentSource: "sleep_window_closed",
      });
    });

    it("意图路由后进入冒险：本轮 L2 已评估，判定照落", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockResolvedValue({
        intent: "adventure_story",
        source: "model",
      });
      adventure.startToday.mockResolvedValue({
        texts: ["冒险开场"],
        action: "narrate",
      });

      await collect(service.streamReply(boundReq("我想玩每日冒险")));

      const entry = recorded();
      expect(entry).toMatchObject({
        intent: "adventure_story",
        intentSource: "model",
      });
      expect(entry.safety).toMatchObject({ layer: "L2", source: "l2_model" });
    });

    it("主链路正常完成：turnId 与 assistant 消息同轮，可按轮次串起判定与用量", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(makeStream(["你好呀"])());

      await collect(service.streamReply(boundReq("你好")));

      const entry = recorded();
      expect(entry).toMatchObject({
        intent: "free_chat",
        intentSource: "model",
        asrText: "你好",
      });
      const assistantCall = prisma.message.create.mock.calls.at(-1)![0];
      expect(assistantCall.data.role).toBe("assistant");
      expect(entry.turnId).toBe(assistantCall.data.turnId);
      expect(typeof entry.turnId).toBe("string");
    });

    it("主模型失败走兜底话术：判定照落（判定质量与主模型成败无关）", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream.mockImplementation(() => {
        throw new LlmUpstreamError("upstream_error", "HTTP 500", false);
      });

      const chunks = await collect(service.streamReply(boundReq("你好")));

      expect(chunks.length).toBeGreaterThan(0);
      expect(recorded()).toMatchObject({
        intent: "free_chat",
        intentSource: "model",
      });
    });

    it("意图解析异常降级：intentSource 记 fallback_error，不伪装成模型判定", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolveWithSource.mockRejectedValue(new Error("session db down"));
      llm.completeStream.mockReturnValue(makeStream(["嗯"])());

      await collect(service.streamReply(boundReq("我想听英语故事")));

      expect(recorded()).toMatchObject({
        intent: "free_chat",
        intentSource: "fallback_error",
      });
    });

    it("匿名链路（请求不带设备标识）：deviceId 落 null，intentSource 记 no_device", async () => {
      llm.completeStream.mockReturnValue(makeStream(["你好呀"])());

      await collect(
        service.streamReply({
          model: "deda-english-tutor",
          stream: true,
          messages: [{ role: "user", content: "你好" }],
        }),
      );

      expect(recorded()).toMatchObject({
        deviceId: null,
        intent: "free_chat",
        intentSource: "no_device",
      });
    });
  });
});
