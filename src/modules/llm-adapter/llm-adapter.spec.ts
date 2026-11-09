import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { LlmAdapterService } from "./llm-adapter.service";
import { LlmAdapterController } from "./llm-adapter.controller";
import {
  parseChatCompletionRequest,
  ChatCompletionRequest,
} from "./dto/chat-completion.dto";
import { LlmService } from "@/modules/llm/llm.service";
import { ChildSafetyService } from "@/modules/vendor/child-safety.service";
import { ChildMemoriesService } from "@/modules/child-memories/child-memories.service";
import { ConversationSessionService } from "@/modules/vendor/conversation-session.service";
import { SleepVoiceConfigService } from "@/modules/sleep-configs/sleep-voice-config.service";
import { SleepConfigsService } from "@/modules/sleep-configs/sleep-configs.service";
import { AdventureService } from "@/modules/adventure/adventure.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { OpenAiExceptionFilter } from "./filters/openai-exception.filter";

const VALID_TOKEN = "test-adapter-key";

describe("LlmAdapterModule", () => {
  let service: LlmAdapterService;
  let controller: LlmAdapterController;
  let llm: {
    buildEnglishTutorPrompt: jest.Mock;
    buildFillerPrompt: jest.Mock;
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
    message: { create: jest.Mock; findMany: jest.Mock };
    deviceConfig: { findFirst: jest.Mock };
    childProfile: { findUnique: jest.Mock };
    conversationMode: { findFirst: jest.Mock };
  };
  let memories: {
    buildPromptBlock: jest.Mock;
    extractAndStore: jest.Mock;
    markInjected: jest.Mock;
  };
  let session: { resolve: jest.Mock; reset: jest.Mock };
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
      }),
      classifyL2: jest.fn().mockResolvedValue({
        blocked: false,
        category: null,
        layer: null,
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
      },
      deviceConfig: { findFirst: jest.fn().mockResolvedValue(null) },
      childProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      conversationMode: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    memories = {
      buildPromptBlock: jest
        .fn()
        .mockResolvedValue({ text: "", memoryIds: [] }),
      extractAndStore: jest.fn().mockResolvedValue(0),
      markInjected: jest.fn().mockResolvedValue(undefined),
    };
    session = {
      resolve: jest.fn().mockResolvedValue("free_chat"),
      reset: jest.fn().mockResolvedValue(undefined),
    };
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
        LlmAdapterService,
        { provide: LlmService, useValue: llm },
        { provide: ChildSafetyService, useValue: childSafety },
        { provide: ChildMemoriesService, useValue: memories },
        { provide: ConversationSessionService, useValue: session },
        { provide: SleepVoiceConfigService, useValue: sleepVoice },
        { provide: SleepConfigsService, useValue: sleepConfigs },
        { provide: AdventureService, useValue: adventure },
        { provide: PrismaService, useValue: prisma },
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
      session.resolve.mockResolvedValue("english_story");
      llm.completeStream.mockReturnValue(makeStream(["Once upon..."])());
      await collect(service.streamReply(boundRequest));
      expect(session.resolve).toHaveBeenCalledWith(
        "dev-internal-1",
        "讲一个英语故事",
      );
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.mode).toBe("english_story");
      // 历史按解析出的模式过滤，与老链路口径一致
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ mode: "english_story" }),
        }),
      );
      // 故事模式注入故事 prompt（经 promptTemplate 传给 prompt 组装），不注入长期记忆
      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "讲一个英语故事",
        expect.any(Array),
        expect.objectContaining({
          mode: "english_story",
          promptTemplate: expect.stringContaining("English story"),
        }),
      );
      expect(memories.buildPromptBlock).not.toHaveBeenCalled();
    });

    it("short-circuits sleep_config to a deterministic reply without the main LLM", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolve.mockResolvedValue("sleep_config");
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
      session.resolve.mockResolvedValue("sleep_story");
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

    it("routes free_story to free_chat mode with a no-adventure-promise prompt", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolve.mockResolvedValue("free_story");
      llm.completeStream.mockReturnValue(makeStream(["故事来了"])());
      await collect(service.streamReply(boundRequest));
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.mode).toBe("free_chat");
      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "讲一个英语故事",
        expect.any(Array),
        expect.objectContaining({
          promptTemplate: expect.stringContaining("不要承诺开始"),
        }),
      );
    });

    it("uses deviceConfig english_chat when intent is free_chat", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "english_chat",
        conversationModeKey: null,
      });
      session.resolve.mockResolvedValue("free_chat");
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

    it("applies the conversationMode prompt template for free_chat submodes", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "free_chat",
        conversationModeKey: "free_chat_casual",
      });
      prisma.conversationMode.findFirst.mockResolvedValue({
        promptTemplate: "SUBMODE-TPL",
      });
      session.resolve.mockResolvedValue("free_chat");
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      await collect(service.streamReply(boundRequest));
      expect(llm.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "讲一个英语故事",
        expect.any(Array),
        expect.objectContaining({
          promptTemplate: "SUBMODE-TPL",
        }),
      );
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.conversationModeKey).toBe("free_chat_casual");
    });

    it("degrades to free_chat when intent resolution throws", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolve.mockRejectedValue(new Error("session db down"));
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
      expect(session.resolve).not.toHaveBeenCalled();
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
      expect(session.resolve).not.toHaveBeenCalled();
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
      session.resolve.mockResolvedValue("adventure_story");
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
      session.resolve.mockResolvedValue("adventure_story");
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
    });

    it("falls back to free-story prompt when no episode is available", async () => {
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      session.resolve.mockResolvedValue("adventure_story");
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
    });

    it("streams filler before the answer and persists the boundary", async () => {
      // 显式开启 filler（生产默认开，测试默认关）
      configGet.mockImplementation((key: string) =>
        key === "LLM_ADAPTER_API_KEY" ? VALID_TOKEN : undefined,
      );
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream
        .mockImplementationOnce(() => makeStream(["正式", "答案"])()) // 主模型后台泵
        .mockImplementationOnce(() => makeStream(["嗯——"])()); // filler
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual(["嗯——", "正式", "答案"]);
      // 主模型先起后台泵（calls[0]），filler 小模型随后（calls[1]）；
      // 播报顺序由 drain 保证 filler 在前
      expect(llm.completeStream.mock.calls[1][0]).toMatchObject({
        model: "small-model",
        maxTokens: 60,
      });
      expect(llm.buildFillerPrompt).toHaveBeenCalledWith("我想玩每日冒险", []);
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.rawPayload).toEqual({
        filler: "嗯——",
        answer: "正式答案",
      });
      expect(assistantCall.data.content).toBe("嗯——\n正式答案");
    });

    it("skips filler silently when the filler stream fails", async () => {
      configGet.mockImplementation((key: string) =>
        key === "LLM_ADAPTER_API_KEY" ? VALID_TOKEN : undefined,
      );
      prisma.device.findFirst.mockResolvedValue(deviceRow);
      llm.completeStream
        .mockImplementationOnce(() => makeStream(["答案"])()) // 主模型后台泵
        .mockImplementationOnce(async function* () {
          throw new Error("small model down");
        }); // filler 失败
      const chunks = await collect(service.streamReply(boundRequest));
      expect(chunks).toEqual(["答案"]);
      const assistantCall = prisma.message.create.mock.calls[1][0];
      expect(assistantCall.data.rawPayload).toEqual({
        filler: null,
        answer: "答案",
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

    it("creates the device when the hint is unknown", async () => {
      prisma.device.findFirst.mockResolvedValue(null);
      prisma.device.create.mockResolvedValue(deviceRow);
      llm.completeStream.mockReturnValue(makeStream(["ok"])());
      await collect(service.streamReply(boundRequest));
      expect(prisma.device.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ deviceId: "dev-1001" }),
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
        "hello deda",
      );
      const callArgs = llm.completeStream.mock.calls[0][0];
      const systemContents = callArgs.messages
        .filter((m: { role: string }) => m.role === "system")
        .map((m: { content: string }) => m.content);
      expect(systemContents).toContain("MEMBLOCK");
      expect(memories.markInjected).toHaveBeenCalledWith(["m1", "m2"]);
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
      expect(memories.extractAndStore).not.toHaveBeenCalled();
    });
  });

  describe("service without configured api key", () => {
    it("rejects every token when LLM_ADAPTER_API_KEY is unset", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          LlmAdapterService,
          { provide: LlmService, useValue: llm },
          { provide: ChildSafetyService, useValue: childSafety },
          { provide: ChildMemoriesService, useValue: memories },
          { provide: ConversationSessionService, useValue: session },
          { provide: SleepVoiceConfigService, useValue: sleepVoice },
          { provide: SleepConfigsService, useValue: sleepConfigs },
          { provide: AdventureService, useValue: adventure },
          { provide: PrismaService, useValue: prisma },
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
});
