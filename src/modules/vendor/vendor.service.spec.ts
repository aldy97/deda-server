import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { VendorService } from "./vendor.service";
import { VendorReplyUploader } from "./vendor-reply.uploader";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import { VendorTextInDto } from "./dto/vendor-text-in.dto";
import { VendorTextChunkDto } from "./dto/vendor-text-chunk.dto";
import { VendorStatusDto } from "./dto/vendor-status.dto";
import { VendorBindDto } from "./dto/vendor-bind.dto";
import { VendorConversationDto } from "./dto/vendor-conversation.dto";
import { AdventureService } from "@/modules/adventure/adventure.service";
import { ChildMemoriesService } from "@/modules/child-memories/child-memories.service";
import { ConversationSessionService } from "./conversation-session.service";
import { ChildSafetyService } from "./child-safety.service";
import { SleepConfigsService } from "@/modules/sleep-configs/sleep-configs.service";
import { SleepVoiceConfigService } from "@/modules/sleep-configs/sleep-voice-config.service";
import { PROMPT_REGISTRY_PROVIDER } from "@/modules/prompt-registry/prompt-registry.testing";

describe("VendorService", () => {
  let service: VendorService;
  let prisma: any;
  let llmService: jest.Mocked<LlmService>;
  let configService: jest.Mocked<ConfigService>;
  let adventureService: {
    handleChildReply: jest.Mock;
    startToday: jest.Mock;
    isCompletedToday: jest.Mock;
    recordPresented: jest.Mock;
    recordEntryBlocked: jest.Mock;
    markPromptPlaybackComplete: jest.Mock;
    registerTimeoutListener: jest.Mock;
  };
  let childMemoriesService: {
    extractAndStore: jest.Mock;
    buildPromptBlock: jest.Mock;
    markInjected: jest.Mock;
  };
  let replyUploader: { sendChunk: jest.Mock; sendFullReply: jest.Mock };
  let sleepConfigsService: {
    applyVoiceUpdate: jest.Mock;
    getByDeviceId: jest.Mock;
  };
  let sleepVoiceConfigService: { handle: jest.Mock };

  async function* streamOf(
    deltas: string[],
    opts?: { initialDelayMs?: number },
  ): AsyncGenerator<string> {
    if (opts?.initialDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.initialDelayMs));
    }
    for (const delta of deltas) {
      yield delta;
    }
  }

  async function* failingStreamOf(error: Error): AsyncGenerator<string> {
    throw error;
  }

  /** 小模型固定产出「嗯」，大模型产出指定答案全文 */
  const mockAnswerStream = (answerText: string) => {
    llmService.completeStream.mockImplementation((options: any) =>
      options.model === "small-llm" ? streamOf(["嗯"]) : streamOf([answerText]),
    );
  };

  /** 小模型正常，大模型流失败 */
  const mockAnswerFailure = (error: Error) => {
    llmService.completeStream.mockImplementation((options: any) =>
      options.model === "small-llm" ? streamOf(["嗯"]) : failingStreamOf(error),
    );
  };

  /** 本轮经出站 WS 上传的全部 chunk（按调用顺序） */
  const uploadedChunks = (): VendorTextChunkDto[] =>
    replyUploader.sendChunk.mock.calls.map(
      (call) => call[0] as VendorTextChunkDto,
    );

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PROMPT_REGISTRY_PROVIDER,
        VendorService,
        ConversationSessionService,
        {
          provide: PrismaService,
          useValue: {
            device: {
              findUnique: jest.fn(),
              create: jest.fn(),
            },
            deviceConfig: {
              findFirst: jest.fn(),
            },
            childProfile: {
              findUnique: jest.fn(),
            },
            message: {
              findMany: jest.fn(),
              create: jest.fn(),
              findFirst: jest.fn().mockResolvedValue(null),
              update: jest.fn().mockResolvedValue({}),
            },
            conversationSession: {
              findUnique: jest.fn().mockResolvedValue(null),
              upsert: jest.fn().mockResolvedValue(undefined),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn() },
        },
        {
          provide: LlmService,
          useValue: {
            buildEnglishTutorPrompt: jest.fn(),
            complete: jest.fn(),
            buildFillerPrompt: jest.fn().mockReturnValue([
              { role: "system", content: "filler prompt" },
              { role: "user", content: "placeholder" },
            ]),
            completeStream: jest.fn(),
            get smallModelName() {
              return "small-llm";
            },
          },
        },
        {
          provide: ChildMemoriesService,
          useValue: {
            extractAndStore: jest.fn().mockResolvedValue(0),
            buildPromptBlock: jest
              .fn()
              .mockResolvedValue({ text: "", memoryIds: [] }),
            markInjected: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: VendorReplyUploader,
          useValue: {
            sendChunk: jest.fn(),
            sendFullReply: jest.fn(),
          },
        },
        {
          provide: AdventureService,
          useValue: {
            handleChildReply: jest.fn().mockResolvedValue(null),
            startToday: jest.fn().mockResolvedValue(null),
            isCompletedToday: jest.fn().mockResolvedValue(false),
            recordPresented: jest.fn().mockResolvedValue(undefined),
            recordEntryBlocked: jest.fn().mockResolvedValue(undefined),
            markPromptPlaybackComplete: jest.fn().mockResolvedValue(undefined),
            registerTimeoutListener: jest.fn(),
          },
        },
        // 真实安全服务：L1 纯正则、L2 走被 mock 的 llmService.complete
        ChildSafetyService,
        {
          provide: SleepConfigsService,
          useValue: {
            applyVoiceUpdate: jest.fn(),
            // sleepTime="00:00" 让哄睡时段全天开放：本文件的用例都在验证
            // 老链路的话术与落库行为，不该被时段门禁左右。且本文件不用
            // fake timers（跑真实系统时间），若留 null 会回落到默认 21:30，
            // 哄睡用例就变成「北京时间 21:30 后才绿」的时间依赖假测试。
            getByDeviceId: jest
              .fn()
              .mockResolvedValue({ contentType: "story", sleepTime: "00:00" }),
          },
        },
        {
          provide: SleepVoiceConfigService,
          useValue: {
            handle: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<VendorService>(VendorService);
    prisma = module.get(PrismaService);
    llmService = module.get(LlmService);
    configService = module.get(ConfigService);
    adventureService = module.get(AdventureService) as any;
    childMemoriesService = module.get(ChildMemoriesService);
    replyUploader = module.get(VendorReplyUploader) as any;
    sleepConfigsService = module.get(SleepConfigsService) as any;
    sleepVoiceConfigService = module.get(SleepVoiceConfigService) as any;

    replyUploader.sendChunk.mockResolvedValue(undefined);
    replyUploader.sendFullReply.mockResolvedValue(undefined);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("handleTextIn", () => {
    it("新一轮开始时对上一轮 assistant 回复做打断推断（fire-and-forget）", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-001",
        asrText: "你好",
      };
      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-001",
        deviceId: "dev-001",
      } as any);
      // 上一轮 assistant 回复 100 字、2 秒前发出 → 仍在估算播放窗口内
      prisma.message.findFirst.mockResolvedValue({
        id: "prev-assistant",
        content: "啊".repeat(100),
        spokeAt: new Date(Date.now() - 2000),
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue(null);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-001" } as any);
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "user", content: "你好" },
      ] as any);
      mockAnswerStream("你好呀！");

      await service.handleTextIn(dto);
      // fire-and-forget：等微任务/IO 队列排空再断言
      await new Promise((resolve) => setImmediate(resolve));

      expect(prisma.message.findFirst).toHaveBeenCalledWith({
        where: {
          deviceId: "uuid-001",
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

    it("打断推断失败不阻塞本轮回复", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-001",
        asrText: "你好",
      };
      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-001",
        deviceId: "dev-001",
      } as any);
      prisma.message.findFirst.mockRejectedValue(new Error("db down"));
      prisma.deviceConfig.findFirst.mockResolvedValue(null);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-001" } as any);
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "user", content: "你好" },
      ] as any);
      mockAnswerStream("你好呀！");

      const result = await service.handleTextIn(dto);

      expect(result.responseText).toContain("你好呀");
    });

    it("should call LLM, ensure device exists, and persist conversation", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-001",
        asrText: "你好",
      };

      prisma.device.findUnique.mockResolvedValue(null);
      prisma.device.create.mockResolvedValue({
        id: "uuid-001",
        deviceId: "dev-001",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "free_chat",
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-001" } as any);
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "你好" },
      ] as any);
      mockAnswerStream("你好呀！");

      const result = await service.handleTextIn(dto);

      expect(prisma.device.findUnique).toHaveBeenCalledWith({
        where: { deviceId: "dev-001" },
      });
      expect(prisma.device.create).toHaveBeenCalledWith({
        data: { deviceId: "dev-001" },
      });
      expect(prisma.childProfile.findUnique).toHaveBeenCalledWith({
        where: { deviceId: "uuid-001" },
      });
      expect(llmService.completeStream).toHaveBeenCalled();

      // 细颗粒度：user 消息先于 LLM 调用落库,assistant 消息后补
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      const [userCall, assistantCall] = prisma.message.create.mock.calls;
      expect(userCall[0].data).toEqual(
        expect.objectContaining({
          deviceId: "uuid-001",
          role: "user",
          content: "你好",
          turnId: expect.any(String),
          status: "completed",
          mode: "free_chat",
        }),
      );
      expect(userCall[0].data).not.toHaveProperty("textbookId");
      expect(userCall[0].data).not.toHaveProperty("unitId");
      // 落库为用户实际播报全文：小模型 filler + 大模型答案
      expect(assistantCall[0].data).toEqual(
        expect.objectContaining({
          deviceId: "uuid-001",
          role: "assistant",
          content: "嗯\n你好呀！",
          turnId: userCall[0].data.turnId,
          status: "completed",
          mode: "free_chat",
        }),
      );
      // user 消息必须在 LLM 调用之前写入
      const userWriteOrder = prisma.message.create.mock.invocationCallOrder[0];
      const llmOrder = llmService.completeStream.mock.invocationCallOrder[0];
      expect(userWriteOrder).toBeLessThan(llmOrder);
      expect(result).toEqual({
        deviceId: "dev-001",
        responseText: "嗯\n你好呀！",
        context: { mode: "free_chat" },
        ttsOptions: {},
      });

      // 全量回复在全部 chunk 之后上传
      expect(replyUploader.sendFullReply).toHaveBeenCalledTimes(1);
      expect(replyUploader.sendFullReply).toHaveBeenCalledWith(result);
      const lastChunkOrder =
        replyUploader.sendChunk.mock.invocationCallOrder[
          replyUploader.sendChunk.mock.invocationCallOrder.length - 1
        ];
      expect(
        replyUploader.sendFullReply.mock.invocationCallOrder[0],
      ).toBeGreaterThan(lastChunkOrder);
    });

    it("should thread one turnId through safety, intent, streams and messages", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-001",
        asrText: "我想听故事",
      };

      prisma.device.findUnique.mockResolvedValue(null);
      prisma.device.create.mockResolvedValue({
        id: "uuid-001",
        deviceId: "dev-001",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "free_chat",
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-001" } as any);
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "我想听故事" },
      ] as any);
      // safety_l2 与 intent_classify 共用被 mock 的 complete，按 scene 分流返回
      llmService.complete.mockImplementation((options: any) =>
        Promise.resolve({
          text: options.scene === "safety_l2" ? "safe" : "free_chat",
        }),
      );
      mockAnswerStream("好呀，给你讲个故事！");

      await service.handleTextIn(dto);

      const turnId = prisma.message.create.mock.calls[0][0].data.turnId;
      expect(typeof turnId).toBe("string");

      // 同一轮：安全分类、意图分类、filler、主回答全部共享该 turnId
      expect(llmService.complete).toHaveBeenCalledWith(
        expect.objectContaining({ scene: "safety_l2", turnId }),
      );
      expect(llmService.complete).toHaveBeenCalledWith(
        expect.objectContaining({ scene: "intent_classify", turnId }),
      );
      expect(llmService.completeStream).toHaveBeenCalledWith(
        expect.objectContaining({ scene: "filler", turnId }),
      );
      expect(llmService.completeStream).toHaveBeenCalledWith(
        expect.objectContaining({ scene: "chat_main", turnId }),
      );
      // 记忆提取沿用既有 turnId 契约
      expect(childMemoriesService.extractAndStore).toHaveBeenCalledWith(
        expect.objectContaining({ turnId }),
      );
      // assistant 消息与 user 消息同轮
      expect(prisma.message.create.mock.calls[1][0].data.turnId).toBe(turnId);
    });

    it("should route ordinary input to english_chat for an English chat device", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-002",
        asrText: "What color is it?",
      };

      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-002",
        deviceId: "dev-002",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "english_chat",
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-002" } as any);
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "What color is it?" },
      ] as any);
      mockAnswerStream("It's red.");

      const result = await service.handleTextIn(dto);

      expect(llmService.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "What color is it?",
        [],
        expect.objectContaining({ mode: "english_chat" }),
      );
      expect(prisma.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            mode: "english_chat",
          }),
        }),
      );
      expect(result.context).toEqual({ mode: "english_chat" });
      expect(result.responseText).toBe("嗯\nIt's red.");
    });

    it("should return fallback reply when LLM fails", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-003",
        asrText: "Hello",
      };

      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-003",
        deviceId: "dev-003",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "free_chat",
      } as any);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-003" } as any);
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Hello" },
      ] as any);
      mockAnswerFailure(new Error("LLM timeout"));

      const result = await service.handleTextIn(dto);

      // 大模型失败：播报全文 = filler + 兜底文案
      expect(result.responseText).toBe(
        "嗯\nSorry, I didn't catch that. Could you say it again?",
      );
      expect(result.context).toEqual({ mode: "free_chat" });

      // LLM 失败：user 消息仍已落库,assistant 行标 failed
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      const [userCall, assistantCall] = prisma.message.create.mock.calls;
      expect(userCall[0].data).toEqual(
        expect.objectContaining({ role: "user", content: "Hello" }),
      );
      expect(assistantCall[0].data).toEqual(
        expect.objectContaining({
          role: "assistant",
          status: "failed",
          turnId: userCall[0].data.turnId,
        }),
      );
    });

    it("should preserve deviceId in the response", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-abc-123",
        asrText: "Hello",
        confidence: 0.95,
        firmwareVersion: "1.0.0",
        metadata: { lang: "en" },
      };

      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-abc",
        deviceId: "dev-abc-123",
      } as any);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-002" } as any);
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Hello" },
      ] as any);
      mockAnswerStream("Hi there!");

      const result = await service.handleTextIn(dto);

      expect(prisma.device.create).not.toHaveBeenCalled();
      expect(result.deviceId).toBe("dev-abc-123");
      expect(result.responseText).toBe("嗯\nHi there!");
    });

    it("should pass child profile to the prompt builder", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-001",
        asrText: "Hello",
      };
      const childProfile = {
        id: "child-001",
        name: "Alice",
        birthday: "2018-05-20",
        englishName: "Ali",
      };

      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-001",
        deviceId: "dev-001",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "free_chat",
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(childProfile as any);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-001" } as any);
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Hello" },
      ] as any);
      mockAnswerStream("Hi Alice!");

      await service.handleTextIn(dto);

      expect(llmService.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "Hello",
        [],
        expect.objectContaining({
          childProfile: {
            name: "Alice",
            birthday: "2018-05-20",
            englishName: "Ali",
          },
          promptTemplate: undefined,
          mode: "free_chat",
        }),
      );
    });

    it("should NOT use a conversationMode prompt template in free_chat (flat mode)", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-001",
        asrText: "Hi",
      };

      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-001",
        deviceId: "dev-001",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "free_chat",
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-001" } as any);
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Hi" },
      ] as any);
      mockAnswerStream("Hey there!");

      await service.handleTextIn(dto);
      expect(llmService.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "Hi",
        [],
        expect.objectContaining({
          childProfile: undefined,
          promptTemplate: undefined,
          mode: "free_chat",
        }),
      );
    });

    it("should use undefined template when no matching prompt template exists", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-001",
        asrText: "Hello",
      };

      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-001",
        deviceId: "dev-001",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "free_chat",
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-001" } as any);
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Hello" },
      ] as any);
      mockAnswerStream("Hi!");

      await service.handleTextIn(dto);

      expect(llmService.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "Hello",
        [],
        expect.objectContaining({
          childProfile: undefined,
          promptTemplate: undefined,
          mode: "free_chat",
        }),
      );
    });

    it("should persist free_chat and isolate history by top-level mode", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-001",
        asrText: "Hi",
      };

      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-001",
        deviceId: "dev-001",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "free_chat",
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-001" } as any);
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Hi" },
      ] as any);
      mockAnswerStream("Hey!");

      await service.handleTextIn(dto);

      // user + assistant 两条消息共享 turnId
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      const [userCall, assistantCall] = prisma.message.create.mock.calls;
      expect(userCall[0].data).toEqual(
        expect.objectContaining({
          deviceId: "uuid-001",
          role: "user",
          content: "Hi",
          mode: "free_chat",
        }),
      );
      // assistant 落库 = 播报全文（filler + answer）
      expect(assistantCall[0].data).toEqual(
        expect.objectContaining({
          deviceId: "uuid-001",
          role: "assistant",
          content: "嗯\nHey!",
          status: "completed",
          mode: "free_chat",
          turnId: userCall[0].data.turnId,
        }),
      );
      expect(userCall[0].data).not.toHaveProperty("textbookId");
      expect(userCall[0].data).not.toHaveProperty("unitId");
      expect(assistantCall[0].data).not.toHaveProperty("textbookId");
      expect(assistantCall[0].data).not.toHaveProperty("unitId");
      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deviceId: "uuid-001", mode: "free_chat" },
        }),
      );
    });
  });

  // TODO(可用性): 以下用例默认两个 LLM API 均可用且速度正常；小模型超时但
  // 大模型正常、大模型流中途断开、小模型限流(429) 等可用性组合用例待补。
  describe("handleTextIn streaming upload", () => {
    const setupStreamingBase = () => {
      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-s1",
        deviceId: "dev-s1",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "free_chat",
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-s1" } as any);
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "我喜欢上海的天气" },
      ] as any);
    };

    it("should prioritize adventure for a generic story request while today's adventure is incomplete", async () => {
      setupStreamingBase();
      adventureService.isCompletedToday.mockResolvedValue(false);
      adventureService.startToday.mockResolvedValue(null);
      llmService.complete.mockResolvedValue({ text: "adventure_story" } as any);
      mockAnswerStream("A free story.");

      await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "我想听故事",
      });

      expect(llmService.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "small-llm",
          temperature: 0,
          messages: expect.arrayContaining([
            expect.objectContaining({
              content: expect.stringContaining("adventure_story"),
            }),
          ]),
        }),
      );
      expect(adventureService.startToday).toHaveBeenCalledWith("uuid-s1", true);
    });

    it("should block adventure replay after completion and route to a free story", async () => {
      setupStreamingBase();
      adventureService.isCompletedToday.mockResolvedValue(true);
      llmService.complete.mockResolvedValue({ text: "adventure_story" } as any);
      mockAnswerStream("A brand new free story.");

      await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "再听一遍风铃树",
      });

      expect(adventureService.startToday).not.toHaveBeenCalled();
      expect(adventureService.recordEntryBlocked).toHaveBeenCalledWith(
        "uuid-s1",
        "free_story",
      );
      expect(llmService.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          mode: "free_story",
          promptTemplate: expect.stringMatching(/自由创作[\s\S]*不要承诺/),
        }),
      );
    });

    it("should persist blocked adventure entry messages as free_story mode", async () => {
      setupStreamingBase();
      adventureService.isCompletedToday.mockResolvedValue(true);
      llmService.complete.mockResolvedValue({ text: "adventure_story" } as any);
      mockAnswerStream("今天已经听过冒险啦，我们讲个别的故事吧。");

      await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "我想玩下一集每日冒险",
      });

      // 冒险被门禁拦截、未真正开始：落 free_story，不污染 adventure_story 统计
      const [userCall, assistantCall] = prisma.message.create.mock.calls;
      expect(userCall[0].data).toEqual(
        expect.objectContaining({ role: "user", mode: "free_story" }),
      );
      expect(assistantCall[0].data).toEqual(
        expect.objectContaining({ role: "assistant", mode: "free_story" }),
      );
    });

    it("should persist free_story intent messages with mode free_story", async () => {
      setupStreamingBase();
      adventureService.isCompletedToday.mockResolvedValue(false);
      llmService.complete.mockResolvedValue({ text: "free_story" } as any);
      mockAnswerStream("好的，我给你讲个故事。");

      await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "讲个故事",
      });

      const [userCall, assistantCall] = prisma.message.create.mock.calls;
      expect(userCall[0].data).toEqual(
        expect.objectContaining({ role: "user", mode: "free_story" }),
      );
      expect(assistantCall[0].data).toEqual(
        expect.objectContaining({ role: "assistant", mode: "free_story" }),
      );
    });

    it("should persist free_chat intent as english_chat when device is in english_chat mode", async () => {
      setupStreamingBase();
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "english_chat",
      } as any);
      llmService.complete.mockResolvedValue({ text: "free_chat" } as any);
      mockAnswerStream("The weather is nice today.");

      await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "今天天气怎么样",
      });

      const [userCall, assistantCall] = prisma.message.create.mock.calls;
      expect(userCall[0].data).toEqual(
        expect.objectContaining({ role: "user", mode: "english_chat" }),
      );
      expect(assistantCall[0].data).toEqual(
        expect.objectContaining({ role: "assistant", mode: "english_chat" }),
      );
    });

    it("should honor an explicit English story request after adventure completion", async () => {
      setupStreamingBase();
      adventureService.isCompletedToday.mockResolvedValue(true);
      llmService.complete.mockResolvedValue({ text: "english_story" } as any);
      mockAnswerStream("An English story.");

      await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "我想听英语故事",
      });

      expect(adventureService.startToday).not.toHaveBeenCalled();
      expect(adventureService.recordEntryBlocked).toHaveBeenCalledWith(
        "uuid-s1",
        "english_story",
      );
      expect(llmService.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          mode: "english_story",
          promptTemplate: expect.stringContaining("English"),
        }),
      );
    });

    // 契约变更：前置关键词过滤（isRoutingCandidate）已移除，普通闲聊也要过
    // 分类器做语义判定——否则「我困了」这类不含词表字的表达永远进不了哄睡。
    // free_chat 仍然不写会话，这一点没变。
    it("should route ordinary chat to free-chat via the classifier without session writes", async () => {
      setupStreamingBase();
      llmService.complete.mockResolvedValue({ text: "free_chat" } as any);
      mockAnswerStream("今天很适合出门走走。");

      await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "今天天气怎么样",
      });

      const intentClassifyCalls = llmService.complete.mock.calls.filter(
        ([options]: any[]) =>
          options.messages[0].content.includes("对话意图分类器"),
      );
      expect(intentClassifyCalls).toHaveLength(1);
      expect(prisma.conversationSession.upsert).not.toHaveBeenCalled();
      expect(llmService.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ mode: "free_chat" }),
      );
    });

    // 契约变更：活跃会话内的普通接话现在也会调分类器，但只有模型判为
    // free_chat 时才维持原模式（session_sticky），因此英语故事不会被打断。
    it("should keep an active English session for ordinary answers without entering adventure", async () => {
      setupStreamingBase();
      prisma.conversationSession.findUnique.mockResolvedValue({
        id: "session-s1",
        deviceId: "uuid-s1",
        currentMode: "english_story",
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      llmService.complete.mockResolvedValue({ text: "free_chat" } as any);
      mockAnswerStream("Yes, the cat is in the garden.");

      await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "I see a cat.",
      });

      const intentClassifyCalls = llmService.complete.mock.calls.filter(
        ([options]: any[]) =>
          options.messages[0].content.includes("对话意图分类器"),
      );
      expect(intentClassifyCalls).toHaveLength(1);
      expect(adventureService.startToday).not.toHaveBeenCalled();
      expect(childMemoriesService.buildPromptBlock).not.toHaveBeenCalled();
      expect(llmService.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          mode: "english_story",
          promptTemplate: expect.stringContaining("English"),
        }),
      );
    });

    it("should use a calm non-interactive prompt for sleep stories and isolate memories", async () => {
      setupStreamingBase();
      llmService.complete.mockResolvedValue({ text: "sleep_story" } as any);
      mockAnswerStream("月亮轻轻闭上了眼睛。");

      await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "我想听哄睡故事",
      });

      expect(childMemoriesService.buildPromptBlock).not.toHaveBeenCalled();
      expect(llmService.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          mode: "sleep_story",
          promptTemplate: expect.stringMatching(/平静|缓慢/),
        }),
      );
      const promptOptions = llmService.buildEnglishTutorPrompt.mock.calls[0][2];
      expect(promptOptions?.promptTemplate).toContain("不要提问");
      expect(promptOptions?.promptTemplate).toContain("不要邀请互动");
    });

    describe("sleep story voice config", () => {
      it("should persist contentType=song when child asks for a sleep song", async () => {
        setupStreamingBase();
        llmService.complete.mockResolvedValue({ text: "sleep_story" } as any);
        mockAnswerStream("月亮船儿轻轻摇。");

        await service.handleTextIn({
          deviceId: "dev-s1",
          asrText: "我要听睡前儿歌",
        });

        expect(sleepConfigsService.applyVoiceUpdate).toHaveBeenCalledWith(
          "uuid-s1",
          { contentType: "song" },
        );
      });

      it("should persist contentType=story when child asks for a sleep story", async () => {
        setupStreamingBase();
        llmService.complete.mockResolvedValue({ text: "sleep_story" } as any);
        mockAnswerStream("月亮轻轻闭上了眼睛。");

        await service.handleTextIn({
          deviceId: "dev-s1",
          asrText: "我要听睡前故事",
        });

        expect(sleepConfigsService.applyVoiceUpdate).toHaveBeenCalledWith(
          "uuid-s1",
          { contentType: "story" },
        );
      });

      it("should not touch sleep config for plain sleep entry phrases", async () => {
        setupStreamingBase();
        llmService.complete.mockResolvedValue({ text: "sleep_story" } as any);
        mockAnswerStream("该睡觉啦。");

        await service.handleTextIn({
          deviceId: "dev-s1",
          asrText: "陪我睡觉",
        });

        expect(sleepConfigsService.applyVoiceUpdate).not.toHaveBeenCalled();
      });

      it("should fall back to story with a warning when configured content is song", async () => {
        setupStreamingBase();
        sleepConfigsService.getByDeviceId.mockResolvedValue({
          contentType: "song",
          sleepTime: "00:00",
        });
        llmService.complete.mockResolvedValue({ text: "sleep_story" } as any);
        mockAnswerStream("月亮轻轻闭上了眼睛。");

        await service.handleTextIn({
          deviceId: "dev-s1",
          asrText: "陪我睡觉",
        });

        // 儿歌内容源未上线：仍按故事播放
        expect(llmService.buildEnglishTutorPrompt).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Array),
          expect.objectContaining({ mode: "sleep_story" }),
        );
      });
    });

    describe("sleep config intent", () => {
      it("applies the voice update and replies without touching the adventure gate or main LLM", async () => {
        setupStreamingBase();
        llmService.complete.mockResolvedValue({ text: "sleep_config" } as any);
        sleepVoiceConfigService.handle.mockResolvedValue({
          replyText: "好呀，以后哄睡时间就放睡前儿歌啦！",
          applied: true,
          field: "contentType",
        });

        const result = await service.handleTextIn({
          deviceId: "dev-s1",
          asrText: "以后睡前都听儿歌",
        });

        expect(sleepVoiceConfigService.handle).toHaveBeenCalledWith(
          "uuid-s1",
          "以后睡前都听儿歌",
        );
        expect(result).toEqual({
          deviceId: "dev-s1",
          responseText: "好呀，以后哄睡时间就放睡前儿歌啦！",
          context: { sleepConfig: "contentType" },
          ttsOptions: {},
        });
        // 修改配置不是冒险/故事入口：不查冒险门禁、不进大模型主链路
        expect(adventureService.isCompletedToday).not.toHaveBeenCalled();
        expect(adventureService.recordEntryBlocked).not.toHaveBeenCalled();
        expect(llmService.completeStream).not.toHaveBeenCalled();

        // 回复走 chunk 通道：单 answer + 显式收尾，全量兜底在后
        const chunks = uploadedChunks();
        expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
        expect(chunks[0]).toMatchObject({
          source: "answer",
          delta: "好呀，以后哄睡时间就放睡前儿歌啦！",
          isFinal: false,
        });
        expect(chunks[1]).toMatchObject({
          source: "answer",
          delta: "",
          isFinal: true,
        });
        expect(replyUploader.sendFullReply).toHaveBeenCalledWith(result);
      });

      it("persists the turn as free_chat messages with the applied field in rawPayload", async () => {
        setupStreamingBase();
        llmService.complete.mockResolvedValue({ text: "sleep_config" } as any);
        sleepVoiceConfigService.handle.mockResolvedValue({
          replyText: "好呀，以后 21:30 我就来哄你睡觉啦！",
          applied: true,
          field: "sleepTime",
        });

        await service.handleTextIn({
          deviceId: "dev-s1",
          asrText: "明天九点半哄我睡觉",
        });

        const creates = prisma.message.create.mock.calls.map(
          (call) => call[0].data,
        );
        expect(creates).toHaveLength(2);
        expect(creates[0]).toMatchObject({
          role: "user",
          content: "明天九点半哄我睡觉",
          mode: "free_chat",
        });
        expect(creates[1]).toMatchObject({
          role: "assistant",
          content: "好呀，以后 21:30 我就来哄你睡觉啦！",
          mode: "free_chat",
        });
        expect(creates[1].rawPayload).toMatchObject({
          filler: null,
          answer: "好呀，以后 21:30 我就来哄你睡觉啦！",
          sleepConfig: "sleepTime",
        });
      });

      it("still replies with the fallback when the config cannot be applied", async () => {
        setupStreamingBase();
        llmService.complete.mockResolvedValue({ text: "sleep_config" } as any);
        sleepVoiceConfigService.handle.mockResolvedValue({
          replyText:
            "这个时长我做不到哦，可以说哄睡 10 分钟、15 分钟、20 分钟、25 分钟或者 30 分钟。",
          applied: false,
          field: "durationMinutes",
        });

        const result = await service.handleTextIn({
          deviceId: "dev-s1",
          asrText: "哄睡改成12分钟",
        });

        expect(result.responseText).toContain("10 分钟");
        expect(llmService.completeStream).not.toHaveBeenCalled();
        const creates = prisma.message.create.mock.calls.map(
          (call) => call[0].data,
        );
        expect(creates[1]).toMatchObject({
          role: "assistant",
          mode: "free_chat",
          status: "completed",
        });
        expect(creates[1].rawPayload).toMatchObject({ sleepConfig: null });
      });
    });

    it("should reset the persisted session after successfully starting an adventure", async () => {
      setupStreamingBase();
      adventureService.startToday.mockResolvedValue({
        texts: ["今天 Elly 要出门啦。"],
        action: "completed",
      });

      await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "讲故事",
      });

      expect(adventureService.startToday).toHaveBeenCalledWith("uuid-s1", true);
      expect(prisma.conversationSession.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deviceId: "uuid-s1" },
          update: { currentMode: "free_chat", expiresAt: null },
        }),
      );
    });

    it("should inject relevant memories only into the free-chat answer and extract asynchronously", async () => {
      setupStreamingBase();
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "free_chat",
      } as any);
      prisma.message.findMany.mockResolvedValue([
        {
          role: "assistant",
          content: "嗯\n你最喜欢红色。",
          rawPayload: { filler: "嗯", answer: "你最喜欢红色。" },
        },
      ]);
      childMemoriesService.buildPromptBlock.mockResolvedValue({
        text: "孩子当前最喜欢蓝色。",
        memoryIds: ["memory-blue"],
      });
      mockAnswerStream("我记得你最喜欢蓝色！");

      const result = await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "你还记得我喜欢什么颜色吗？",
      });

      expect(result.responseText).toContain("我记得你最喜欢蓝色！");
      expect(childMemoriesService.buildPromptBlock).toHaveBeenCalledWith(
        "uuid-s1",
        ["你最喜欢红色。"],
      );
      const answerCall = llmService.completeStream.mock.calls.find(
        ([options]) => options.model !== "small-llm",
      );
      // 记忆块贴尾注入：位于本轮 user 之前，保住头部前缀缓存
      const answerMessages = answerCall?.[0].messages ?? [];
      expect(answerMessages[answerMessages.length - 2]).toEqual({
        role: "system",
        content: "孩子当前最喜欢蓝色。",
      });
      expect(answerMessages[answerMessages.length - 1].role).toBe("user");
      const fillerCall = llmService.completeStream.mock.calls.find(
        ([options]) => options.model === "small-llm",
      );
      expect(JSON.stringify(fillerCall?.[0].messages)).not.toContain(
        "孩子当前最喜欢蓝色",
      );
      const userCall = prisma.message.create.mock.calls.find(
        (call) => call[0].data.role === "user",
      );
      expect(childMemoriesService.extractAndStore).toHaveBeenCalledWith({
        deviceId: "uuid-s1",
        turnId: userCall[0].data.turnId,
        asrText: "你还记得我喜欢什么颜色吗？",
        previousAssistant: "你最喜欢红色。",
        sourceOccurredAt: userCall[0].data.spokeAt,
      });
      expect(childMemoriesService.markInjected).toHaveBeenCalledWith([
        "memory-blue",
      ]);
    });

    it("should keep the streamed reply working when memory extraction fails", async () => {
      setupStreamingBase();
      childMemoriesService.extractAndStore.mockRejectedValue(
        new Error("extractor unavailable"),
      );
      mockAnswerStream("I still answer.");

      await expect(
        service.handleTextIn({
          deviceId: "dev-s1",
          asrText: "Hello",
        }),
      ).resolves.toMatchObject({ responseText: "嗯\nI still answer." });

      expect(childMemoriesService.extractAndStore).toHaveBeenCalled();
      expect(uploadedChunks().some((chunk) => chunk.source === "answer")).toBe(
        true,
      );
    });

    it("should upload filler chunks before answer chunks with contiguous seq", async () => {
      setupStreamingBase();
      // 大模型立即完成、小模型延迟产出：大模型 chunk 必须先缓冲，不得抢跑
      llmService.completeStream.mockImplementation((options: any) =>
        options.model === "small-llm"
          ? streamOf(["原来", "你喜欢上海呀"], { initialDelayMs: 10 })
          : streamOf(["I ", "like ", "Shanghai."]),
      );

      const result = await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "我喜欢上海的天气",
      });

      const chunks = uploadedChunks();
      expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(chunks[0]).toMatchObject({
        deviceId: "dev-s1",
        source: "filler",
        delta: "原来",
        isFinal: false,
      });
      expect(chunks[1]).toMatchObject({
        source: "filler",
        delta: "你喜欢上海呀",
        isFinal: false,
      });
      expect(chunks[2]).toMatchObject({
        source: "filler",
        delta: "",
        isFinal: true,
      });
      expect(chunks[3]).toMatchObject({
        source: "answer",
        delta: "I ",
        isFinal: false,
      });
      expect(chunks[5]).toMatchObject({
        source: "answer",
        delta: "Shanghai.",
        isFinal: false,
      });
      expect(chunks[6]).toMatchObject({
        source: "answer",
        delta: "",
        isFinal: true,
      });
      // 全部 chunk 共享同一 turnId
      expect(new Set(chunks.map((c) => c.turnId)).size).toBe(1);

      // 小模型请求走 small-llm，大模型请求不带 model 覆盖
      expect(llmService.completeStream).toHaveBeenCalledWith(
        expect.objectContaining({ model: "small-llm" }),
      );

      // 返回值与落库均为用户实际播报全文：filler + 大模型答案
      expect(result.responseText).toBe("原来你喜欢上海呀\nI like Shanghai.");
      const assistantCall = prisma.message.create.mock.calls.find(
        (call) => call[0].data.role === "assistant",
      );
      expect(assistantCall[0].data.content).toBe(
        "原来你喜欢上海呀\nI like Shanghai.",
      );
      expect(assistantCall[0].data.status).toBe("completed");
    });

    it("should await each chunk ack before uploading the next one", async () => {
      setupStreamingBase();
      llmService.completeStream.mockImplementation((options: any) =>
        options.model === "small-llm" ? streamOf(["A", "B"]) : streamOf(["X"]),
      );
      const sentSeqs: number[] = [];
      let resolveFirstAck: () => void = () => undefined;
      replyUploader.sendChunk.mockImplementation(
        (chunk: VendorTextChunkDto) => {
          sentSeqs.push(chunk.seq);
          if (chunk.seq === 0) {
            return new Promise<void>((resolve) => {
              resolveFirstAck = resolve;
            });
          }
          return Promise.resolve();
        },
      );

      const done = service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "hi",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // 第一个 chunk 的 ack 未返回前，不得调用 WS 接口发送下一个
      expect(sentSeqs).toEqual([0]);

      resolveFirstAck();
      await done;
      expect(sentSeqs).toEqual([0, 1, 2, 3, 4]);
    });

    it("should continue uploading remaining chunks when one chunk upload fails", async () => {
      setupStreamingBase();
      llmService.completeStream.mockImplementation((options: any) =>
        options.model === "small-llm"
          ? streamOf(["嗯"])
          : streamOf(["Hi ", "there!"]),
      );
      replyUploader.sendChunk.mockImplementation((chunk: VendorTextChunkDto) =>
        chunk.source === "answer" && chunk.delta === "Hi "
          ? Promise.reject(new Error("ws disconnected"))
          : Promise.resolve(),
      );

      const result = await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "hi",
      });

      const chunks = uploadedChunks();
      expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3, 4]);
      expect(result.responseText).toBe("嗯\nHi there!");
      expect(replyUploader.sendFullReply).toHaveBeenCalledTimes(1);
    });

    it("should skip filler and upload answer when small model fails", async () => {
      setupStreamingBase();
      llmService.completeStream.mockImplementation((options: any) =>
        options.model === "small-llm"
          ? failingStreamOf(new Error("small model down"))
          : streamOf(["Hi ", "there!"]),
      );

      const result = await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "hi",
      });

      const chunks = uploadedChunks();
      expect(chunks.every((c) => c.source === "answer")).toBe(true);
      expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
      expect(chunks[2]).toMatchObject({ source: "answer", isFinal: true });
      // 小模型失败：播报全文只含大模型答案
      expect(result.responseText).toBe("Hi there!");
      const assistantCall = prisma.message.create.mock.calls.find(
        (call) => call[0].data.role === "assistant",
      );
      expect(assistantCall[0].data.content).toBe("Hi there!");
      // 边界照常入库：filler 缺失记 null
      expect(assistantCall[0].data.rawPayload).toEqual({
        filler: null,
        answer: "Hi there!",
      });
    });

    it("should fall back to default reply when big model stream fails", async () => {
      setupStreamingBase();
      llmService.completeStream.mockImplementation((options: any) =>
        options.model === "small-llm"
          ? streamOf(["嗯哼"])
          : failingStreamOf(new Error("boom")),
      );

      const result = await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "hi",
      });

      const fallback = "Sorry, I didn't catch that. Could you say it again?";
      // 播报全文 = filler + 兜底文案
      expect(result.responseText).toBe(`嗯哼\n${fallback}`);
      const chunks = uploadedChunks();
      // filler 正常发出，随后兜底文案作为 answer chunk 对齐收尾
      expect(chunks[0]).toMatchObject({ source: "filler", delta: "嗯哼" });
      const answerChunks = chunks.filter((c) => c.source === "answer");
      expect(answerChunks[0]).toMatchObject({
        delta: fallback,
        isFinal: false,
      });
      expect(answerChunks[answerChunks.length - 1]).toMatchObject({
        isFinal: true,
      });

      const assistantCall = prisma.message.create.mock.calls.find(
        (call) => call[0].data.role === "assistant",
      );
      expect(assistantCall[0].data.content).toBe(`嗯哼\n${fallback}`);
      expect(assistantCall[0].data.status).toBe("failed");
    });

    it("should fall back to non-streaming path when LLM_STREAM_ENABLED=false", async () => {
      setupStreamingBase();
      configService.get.mockImplementation((key: string) => {
        const map: Record<string, string> = {
          LLM_STREAM_ENABLED: "false",
        };
        return map[key];
      });
      llmService.complete.mockResolvedValue({ text: "Hi!" });

      const result = await service.handleTextIn({
        deviceId: "dev-s1",
        asrText: "hi",
      });

      expect(replyUploader.sendChunk).not.toHaveBeenCalled();
      expect(replyUploader.sendFullReply).not.toHaveBeenCalled();
      expect(llmService.complete).toHaveBeenCalled();
      expect(llmService.completeStream).not.toHaveBeenCalled();
      expect(result.responseText).toBe("Hi!");
    });
  });

  describe("history boundary & filler diversity", () => {
    const setupBase = () => {
      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-h1",
        deviceId: "dev-h1",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "free_chat",
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.message.create.mockResolvedValue({ id: "conv-h1" } as any);
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "hi" },
      ] as any);
    };

    it("should strip fillers from history and skip legacy assistant rows", async () => {
      setupBase();
      // findMany 按 spokeAt desc 返回，service 内 reverse 成正序
      prisma.message.findMany.mockResolvedValue([
        { role: "user", content: "u2", rawPayload: null },
        {
          role: "assistant",
          content: "嗯2\na2",
          rawPayload: { filler: "嗯2", answer: "a2" },
        },
        { role: "assistant", content: "legacy-full", rawPayload: null },
        { role: "user", content: "u1", rawPayload: null },
      ] as any);
      mockAnswerStream("ok");

      await service.handleTextIn({ deviceId: "dev-h1", asrText: "hi" });

      // 大模型历史：只含 answer，filler 被剥离；无边界信息的旧 assistant 行整条跳过
      expect(llmService.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "hi",
        [
          { role: "user", content: "u1" },
          { role: "assistant", content: "a2" },
          { role: "user", content: "u2" },
        ],
        expect.anything(),
      );
      // 近期 filler 清单只收集有边界的行
      expect(llmService.buildFillerPrompt).toHaveBeenCalledWith("hi", ["嗯2"]);
    });

    it("should pass only the last 5 recent fillers in chronological order", async () => {
      setupBase();
      // 6 条带边界的 assistant 行（desc：f6 最新 … f1 最旧）
      prisma.message.findMany.mockResolvedValue(
        [6, 5, 4, 3, 2, 1].map((n) => ({
          role: "assistant",
          content: `f${n}\na${n}`,
          rawPayload: { filler: `f${n}`, answer: `a${n}` },
        })) as any,
      );
      mockAnswerStream("ok");

      await service.handleTextIn({ deviceId: "dev-h1", asrText: "hi" });

      // 只取最近 5 轮，且按时间正序（旧 → 新）
      expect(llmService.buildFillerPrompt).toHaveBeenCalledWith("hi", [
        "f2",
        "f3",
        "f4",
        "f5",
        "f6",
      ]);
    });

    it("should persist filler/answer boundary into assistant rawPayload", async () => {
      setupBase();
      prisma.message.findMany.mockResolvedValue([]);
      mockAnswerStream("Hello! I'm fine.");

      await service.handleTextIn({ deviceId: "dev-h1", asrText: "hi" });

      const assistantCall = prisma.message.create.mock.calls.find(
        (call) => call[0].data.role === "assistant",
      );
      // content 仍为播报全文（观感不变），边界结构化存入 rawPayload
      expect(assistantCall[0].data.content).toBe("嗯\nHello! I'm fine.");
      expect(assistantCall[0].data.rawPayload).toEqual({
        filler: "嗯",
        answer: "Hello! I'm fine.",
      });
    });

    it("should stream an adventure reply in order and persist the full narrated text", async () => {
      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-h1",
        deviceId: "dev-h1",
      });
      prisma.message.create.mockResolvedValue({ id: "message-h1" });
      adventureService.handleChildReply.mockResolvedValue({
        texts: ["好呀，我们去森林！", "森林里有一只小松鼠。"],
        action: "await_reply",
      });

      const result = await service.handleTextIn({
        deviceId: "dev-h1",
        asrText: "森林",
      });

      const chunks = uploadedChunks();
      expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2]);
      expect(chunks.map((chunk) => chunk.delta)).toEqual([
        "好呀，我们去森林！",
        "森林里有一只小松鼠。",
        "",
      ]);
      expect(chunks.every((chunk) => chunk.source === "answer")).toBe(true);
      expect(chunks[2].isFinal).toBe(true);
      expect(result.responseText).toBe(
        "好呀，我们去森林！\n森林里有一只小松鼠。",
      );
      expect(llmService.completeStream).not.toHaveBeenCalled();
      expect(adventureService.startToday).not.toHaveBeenCalled();

      const lastChunkOrder =
        replyUploader.sendChunk.mock.invocationCallOrder[2];
      const timerOrder =
        adventureService.markPromptPlaybackComplete.mock.invocationCallOrder[0];
      const fullReplyOrder =
        replyUploader.sendFullReply.mock.invocationCallOrder[0];
      expect(lastChunkOrder).toBeLessThan(timerOrder);
      expect(timerOrder).toBeLessThan(fullReplyOrder);

      const assistantCall = prisma.message.create.mock.calls.find(
        (call) => call[0].data.role === "assistant",
      );
      expect(assistantCall[0].data).toMatchObject({
        mode: "adventure_story",
        content: "好呀，我们去森林！\n森林里有一只小松鼠。",
        rawPayload: {
          filler: null,
          answer: "好呀，我们去森林！\n森林里有一只小松鼠。",
          interactionResult: null,
        },
      });
    });

    it("should start today's adventure before entering the free-chat pipeline", async () => {
      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-h1",
        deviceId: "dev-h1",
      });
      prisma.message.create.mockResolvedValue({ id: "message-h1" });
      adventureService.startToday.mockResolvedValue({
        texts: ["今天 Elly 要出门啦。"],
        action: "completed",
      });

      await service.handleTextIn({ deviceId: "dev-h1", asrText: "讲故事" });

      expect(adventureService.startToday).toHaveBeenCalledWith("uuid-h1", true);
      expect(
        adventureService.markPromptPlaybackComplete,
      ).not.toHaveBeenCalled();
    });

    it("should upload and persist a timeout reply without creating a user message", async () => {
      const timeoutListener =
        adventureService.registerTimeoutListener.mock.calls[0][0];
      prisma.device.findUnique.mockResolvedValue({
        id: "device-uuid",
        deviceId: "dev-h1",
      });

      await timeoutListener("device-uuid", {
        texts: ["没关系，我们继续吧。"],
        action: "completed",
      });

      expect(prisma.device.findUnique).toHaveBeenCalledWith({
        where: { id: "device-uuid" },
      });
      expect(uploadedChunks().map((chunk) => chunk.delta)).toEqual([
        "没关系，我们继续吧。",
        "",
      ]);
      expect(prisma.message.create).toHaveBeenCalledTimes(1);
      expect(prisma.message.create.mock.calls[0][0].data.role).toBe(
        "assistant",
      );
    });
  });

  describe("handleStatusReport", () => {
    it("should return success with deviceId", async () => {
      const dto: VendorStatusDto = {
        deviceId: "dev-001",
        online: true,
        batteryPercent: 80,
        charging: false,
        signalStrength: -50,
      };

      const result = await service.handleStatusReport(dto);

      expect(result).toEqual({
        success: true,
        deviceId: "dev-001",
      });
    });
  });

  describe("handleBindCallback", () => {
    it("should return success with bound status", async () => {
      const dto: VendorBindDto = {
        deviceId: "dev-001",
        serialNumber: "SN123456",
        bound: true,
        userOpenid: "openid-xxx",
      };

      const result = await service.handleBindCallback(dto);

      expect(result).toEqual({
        success: true,
        deviceId: "dev-001",
        bound: true,
      });
    });

    it("should default bound to true when omitted", async () => {
      const dto: VendorBindDto = {
        deviceId: "dev-002",
      };

      const result = await service.handleBindCallback(dto);

      expect(result.bound).toBe(true);
    });
  });

  describe("handleConversationBackup", () => {
    it("should return success with idempotency key", async () => {
      const dto: VendorConversationDto = {
        deviceId: "dev-001",
        userText: "你好",
        aiText: "你好呀",
        startedAt: Date.now(),
        endedAt: Date.now(),
      };

      const result = await service.handleConversationBackup(dto, "key-001");

      expect(result).toEqual({
        success: true,
        idempotencyKey: "key-001",
      });
    });

    it("should handle missing idempotency key", async () => {
      const dto: VendorConversationDto = {
        deviceId: "dev-001",
        userText: "你好",
        aiText: "你好呀",
      };

      const result = await service.handleConversationBackup(dto);

      expect(result).toEqual({
        success: true,
        idempotencyKey: null,
      });
    });
  });

  describe("getHealth", () => {
    it("should return up status and timestamp", () => {
      const before = Date.now();
      const result = service.getHealth();
      const after = Date.now();

      expect(result.status).toBe("up");
      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(after);
      expect(result.expectedRecovery).toBeNull();
    });
  });

  describe("child safety layers", () => {
    const setupFreeChatDevice = () => {
      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-001",
        deviceId: "dev-001",
      });
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "free_chat",
      });
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "m-1" });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "x" },
      ]);
    };

    it("L1 blocks explicit self-harm words before adventure and any LLM call", async () => {
      setupFreeChatDevice();

      const result = await service.handleTextIn({
        deviceId: "dev-001",
        asrText: "我不想活了",
      });

      expect(adventureService.handleChildReply).not.toHaveBeenCalled();
      expect(llmService.completeStream).not.toHaveBeenCalled();
      expect(llmService.complete).not.toHaveBeenCalled();
      expect(result.responseText).toMatch(/爸爸妈妈/);
      const chunks = uploadedChunks();
      expect(chunks.every((c) => c.source === "answer")).toBe(true);
      expect(chunks.map((c) => c.delta).join("")).toContain("陪着你");

      const creates = prisma.message.create.mock.calls.map(
        (call) => call[0].data,
      );
      expect(creates[0]).toMatchObject({
        role: "user",
        content: "我不想活了",
        mode: "free_chat",
      });
      expect(creates[1]).toMatchObject({
        role: "assistant",
        mode: "free_chat",
      });
      expect(creates[1].rawPayload).toMatchObject({
        safetyCategory: "self_harm",
        safetyLayer: "L1",
      });
    });

    it("L2 blocks paraphrased sexual content that dodged the L1 wordlist", async () => {
      setupFreeChatDevice();
      llmService.complete.mockResolvedValue({ text: "sexual" });

      const result = await service.handleTextIn({
        deviceId: "dev-001",
        asrText: "大人关门以后在干什么呀",
      });

      expect(llmService.completeStream).not.toHaveBeenCalled();
      expect(result.responseText).toMatch(/长大一点/);
      const creates = prisma.message.create.mock.calls.map(
        (call) => call[0].data,
      );
      expect(creates[1].rawPayload).toMatchObject({
        safetyCategory: "sexual",
        safetyLayer: "L2",
      });
    });

    it("emotional outburst passes through with empathy guidance in the main model prompt", async () => {
      setupFreeChatDevice();
      llmService.complete.mockResolvedValue({ text: "emotional_harm" });
      mockAnswerStream("是不是和弟弟吵架了呀？");

      const result = await service.handleTextIn({
        deviceId: "dev-001",
        asrText: "我要杀了我的弟弟",
      });

      const bigModelCall = llmService.completeStream.mock.calls.find(
        ([options]) => options.model !== "small-llm",
      );
      expect(bigModelCall).toBeTruthy();
      const messages = bigModelCall![0].messages as Array<{
        role: string;
        content: string;
      }>;
      const guidance = messages.find(
        (m) => m.role === "system" && m.content.includes("共情"),
      );
      expect(guidance).toBeTruthy();
      expect(guidance!.content).toContain("绝不附和");
      expect(result.responseText).toContain("是不是和弟弟吵架了呀");
    });
  });
});
