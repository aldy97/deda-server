import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { VendorService } from "./vendor.service";
import { VendorReplyUploader } from "./vendor-reply.uploader";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RagService } from "@/modules/rag/rag.service";
import { LlmService } from "@/modules/llm/llm.service";
import { VendorTextInDto } from "./dto/vendor-text-in.dto";
import { VendorTextChunkDto } from "./dto/vendor-text-chunk.dto";
import { VendorStatusDto } from "./dto/vendor-status.dto";
import { VendorBindDto } from "./dto/vendor-bind.dto";
import { VendorConversationDto } from "./dto/vendor-conversation.dto";

describe("VendorService", () => {
  let service: VendorService;
  let prisma: any;
  let ragService: jest.Mocked<RagService>;
  let llmService: jest.Mocked<LlmService>;
  let configService: jest.Mocked<ConfigService>;
  let replyUploader: { sendChunk: jest.Mock; sendFullReply: jest.Mock };

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
        VendorService,
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
            conversationMode: {
              findFirst: jest.fn(),
            },
            textbook: {
              findUnique: jest.fn(),
            },
            unit: {
              findUnique: jest.fn(),
            },
            message: {
              findMany: jest.fn(),
              create: jest.fn(),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const map: Record<string, string> = {
                DEFAULT_TEXTBOOK_ID: "sample-textbook",
                DEFAULT_UNIT_ID: "unit-1",
              };
              return map[key];
            }),
          },
        },
        {
          provide: RagService,
          useValue: {
            retrieve: jest.fn(),
            truncateContent: jest.fn((content: string) => content),
          },
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
          provide: VendorReplyUploader,
          useValue: {
            sendChunk: jest.fn(),
            sendFullReply: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<VendorService>(VendorService);
    prisma = module.get(PrismaService);
    ragService = module.get(RagService);
    llmService = module.get(LlmService);
    configService = module.get(ConfigService);
    replyUploader = module.get(VendorReplyUploader) as any;

    replyUploader.sendChunk.mockResolvedValue(undefined);
    replyUploader.sendFullReply.mockResolvedValue(undefined);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("handleTextIn", () => {
    it("should call RAG and LLM, ensure device exists, and persist conversation", async () => {
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
        mode: "locked_unit",
        textbookId: "sample-textbook",
        unitId: "unit-1",
        conversationModeKey: null,
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.textbook.findUnique.mockResolvedValue({
        id: "book-uuid",
        textbookId: "sample-textbook",
        promptTemplate: null,
      } as any);
      prisma.unit.findUnique.mockResolvedValue({
        id: "unit-uuid",
        unitId: "unit-1",
      } as any);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-001" } as any);
      ragService.retrieve.mockResolvedValue({
        textbookId: "sample-textbook",
        unitId: "unit-1",
        unitName: "Greetings",
        content: "Hello! How are you?",
        found: true,
      });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "你好" },
      ] as any);
      mockAnswerStream("Hello! I'm fine, thank you.");

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
      expect(prisma.textbook.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { textbookId: "sample-textbook" },
        }),
      );
      expect(ragService.retrieve).toHaveBeenCalledWith(
        "sample-textbook",
        "unit-1",
        "你好",
      );
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
          textbookId: "sample-textbook",
          unitId: "unit-1",
        }),
      );
      // 落库为用户实际播报全文：小模型 filler + 大模型答案
      expect(assistantCall[0].data).toEqual(
        expect.objectContaining({
          deviceId: "uuid-001",
          role: "assistant",
          content: "嗯\nHello! I'm fine, thank you.",
          turnId: userCall[0].data.turnId,
          status: "completed",
          textbookId: "sample-textbook",
          unitId: "unit-1",
        }),
      );
      // user 消息必须在 LLM 调用之前写入
      const userWriteOrder = prisma.message.create.mock.invocationCallOrder[0];
      const llmOrder = llmService.completeStream.mock.invocationCallOrder[0];
      expect(userWriteOrder).toBeLessThan(llmOrder);
      expect(result).toEqual({
        deviceId: "dev-001",
        responseText: "嗯\nHello! I'm fine, thank you.",
        context: {
          textbookId: "sample-textbook",
          unitId: "unit-1",
          unitName: "Greetings",
          ragFound: true,
        },
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

    it("should use payload textbookId/unitId when provided", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-002",
        asrText: "What color is it?",
        textbookId: "custom-book",
        unitId: "unit-colors",
      };

      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-002",
        deviceId: "dev-002",
      } as any);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-002" } as any);
      ragService.retrieve.mockResolvedValue({
        textbookId: "custom-book",
        unitId: "unit-colors",
        unitName: "Colors",
        content: "Red, blue, green.",
        found: true,
      });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "What color is it?" },
      ] as any);
      mockAnswerStream("It's red.");

      const result = await service.handleTextIn(dto);

      expect(ragService.retrieve).toHaveBeenCalledWith(
        "custom-book",
        "unit-colors",
        "What color is it?",
      );
      expect(result.context).toEqual({
        textbookId: "custom-book",
        unitId: "unit-colors",
        unitName: "Colors",
        ragFound: true,
      });
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
        mode: "locked_unit",
        textbookId: "sample-textbook",
        unitId: "unit-1",
        conversationModeKey: null,
      } as any);
      prisma.textbook.findUnique.mockResolvedValue({
        id: "book-uuid",
        textbookId: "sample-textbook",
        promptTemplate: null,
      } as any);
      prisma.unit.findUnique.mockResolvedValue({
        id: "unit-uuid",
        unitId: "unit-1",
      } as any);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-003" } as any);
      ragService.retrieve.mockResolvedValue({
        textbookId: "sample-textbook",
        unitId: "unit-1",
        unitName: "Greetings",
        content: "Hello!",
        found: true,
      });
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
      expect(result.context).toEqual({
        textbookId: "sample-textbook",
        unitId: "unit-1",
        unitName: "Greetings",
        ragFound: true,
      });

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
      ragService.retrieve.mockResolvedValue({
        textbookId: "sample-textbook",
        unitId: "unit-1",
        unitName: "Greetings",
        content: "Hello!",
        found: true,
      });
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

    it("should pass child profile and textbook prompt template to prompt builder", async () => {
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
      const textbookTemplate =
        "You are a friendly English tutor for Chinese children.";

      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-001",
        deviceId: "dev-001",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "locked_unit",
        textbookId: "sample-textbook",
        unitId: "unit-1",
        conversationModeKey: null,
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(childProfile as any);
      prisma.textbook.findUnique.mockResolvedValue({
        promptTemplate: textbookTemplate,
      } as any);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-001" } as any);
      ragService.retrieve.mockResolvedValue({
        textbookId: "sample-textbook",
        unitId: "unit-1",
        unitName: "Greetings",
        content: "Hello!",
        found: true,
      });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Hello" },
      ] as any);
      mockAnswerStream("Hi Alice!");

      await service.handleTextIn(dto);

      expect(llmService.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "Hello",
        "Hello!",
        "Greetings",
        [],
        expect.objectContaining({
          childProfile: {
            name: "Alice",
            birthday: "2018-05-20",
            englishName: "Ali",
          },
          promptTemplate: textbookTemplate,
          mode: "locked_unit",
        }),
      );
    });

    it("should fetch conversation mode prompt template in free_chat mode", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-001",
        asrText: "Hi",
      };
      const modeTemplate = "You are a casual chat partner for kids.";

      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-001",
        deviceId: "dev-001",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "free_chat",
        textbookId: null,
        unitId: null,
        conversationModeKey: "free_chat_casual",
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.conversationMode.findFirst.mockResolvedValue({
        promptTemplate: modeTemplate,
      } as any);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-001" } as any);
      ragService.retrieve.mockResolvedValue({
        textbookId: "sample-textbook",
        unitId: "unit-1",
        unitName: "Greetings",
        content: "",
        found: false,
      });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Hi" },
      ] as any);
      mockAnswerStream("Hey there!");

      await service.handleTextIn(dto);

      expect(prisma.conversationMode.findFirst).toHaveBeenCalledWith({
        where: { key: "free_chat_casual" },
        select: { promptTemplate: true },
      });
      expect(prisma.textbook.findUnique).not.toHaveBeenCalled();
      expect(llmService.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "Hi",
        "",
        "Greetings",
        [],
        expect.objectContaining({
          childProfile: undefined,
          promptTemplate: modeTemplate,
          mode: "free_chat",
          conversationModeKey: "free_chat_casual",
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
        mode: "locked_unit",
        textbookId: "sample-textbook",
        unitId: "unit-1",
        conversationModeKey: null,
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.textbook.findUnique.mockResolvedValue({
        promptTemplate: null,
      } as any);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-001" } as any);
      ragService.retrieve.mockResolvedValue({
        textbookId: "sample-textbook",
        unitId: "unit-1",
        unitName: "Greetings",
        content: "Hello!",
        found: true,
      });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Hello" },
      ] as any);
      mockAnswerStream("Hi!");

      await service.handleTextIn(dto);

      expect(llmService.buildEnglishTutorPrompt).toHaveBeenCalledWith(
        "Hello",
        "Hello!",
        "Greetings",
        [],
        expect.objectContaining({
          childProfile: undefined,
          promptTemplate: undefined,
          mode: "locked_unit",
        }),
      );
    });

    it("should validate textbook and unit before persisting locked_unit conversation", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-001",
        asrText: "Hello",
      };

      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-001",
        deviceId: "dev-001",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "locked_unit",
        textbookId: "valid-book",
        unitId: "valid-unit",
        conversationModeKey: null,
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.textbook.findUnique.mockResolvedValue({
        id: "book-uuid",
        textbookId: "valid-book",
      } as any);
      prisma.unit.findUnique.mockResolvedValue({ id: "unit-uuid" } as any);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-001" } as any);
      ragService.retrieve.mockResolvedValue({
        textbookId: "valid-book",
        unitId: "valid-unit",
        unitName: "Valid Unit",
        content: "Hello!",
        found: true,
      });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Hello" },
      ] as any);
      mockAnswerStream("Hi!");

      await service.handleTextIn(dto);

      expect(prisma.textbook.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { textbookId: "valid-book" },
        }),
      );
      expect(prisma.unit.findUnique).toHaveBeenCalledWith({
        where: {
          textbookId_unitId: {
            textbookId: "book-uuid",
            unitId: "valid-unit",
          },
        },
      });
      expect(prisma.message.create).toHaveBeenCalled();
    });

    it("should not persist conversation when textbook does not exist for locked_unit", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-001",
        asrText: "Hello",
      };

      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-001",
        deviceId: "dev-001",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "locked_unit",
        textbookId: "invalid-book",
        unitId: "unit-1",
        conversationModeKey: null,
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.textbook.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([]);
      ragService.retrieve.mockResolvedValue({
        textbookId: "invalid-book",
        unitId: "unit-1",
        unitName: "Invalid",
        content: "",
        found: false,
      });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Hello" },
      ] as any);
      mockAnswerStream("Hi!");

      const result = await service.handleTextIn(dto);

      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(result.responseText).toBe("嗯\nHi!");
    });

    it("should not persist conversation when unit does not exist for locked_unit", async () => {
      const dto: VendorTextInDto = {
        deviceId: "dev-001",
        asrText: "Hello",
      };

      prisma.device.findUnique.mockResolvedValue({
        id: "uuid-001",
        deviceId: "dev-001",
      } as any);
      prisma.deviceConfig.findFirst.mockResolvedValue({
        mode: "locked_unit",
        textbookId: "valid-book",
        unitId: "invalid-unit",
        conversationModeKey: null,
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.textbook.findUnique.mockResolvedValue({
        id: "book-uuid",
        textbookId: "valid-book",
      } as any);
      prisma.unit.findUnique.mockResolvedValue(null);
      prisma.message.findMany.mockResolvedValue([]);
      ragService.retrieve.mockResolvedValue({
        textbookId: "valid-book",
        unitId: "invalid-unit",
        unitName: "Invalid",
        content: "",
        found: false,
      });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Hello" },
      ] as any);
      mockAnswerStream("Hi!");

      const result = await service.handleTextIn(dto);

      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(result.responseText).toBe("嗯\nHi!");
    });

    it("should persist free_chat conversation without textbook/unit validation", async () => {
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
        textbookId: null,
        unitId: null,
        conversationModeKey: "free_chat_casual",
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.conversationMode.findFirst.mockResolvedValue({
        promptTemplate: null,
      } as any);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-001" } as any);
      ragService.retrieve.mockResolvedValue({
        textbookId: "sample-textbook",
        unitId: "unit-1",
        unitName: "Greetings",
        content: "",
        found: false,
      });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "Hi" },
      ] as any);
      mockAnswerStream("Hey!");

      await service.handleTextIn(dto);

      expect(prisma.textbook.findUnique).not.toHaveBeenCalled();
      expect(prisma.unit.findUnique).not.toHaveBeenCalled();
      // user + assistant 两条消息共享 turnId
      expect(prisma.message.create).toHaveBeenCalledTimes(2);
      const [userCall, assistantCall] = prisma.message.create.mock.calls;
      expect(userCall[0].data).toEqual(
        expect.objectContaining({
          deviceId: "uuid-001",
          role: "user",
          content: "Hi",
          mode: "free_chat",
          conversationModeKey: "free_chat_casual",
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
          conversationModeKey: "free_chat_casual",
          turnId: userCall[0].data.turnId,
        }),
      );
      // free_chat 消息不得携带教材/单元快照（否则污染教材统计与 isActive 判定）
      expect(userCall[0].data.textbookId).toBeNull();
      expect(userCall[0].data.unitId).toBeNull();
      expect(assistantCall[0].data.textbookId).toBeNull();
      expect(assistantCall[0].data.unitId).toBeNull();
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
        mode: "locked_unit",
        textbookId: "sample-textbook",
        unitId: "unit-1",
        conversationModeKey: null,
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.textbook.findUnique.mockResolvedValue({
        id: "book-uuid",
        textbookId: "sample-textbook",
        promptTemplate: null,
      } as any);
      prisma.unit.findUnique.mockResolvedValue({
        id: "unit-uuid",
        unitId: "unit-1",
      } as any);
      prisma.message.findMany.mockResolvedValue([]);
      prisma.message.create.mockResolvedValue({ id: "conv-s1" } as any);
      ragService.retrieve.mockResolvedValue({
        textbookId: "sample-textbook",
        unitId: "unit-1",
        unitName: "Greetings",
        content: "Hello!",
        found: true,
      });
      llmService.buildEnglishTutorPrompt.mockReturnValue([
        { role: "system", content: "prompt" },
        { role: "user", content: "我喜欢上海的天气" },
      ] as any);
    };

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
          DEFAULT_TEXTBOOK_ID: "sample-textbook",
          DEFAULT_UNIT_ID: "unit-1",
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
        mode: "locked_unit",
        textbookId: "sample-textbook",
        unitId: "unit-1",
        conversationModeKey: null,
      } as any);
      prisma.childProfile.findUnique.mockResolvedValue(null);
      prisma.textbook.findUnique.mockResolvedValue({
        id: "book-uuid",
        textbookId: "sample-textbook",
        promptTemplate: null,
      } as any);
      prisma.unit.findUnique.mockResolvedValue({
        id: "unit-uuid",
        unitId: "unit-1",
      } as any);
      prisma.message.create.mockResolvedValue({ id: "conv-h1" } as any);
      ragService.retrieve.mockResolvedValue({
        textbookId: "sample-textbook",
        unitId: "unit-1",
        unitName: "Greetings",
        content: "Hello!",
        found: true,
      });
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
        "Hello!",
        "Greetings",
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
});
