import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { LlmService, LlmUpstreamError } from "./llm.service";
import * as llmCostUtil from "./llm-cost.util";
import { PrismaService } from "@/common/prisma/prisma.service";
import { PROMPT_REGISTRY_PROVIDER } from "@/modules/prompt-registry/prompt-registry.testing";
import axios from "axios";
import { Readable } from "stream";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const PRISMA_MOCK = {
  provide: PrismaService,
  useValue: { llmUsageLog: { create: jest.fn().mockResolvedValue({}) } },
};

describe("LlmService", () => {
  let service: LlmService;
  let prismaMock: { llmUsageLog: { create: jest.Mock } };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PROMPT_REGISTRY_PROVIDER,
        LlmService,
        PROMPT_REGISTRY_PROVIDER,
        PRISMA_MOCK,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const map: Record<string, string> = {
                OPENAI_BASE_URL: "https://api.deepseek.com/v1",
                OPENAI_API_KEY: "sk-test",
                OPENAI_MODEL: "deepseek-flash",
                SMALL_LLM_MODEL: "qwen-flash",
                LLM_TIMEOUT_MS: "30000",
              };
              return map[key];
            }),
          },
        },
      ],
    }).compile();

    service = module.get<LlmService>(LlmService);
    prismaMock = module.get(PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("complete", () => {
    it("should call chat completions and return text", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          choices: [
            {
              message: {
                content: "Hello! I am fine, thank you.",
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
          },
        },
      } as any);

      const result = await service.complete({
        scene: "chat_main",
        messages: [
          { role: "system", content: "You are a tutor." },
          { role: "user", content: "How are you?" },
        ],
      });

      expect(result.text).toBe("Hello! I am fine, thank you.");
      expect(result.usage).toEqual({
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
      });
      expect(mockedAxios.post).toHaveBeenCalledWith(
        "https://api.deepseek.com/v1/chat/completions",
        expect.objectContaining({
          model: "deepseek-flash",
          messages: [
            { role: "system", content: "You are a tutor." },
            { role: "user", content: "How are you?" },
          ],
          temperature: 0.7,
          max_tokens: 512,
          thinking: { type: "disabled" },
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-test",
          }),
          timeout: 30000,
        }),
      );
    });

    it("should persist turnId to the usage log when provided", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { choices: [{ message: { content: "ok" } }] },
      } as any);

      await service.complete({
        scene: "chat_main",
        turnId: "turn-abc",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ turnId: "turn-abc" }),
      });
    });

    it("should persist null turnId when not provided", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { choices: [{ message: { content: "ok" } }] },
      } as any);

      await service.complete({
        scene: "chat_main",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ turnId: null }),
      });
    });

    it("should throw error when API key is missing", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PROMPT_REGISTRY_PROVIDER,
          LlmService,
          PROMPT_REGISTRY_PROVIDER,
          PRISMA_MOCK,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockReturnValue(""),
            },
          },
        ],
      }).compile();
      const noKeyService = module.get<LlmService>(LlmService);

      await expect(
        noKeyService.complete({
          scene: "chat_main",
          messages: [{ role: "user", content: "Hi" }],
        }),
      ).rejects.toThrow("LLM API key is not configured");
    });

    it("should throw error when API request fails", async () => {
      mockedAxios.post.mockRejectedValueOnce({
        message: "Network error",
        response: { data: { error: "invalid request" } },
      } as any);

      await expect(
        service.complete({
          scene: "chat_main",
          messages: [{ role: "user", content: "Hi" }],
        }),
      ).rejects.toThrow("LLM request failed");
    });
  });

  describe("buildAdventureInteractionPrompt", () => {
    it("should inject the persona and interaction context without allowing story generation", () => {
      const messages = service.buildAdventureInteractionPrompt({
        characterPersona: "小象 Elly：温暖好奇，喜欢用「呀」结尾。",
        segmentText: "你觉得 Elly 会怎么做呢？",
        childReply: "它会请小松鼠帮忙",
        kind: "open_question",
      });

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain("小象 Elly");
      expect(messages[0].content).toContain("你觉得 Elly 会怎么做呢？");
      expect(messages[0].content).toContain("1-2 句");
      expect(messages[0].content).toContain("禁止续写、改写或剧透主线");
      expect(messages[0].content).toContain("禁止连续追问");
      expect(messages[0].content).toContain("禁止批评");
      expect(messages[1]).toEqual({
        role: "user",
        content: "它会请小松鼠帮忙",
      });
    });

    it("should require an off-topic redirect to acknowledge before returning to the question", () => {
      const messages = service.buildAdventureInteractionPrompt({
        characterPersona: "小象 Elly",
        segmentText: "我们去森林还是去河边？",
        childReply: "我想吃冰淇淋",
        kind: "redirect",
      });

      expect(messages[0].content).toContain("先接住孩子的话题");
      expect(messages[0].content).toContain("再自然引回当前互动问题");
      expect(messages[0].content).toContain("我们去森林还是去河边？");
    });
  });

  describe("buildEnglishTutorPrompt", () => {
    it("should include open English chat rules and user message", () => {
      const messages = service.buildEnglishTutorPrompt("How are you?");

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain(
        "friendly English-speaking AI companion",
      );
      expect(messages[0].content).toContain("open English conversation");
      expect(messages[0].content).not.toContain("textbook");
      expect(messages[0].content).not.toContain("unit topic");
      expect(messages[1].role).toBe("user");
      expect(messages[1].content).toBe("How are you?");
    });

    it("should inject the character persona when characterKey is provided", () => {
      const messages = service.buildEnglishTutorPrompt(
        "你叫什么名字？",
        undefined,
        {
          mode: "free_chat",
          characterKey: "elly",
        },
      );

      // 人设注入：模型始终以该角色自居（含自报名字）
      expect(messages[0].content).toContain("Character identity");
      expect(messages[0].content).toContain("小象 Elly");
      // 历史污染纠正指令：历史中的错误名字不得沿用
      expect(messages[0].content).toContain("never repeat it");
    });

    it("should fall back to elly persona for unknown or absent characterKey", () => {
      const unknown = service.buildEnglishTutorPrompt("Hello", undefined, {
        characterKey: "nonexistent",
      });
      expect(unknown[0].content).toContain("小象 Elly");

      // 未建档/匿名设备也必须有人设兜底，杜绝主模型编造身份
      const without = service.buildEnglishTutorPrompt("Hello");
      expect(without[0].content).toContain("小象 Elly");
    });

    it("handoff 不再内嵌 system prompt：buildEnglishTutorPrompt 无 fillerHeard 参数", () => {
      for (const mode of ["free_chat", "idiom_story", "english_chat"]) {
        const messages = service.buildEnglishTutorPrompt(
          "球不见了",
          undefined,
          { mode },
        );
        // 方案 B：handoff 改由 buildFillerHandoffMessage 产出独立 system
        // 消息贴 user 消息前注入，主 prompt 不再携带任何承接相关内容
        expect(messages[0].content).not.toContain("承接语");
        expect(messages[0].content).not.toContain("already finished playing");
        expect(messages[0].content).not.toContain("never repeat or paraphrase");
      }
    });

    it("事实边界：爱丽/艾丽是 Elly 误听须认领，想象陈述不得确认为事实", () => {
      for (const mode of ["free_chat", "english_chat"]) {
        const messages = service.buildEnglishTutorPrompt(
          "听风原野里有爱丽",
          undefined,
          { mode },
        );
        // 实机事故：主模型把 ASR 误听变体当成新朋友，还说「我记下啦」
        expect(messages[0].content).toContain("爱丽");
        expect(messages[0].content).toContain("我记下啦");
      }
    });

    it("人设段固定中文自称写法，防止「艾莉/Elly」不一致", () => {
      const messages = service.buildEnglishTutorPrompt("你好", undefined, {
        characterKey: "elly",
      });
      expect(messages[0].content).toContain("自称固定为");
    });

    it("should include conversation history", () => {
      const messages = service.buildEnglishTutorPrompt("I'm fine.", [
        { role: "user", content: "How are you?" },
        { role: "assistant", content: "I am fine, thank you." },
      ]);

      expect(messages).toHaveLength(4);
      expect(messages[0].role).toBe("system");
      expect(messages[1]).toEqual({ role: "user", content: "How are you?" });
      expect(messages[2]).toEqual({
        role: "assistant",
        content: "I am fine, thank you.",
      });
      expect(messages[3]).toEqual({ role: "user", content: "I'm fine." });
    });

    it("should build an English chat without textbook context", () => {
      const messages = service.buildEnglishTutorPrompt("Hello", undefined, {
        mode: "english_chat",
      });

      expect(messages[0].content).toContain(
        "friendly English-speaking AI companion",
      );
      expect(messages[0].content).not.toContain("textbook");
      expect(messages[0].content).not.toContain("unit topic");
    });

    it("should use direct child-language rules for free chat", () => {
      const messages = service.buildEnglishTutorPrompt(
        "你还记得我最喜欢什么颜色吗？",
        undefined,
        { mode: "free_chat" },
      );

      expect(messages[0].content).toContain("same language");
      expect(messages[0].content).toContain("current question");
      expect(messages[0].content).toContain("child_memories");
      expect(messages[0].content).toContain("older conversation history");
      expect(messages[0].content).not.toContain("Reply in English only");
      expect(messages[0].content).not.toContain("unit topic");
      expect(messages[0].content).not.toContain("free English chat");
    });

    it("should not impose English tutor rules on Chinese story modes", () => {
      const messages = service.buildEnglishTutorPrompt(
        "讲一个守株待兔的故事",
        undefined,
        {
          mode: "idiom_story",
          promptTemplate: "用中文讲一个适合孩子的成语故事。",
        },
      );

      expect(messages[0].content).toContain("用中文讲一个适合孩子的成语故事");
      expect(messages[0].content).not.toContain("Reply in English only");
      expect(messages[0].content).not.toContain("unit topic");
      expect(messages[0].content).not.toContain("free English chat");
    });

    it("should include child profile in system prompt", () => {
      const messages = service.buildEnglishTutorPrompt("Hello", undefined, {
        childProfile: {
          name: "Alice",
          birthday: "2018-05-20",
          englishName: "Ali",
        },
      });

      expect(messages[0].content).toContain("Child Profile");
      expect(messages[0].content).toContain("Name: Alice");
      expect(messages[0].content).toContain("Birthday: 2018-05-20");
      expect(messages[0].content).toContain("English name: Ali");
      // 由生日换算年龄（2018-05 → 当前 7-8 岁，视今年生日是否已过）
      expect(messages[0].content).toMatch(/Age: [78] years old/);
      expect(messages[0].content).toContain(
        "Address the child naturally by their English name or name",
      );
    });

    it("should include gender guidance when provided", () => {
      const girl = service.buildEnglishTutorPrompt("Hello", undefined, {
        childProfile: { name: "莉莉", gender: "female" },
      });
      expect(girl[0].content).toContain("Gender: girl (she/her");

      const boy = service.buildEnglishTutorPrompt("Hello", undefined, {
        childProfile: { name: "豆豆", gender: "male" },
      });
      expect(boy[0].content).toContain("Gender: boy (he/him");

      // 未设置性别不输出该字段
      const unset = service.buildEnglishTutorPrompt("Hello", undefined, {
        childProfile: { name: "豆豆" },
      });
      expect(unset[0].content).not.toContain("Gender:");
    });

    it("should use prompt template when provided", () => {
      const template = "You are a pirate tutor. Speak like a pirate.";
      const messages = service.buildEnglishTutorPrompt("Hello", undefined, {
        promptTemplate: template,
      });

      expect(messages[0].content).toContain(template);
      expect(messages[0].content).toContain(
        "In addition, always follow these general rules",
      );
      expect(messages[0].content).toContain(
        "friendly English-speaking AI companion",
      );
    });

    it("should concatenate child profile, prompt template, and default rules", () => {
      const template = "Focus on daily routines.";
      const messages = service.buildEnglishTutorPrompt(
        "Good morning",
        undefined,
        {
          childProfile: { name: "Bob", englishName: "Bobby" },
          promptTemplate: template,
        },
      );

      const system = messages[0].content;
      expect(system.indexOf("Child Profile")).toBeLessThan(
        system.indexOf(template),
      );
      expect(system.indexOf(template)).toBeLessThan(
        system.indexOf("general rules"),
      );
      expect(system).toContain("Name: Bob");
      expect(system).toContain("English name: Bobby");
      expect(system).not.toContain("textbook");
    });

    it("should keep default behavior when options are omitted", () => {
      const messagesWithOptions = service.buildEnglishTutorPrompt(
        "Hello",
        undefined,
        {},
      );
      const messagesWithoutOptions = service.buildEnglishTutorPrompt("Hello");

      expect(messagesWithOptions[0].content).toBe(
        messagesWithoutOptions[0].content,
      );
    });
  });

  describe("buildFillerHandoffMessage", () => {
    it("产出贴 user 消息前的独立 system 消息：filler 原文 + 三条衔接禁令", () => {
      const msg = service.buildFillerHandoffMessage(
        "原来你喜欢上海的天气呀，快多跟我说说呢……",
      );

      // 方案 B：handoff 是独立 system 消息（非内嵌主 prompt），
      // 由调用方 splice 到本轮 user 消息前，离生成点最近
      expect(msg.role).toBe("system");
      expect(msg.content).toContain(
        "「原来你喜欢上海的天气呀，快多跟我说说呢……」",
      );
      expect(msg.content).toContain("直接从实质内容起句");
      expect(msg.content).toContain("不要以孩子的名字开头");
      expect(msg.content).toContain("语气词");
      expect(msg.content).toContain("不要重复或换写承接语已经表达过的意象");
    });

    it("附好/坏起句示范，让禁令可模仿", () => {
      const msg = service.buildFillerHandoffMessage("嗯嗯，我在认真听呢……");

      expect(msg.content).toContain("好例");
      expect(msg.content).toContain("坏例");
    });

    it("注入前清洗：换行与多余空白压平、截断 100 字（防小模型产出污染指令位）", () => {
      const messy =
        service.buildFillerHandoffMessage("第一行\n第二行   多空格");
      expect(messy.content).toContain("「第一行 第二行 多空格」");

      const long = service.buildFillerHandoffMessage("字".repeat(150));
      expect(long.content).toContain(`「${"字".repeat(100)}」`);
      expect(long.content).not.toContain("字".repeat(101));
    });
  });

  describe("completeStream", () => {
    const collectStream = async (
      gen: AsyncGenerator<string>,
    ): Promise<string[]> => {
      const deltas: string[] = [];
      for await (const delta of gen) {
        deltas.push(delta);
      }
      return deltas;
    };

    it("should yield delta content from SSE chunks in order", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: Readable.from([
          'data: {"choices":[{"delta":{"content":"原来"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"你喜欢上海"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"的天气呀"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      } as any);

      const deltas = await collectStream(
        service.completeStream({
          scene: "chat_main",
          messages: [{ role: "user", content: "我喜欢上海的天气" }],
        }),
      );

      expect(deltas).toEqual(["原来", "你喜欢上海", "的天气呀"]);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        "https://api.deepseek.com/v1/chat/completions",
        expect.objectContaining({
          model: "deepseek-flash",
          stream: true,
          messages: [{ role: "user", content: "我喜欢上海的天气" }],
        }),
        expect.objectContaining({ responseType: "stream" }),
      );
    });

    it("should persist turnId for streaming calls", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: Readable.from([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      } as any);

      await collectStream(
        service.completeStream({
          scene: "chat_main",
          turnId: "turn-stream-1",
          messages: [{ role: "user", content: "hi" }],
        }),
      );

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ turnId: "turn-stream-1" }),
      });
    });

    it("should use the overridden model when provided", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: Readable.from([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      } as any);

      await collectStream(
        service.completeStream({
          scene: "chat_main",
          messages: [{ role: "user", content: "Hi" }],
          model: "small-model",
        }),
      );

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ model: "small-model", stream: true }),
        expect.any(Object),
      );
    });

    it("should call the small-model base URL with its own API key when configured", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PROMPT_REGISTRY_PROVIDER,
          LlmService,
          PROMPT_REGISTRY_PROVIDER,
          PRISMA_MOCK,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => {
                const map: Record<string, string> = {
                  OPENAI_BASE_URL: "https://api.deepseek.com/v1",
                  OPENAI_API_KEY: "sk-primary",
                  OPENAI_MODEL: "deepseek-flash",
                  SMALL_LLM_BASE_URL:
                    "https://dashscope.aliyuncs.com/compatible-mode/v1",
                  SMALL_LLM_API_KEY: "sk-qwen",
                  SMALL_LLM_MODEL: "qwen-flash",
                };
                return map[key];
              }),
            },
          },
        ],
      }).compile();
      const dualModelService = module.get<LlmService>(LlmService);

      mockedAxios.post.mockResolvedValueOnce({
        data: Readable.from([
          'data: {"choices":[{"delta":{"content":"原来"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      } as any);

      await collectStream(
        dualModelService.completeStream({
          scene: "chat_main",
          messages: [{ role: "user", content: "我喜欢上海的天气" }],
          model: "qwen-flash",
        }),
      );

      // 小模型请求路由到百炼端点并使用独立 key
      expect(mockedAxios.post).toHaveBeenCalledWith(
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        expect.objectContaining({ model: "qwen-flash", stream: true }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-qwen",
          }),
        }),
      );
    });

    it("should use small-model credentials for non-streaming adventure bridges", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PROMPT_REGISTRY_PROVIDER,
          LlmService,
          PROMPT_REGISTRY_PROVIDER,
          PRISMA_MOCK,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => {
                const map: Record<string, string> = {
                  OPENAI_BASE_URL: "https://api.deepseek.com/v1",
                  OPENAI_API_KEY: "sk-primary",
                  OPENAI_MODEL: "deepseek-flash",
                  SMALL_LLM_BASE_URL:
                    "https://dashscope.aliyuncs.com/compatible-mode/v1",
                  SMALL_LLM_API_KEY: "sk-qwen",
                  SMALL_LLM_MODEL: "qwen-flash",
                };
                return map[key];
              }),
            },
          },
        ],
      }).compile();
      const dualModelService = module.get<LlmService>(LlmService);
      mockedAxios.post.mockResolvedValueOnce({
        data: { choices: [{ message: { content: "我们继续冒险吧！" } }] },
      } as any);

      await dualModelService.complete({
        scene: "chat_main",
        messages: [{ role: "user", content: "我想吃冰淇淋" }],
        model: "qwen-flash",
      });

      expect(mockedAxios.post).toHaveBeenCalledWith(
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        expect.objectContaining({ model: "qwen-flash" }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-qwen",
          }),
        }),
      );
    });

    it("should fall back to primary credentials when small-model env is not set", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PROMPT_REGISTRY_PROVIDER,
          LlmService,
          PROMPT_REGISTRY_PROVIDER,
          PRISMA_MOCK,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string) => {
                const map: Record<string, string> = {
                  OPENAI_BASE_URL: "https://api.deepseek.com/v1",
                  OPENAI_API_KEY: "sk-test",
                  OPENAI_MODEL: "deepseek-flash",
                  SMALL_LLM_MODEL: "qwen-flash",
                };
                return map[key];
              }),
            },
          },
        ],
      }).compile();
      const fallbackService = module.get<LlmService>(LlmService);

      mockedAxios.post.mockResolvedValueOnce({
        data: Readable.from([
          'data: {"choices":[{"delta":{"content":"嗯"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      } as any);

      await collectStream(
        fallbackService.completeStream({
          scene: "chat_main",
          messages: [{ role: "user", content: "Hi" }],
          model: "qwen-flash",
        }),
      );

      // 未配置 SMALL_LLM_BASE_URL/API_KEY 时回落主端点与主 key
      expect(mockedAxios.post).toHaveBeenCalledWith(
        "https://api.deepseek.com/v1/chat/completions",
        expect.objectContaining({ model: "qwen-flash" }),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-test",
          }),
        }),
      );
    });

    it("should reassemble SSE lines split across network chunks", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: Readable.from([
          'data: {"choices":[{"del',
          'ta":{"content":"He',
          'llo"}}]}\n\nda',
          'ta: {"choices":[{"delta":{"content":" world"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      } as any);

      const deltas = await collectStream(
        service.completeStream({
          scene: "chat_main",
          messages: [{ role: "user", content: "Hi" }],
        }),
      );

      expect(deltas).toEqual(["Hello", " world"]);
    });

    it("should skip keep-alive comments and malformed lines", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: Readable.from([
          ": keep-alive\n\n",
          "data: not-json\n\n",
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
          'data: {"choices":[{"delta":{}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      } as any);

      const deltas = await collectStream(
        service.completeStream({
          scene: "chat_main",
          messages: [{ role: "user", content: "Hi" }],
        }),
      );

      expect(deltas).toEqual(["ok"]);
    });

    it("should throw when API key is missing", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PROMPT_REGISTRY_PROVIDER,
          LlmService,
          PROMPT_REGISTRY_PROVIDER,
          PRISMA_MOCK,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockReturnValue(""),
            },
          },
        ],
      }).compile();
      const noKeyService = module.get<LlmService>(LlmService);

      const gen = noKeyService.completeStream({
        scene: "chat_main",
        messages: [{ role: "user", content: "Hi" }],
      });

      await expect(gen.next()).rejects.toThrow("LLM API key is not configured");
    });

    it("should throw when the streaming request fails", async () => {
      mockedAxios.post.mockRejectedValueOnce({
        message: "Network error",
        response: { status: 500, data: { error: "rate limited" } },
      } as any);

      const gen = service.completeStream({
        scene: "chat_main",
        messages: [{ role: "user", content: "Hi" }],
      });

      await expect(gen.next()).rejects.toBeInstanceOf(LlmUpstreamError);
    });

    it("超时失败抛 LlmUpstreamError：reason=timeout、可重试、detail 含 code", async () => {
      mockedAxios.post.mockRejectedValueOnce({
        message: "timeout of 30000ms exceeded",
        code: "ECONNABORTED",
      } as any);
      const gen = service.completeStream({
        scene: "chat_main",
        messages: [{ role: "user", content: "Hi" }],
      });
      const err: unknown = await gen.next().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmUpstreamError);
      const upstreamErr = err as LlmUpstreamError;
      expect(upstreamErr.reason).toBe("timeout");
      expect(upstreamErr.retriable).toBe(true);
      expect(upstreamErr.detail).toContain("ECONNABORTED");
    });

    it("HTTP 429 → reason=rate_limit、可重试", async () => {
      mockedAxios.post.mockRejectedValueOnce({
        message: "rate limited",
        response: { status: 429, data: { error: "rate limited" } },
      } as any);
      const gen = service.completeStream({
        scene: "chat_main",
        messages: [{ role: "user", content: "Hi" }],
      });
      const err = (await gen
        .next()
        .catch((e: unknown) => e)) as LlmUpstreamError;
      expect(err).toBeInstanceOf(LlmUpstreamError);
      expect(err.reason).toBe("rate_limit");
      expect(err.retriable).toBe(true);
      expect(err.detail).toContain("HTTP 429");
    });

    it("HTTP 400 → 不可重试（请求本身有问题，重试无意义）", async () => {
      mockedAxios.post.mockRejectedValueOnce({
        message: "bad request",
        response: { status: 400, data: { error: "bad request" } },
      } as any);
      const gen = service.completeStream({
        scene: "chat_main",
        messages: [{ role: "user", content: "Hi" }],
      });
      const err = (await gen
        .next()
        .catch((e: unknown) => e)) as LlmUpstreamError;
      expect(err).toBeInstanceOf(LlmUpstreamError);
      expect(err.reason).toBe("upstream_error");
      expect(err.retriable).toBe(false);
      expect(err.detail).toContain("HTTP 400");
    });

    it("缺 API key → LlmUpstreamError 且不可重试", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PROMPT_REGISTRY_PROVIDER,
          LlmService,
          PROMPT_REGISTRY_PROVIDER,
          PRISMA_MOCK,
          {
            provide: ConfigService,
            useValue: { get: jest.fn().mockReturnValue("") },
          },
        ],
      }).compile();
      const noKeyService = module.get<LlmService>(LlmService);
      const gen = noKeyService.completeStream({
        scene: "chat_main",
        messages: [{ role: "user", content: "Hi" }],
      });
      const err = (await gen
        .next()
        .catch((e: unknown) => e)) as LlmUpstreamError;
      expect(err).toBeInstanceOf(LlmUpstreamError);
      expect(err.retriable).toBe(false);
    });

    it("mid-stream 断流（socket hang up）抛可重试的 LlmUpstreamError", async () => {
      // 实机事故（2026-11-10）：请求已发出、首 chunk 未到时连接被重置，
      // 容器日志只看到一坨 stream 对象 dump，无法定位原因
      const socketStream = new Readable({ read() {} });
      mockedAxios.post.mockResolvedValueOnce({ data: socketStream } as any);
      const gen = service.completeStream({
        scene: "chat_main",
        messages: [{ role: "user", content: "Hi" }],
      });
      const consumed = (async () => {
        const out: string[] = [];
        for await (const c of gen) out.push(c);
        return out;
      })();
      // 等生成器完成 axios 请求并挂上流监听后再注入连接重置
      setImmediate(() =>
        socketStream.emit(
          "error",
          Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        ),
      );
      const err = (await consumed.catch((e: unknown) => e)) as LlmUpstreamError;
      expect(err).toBeInstanceOf(LlmUpstreamError);
      expect(err.reason).toBe("upstream_error");
      expect(err.retriable).toBe(true);
      expect(err.detail).toContain("ECONNRESET");
    });

    it("失败时把紧凑细节写入 usage log 的 failureDetail", async () => {
      mockedAxios.post.mockRejectedValueOnce({
        message: "socket hang up",
        code: "ECONNRESET",
      } as any);
      const gen = service.completeStream({
        scene: "chat_main",
        messages: [{ role: "user", content: "Hi" }],
      });
      await expect(gen.next()).rejects.toBeInstanceOf(LlmUpstreamError);
      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            success: false,
            failureReason: "upstream_error",
            failureDetail: expect.stringContaining("ECONNRESET"),
          }),
        }),
      );
    });

    it("流正常结束但零内容 → empty_response 并带 failureDetail", async () => {
      const socketStream = Readable.from([
        'data: {"choices":[{"delta":{"content":""}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
      mockedAxios.post.mockResolvedValueOnce({ data: socketStream } as any);
      const gen = service.completeStream({
        scene: "chat_main",
        messages: [{ role: "user", content: "Hi" }],
      });
      const out: string[] = [];
      for await (const c of gen) out.push(c);
      expect(out).toEqual([]);
      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            success: false,
            failureReason: "empty_response",
            failureDetail: expect.stringContaining("0 content"),
          }),
        }),
      );
    });
  });

  describe("buildFillerPrompt", () => {
    it("构建中文首响承接 prompt：角色定位、语言跟随、不答实质问题", () => {
      const messages = service.buildFillerPrompt("我喜欢上海的天气");

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain("首响承接层");
      expect(messages[0].content).toContain("用孩子刚说的语言回复");
      expect(messages[0].content).toContain("绝不回答问题");
      expect(messages[1]).toEqual({
        role: "user",
        content: "我喜欢上海的天气",
      });
    });

    it("should not carry textbook context or history into the filler prompt", () => {
      const messages = service.buildFillerPrompt("Hello");

      expect(messages).toHaveLength(2);
      expect(messages[0].content).not.toContain("textbook context");
    });

    it("长度下限抬到中文 15-20 字 / 英文 8-12 词（音频覆盖主模型首包）", () => {
      const messages = service.buildFillerPrompt("Hello");

      // 防死空气：filler 音频是等待大模型首 chunk 的天然缓冲。
      // 实测 gap P90=2.36s，10 字 filler（约 1.5s）盖不住，抬到 15-20 字
      // （约 2.5-3.5s）才能完全覆盖
      expect(messages[0].content).toContain("15 到 20 个字");
      expect(messages[0].content).toContain("8 到 12 个词");
    });

    it("few-shot 中文示例均为 15-20 字且不带名字，英文示例 8-12 词", () => {
      const messages = service.buildFillerPrompt("我喜欢上海的天气");

      // 模型会模仿示例长度与结构：示例必须自身达标
      expect(messages[0].content).toContain("示例：");
      const zhExamples = [
        "原来你喜欢上海的天气呀，快多跟我说说呢……",
        "去公园玩啦，听起来就让人觉得好开心呀……",
      ];
      for (const example of zhExamples) {
        expect(messages[0].content).toContain(example);
        const cjkCount = [...example.replace(/[\s\p{P}\p{S}]/gu, "")].length;
        expect(cjkCount).toBeGreaterThanOrEqual(15);
        expect(cjkCount).toBeLessThanOrEqual(20);
        expect(example).not.toContain("贝果");
      }
      expect(messages[0].content).toContain(
        "Wow, that is such a fun question to think about!",
      );
    });

    it("硬禁：不以孩子名字开头、不出现自己名字、不新增意象", () => {
      const messages = service.buildFillerPrompt("我最喜欢蓝色");

      // 实机事故：每句 filler 都以「贝果，」开头，结构性复读
      expect(messages[0].content).toContain("不要以孩子的名字开头");
      // 实机事故：filler 自称「小象 Elly 听到……」，与主回答自我指称撞车
      expect(messages[0].content).toContain("不要出现你自己的名字");
      // 实机事故：filler 诗意延展（「像小星星在心里闪闪发亮」），
      // 主回答跟着复述意象——filler 越抒情，主模型越有东西可复读
      expect(messages[0].content).toContain(
        "禁止比喻、诗意延展或添加孩子没说的新意象",
      );
    });

    it("保留旧防线：延续语气收尾、不预告实质内容、不确认事实", () => {
      const messages = service.buildFillerPrompt("继续冒险故事");

      expect(messages[0].content).toContain("延续的语气收尾");
      expect(messages[0].content).toContain("很久很久以前");
      expect(messages[0].content).toContain("绝不确认或复述孩子说的事实");
      // 问 Elly 自己也只承接，不抢答
      expect(messages[0].content).toContain("包括关于你自己的问题");
    });

    it("最近用过的 filler 进入中文禁用清单", () => {
      const messages = service.buildFillerPrompt("我喜欢上海的天气", [
        "原来你喜欢上海的天气呀，快多跟我说说呢……",
        "Wow, tell me more about it right now!",
      ]);

      // 跨轮次多样性：最近用过的 filler 原文进入禁用清单
      expect(messages[0].content).toContain("不要复用或近似模仿");
      expect(messages[0].content).toContain(
        "「原来你喜欢上海的天气呀，快多跟我说说呢……」",
      );
      expect(messages[0].content).toContain(
        "「Wow, tell me more about it right now!」",
      );
      // 用户输入仍在 user 消息，不被历史污染
      expect(messages).toHaveLength(2);
      expect(messages[1].content).toBe("我喜欢上海的天气");
    });

    it("无最近 filler 时不加禁用清单段", () => {
      // 首轮对话 / 旧数据无 filler：prompt 保持原样（向后兼容）
      for (const recent of [undefined, [] as string[]]) {
        const messages = service.buildFillerPrompt("Hello", recent);
        expect(messages[0].content).not.toContain("不要复用或近似模仿");
      }
    });

    it("冒险门禁情境：中文中性承接指令，不得预告冒险", () => {
      const messages = service.buildFillerPrompt("继续冒险故事", [], {
        intent: "adventure_story",
        adventureDeclined: true,
      });

      expect(messages[0].content).toContain("今天的冒险已经结束");
      expect(messages[0].content).toContain("不要宣告、承诺或预告冒险");
    });

    it("故事意图情境：引导语示例 ≥15 字，不抢跑故事内容", () => {
      const messages = service.buildFillerPrompt("讲一个英语故事", [], {
        intent: "english_story",
      });

      expect(messages[0].content).toContain("主回答会讲一个故事");
      expect(messages[0].content).toContain("绝不自己开始或预告故事内容");
      const leadIn = "好呀，故事时间到啦，把耳朵竖起来咯……";
      expect(messages[0].content).toContain(leadIn);
      expect(
        [...leadIn.replace(/[\s\p{P}\p{S}]/gu, "")].length,
      ).toBeGreaterThanOrEqual(15);
    });

    it("纯自由对话不加情境段", () => {
      const messages = service.buildFillerPrompt("你好", [], {
        intent: "free_chat",
      });

      expect(messages[0].content).not.toContain("本轮背景");
    });

    it("人设护栏：身份声明 + 禁止编造名字", () => {
      const messages = service.buildFillerPrompt("你叫什么名字", [], {
        persona: "小象 Elly：听风原野的居民，性格温暖好奇。",
      });

      // 身份兜底：filler 不得编造名字（防与主回答人设矛盾）
      expect(messages[0].content).toContain("你的身份");
      expect(messages[0].content).toContain("小象 Elly");
      expect(messages[0].content).toContain("绝不给自己编造别的名字");
    });

    it("孩子档案：知道名字但本句不用名字称呼", () => {
      const withBrief = service.buildFillerPrompt("你好呀", [], {
        childBrief: "名叫 Amy，5 岁，女孩",
      });
      expect(withBrief[0].content).toContain("你正在和这个孩子说话");
      expect(withBrief[0].content).toContain("名叫 Amy，5 岁，女孩");
      // 实机事故：「may address them by name naturally」导致每句都喊名字
      expect(withBrief[0].content).toContain("不要用名字称呼");
      expect(withBrief[0].content).toContain("不要编造");

      const without = service.buildFillerPrompt("你好呀", [], {});
      expect(without[0].content).not.toContain("你正在和这个孩子说话");
    });
  });

  describe("buildChildBrief / ageFromBirthday", () => {
    it("组合称呼、年龄、性别；优先英文名", () => {
      expect(
        LlmService.buildChildBrief({
          name: "莉莉",
          englishName: "Lily",
          birthday: "2020-06-01",
          gender: "female",
        }),
      ).toBe(
        `名叫 Lily，${new Date().getUTCFullYear() - 2020 - (new Date().getUTCMonth() < 5 ? 1 : 0)} 岁，女孩`,
      );
      expect(LlmService.buildChildBrief({ name: "豆豆", gender: "male" })).toBe(
        "名叫 豆豆，男孩",
      );
      expect(LlmService.buildChildBrief({})).toBe("");
      expect(LlmService.buildChildBrief(undefined)).toBe("");
    });

    it("ageFromBirthday：非法格式与越界返回 null", () => {
      expect(LlmService.ageFromBirthday("2020-06-01")).not.toBeNull();
      expect(LlmService.ageFromBirthday("20200601")).toBeNull();
      expect(LlmService.ageFromBirthday("not-a-date")).toBeNull();
      expect(LlmService.ageFromBirthday(null)).toBeNull();
      expect(LlmService.ageFromBirthday("1990-01-01")).toBeNull(); // 超 18 岁
      expect(LlmService.ageFromBirthday("2999-01-01")).toBeNull(); // 未来
    });
  });

  describe("extractAnswer", () => {
    it("should return the answer from rawPayload boundary info", () => {
      const rawPayload = {
        filler: "原来你喜欢上海呀",
        answer: "I like Shanghai.",
      };

      expect(
        LlmService.extractAnswer(
          "原来你喜欢上海呀\nI like Shanghai.",
          rawPayload,
        ),
      ).toBe("I like Shanghai.");
    });

    it("should return null when rawPayload has no boundary info (legacy row)", () => {
      // 旧行无边界信息：返回 null，由调用方决定跳过（不进大模型历史）
      expect(LlmService.extractAnswer("I like Shanghai.", null)).toBeNull();
      expect(LlmService.extractAnswer("I like Shanghai.", {})).toBeNull();
      expect(
        LlmService.extractAnswer("I like Shanghai.", { filler: "嗯" }),
      ).toBeNull();
      expect(LlmService.extractAnswer("x", { answer: 123 })).toBeNull();
    });
  });

  describe("child safety rules (L3)", () => {
    it.each([undefined, "free_chat", "sleep_story", "english_chat"])(
      "buildEnglishTutorPrompt includes hard safety rules for mode=%s",
      (mode) => {
        const messages = service.buildEnglishTutorPrompt("你好", [], { mode });
        const system = messages[0].content;
        expect(system).toContain(
          "Never generate, describe, or expand sexual, violent, bloody, or self-harm content",
        );
        expect(system).toContain("do not repeat or echo their words");
        expect(system).toContain("empathy first");
      },
    );
  });

  describe("usage logging (模型监控埋点)", () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    it("complete 成功时写入成功日志（tier/model/token/延迟）", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: "你好呀" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      } as any);

      await service.complete({
        scene: "intent_classify",
        deviceId: "device-uuid-1",
        messages: [{ role: "user", content: "Hi" }],
      });
      await flush();

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          scene: "intent_classify",
          model: "deepseek-flash",
          tier: "main",
          success: true,
          failureReason: null,
          firstTokenMs: null,
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          deviceId: "device-uuid-1",
        }),
      });
      const latency =
        prismaMock.llmUsageLog.create.mock.calls[0][0].data.latencyMs;
      expect(typeof latency).toBe("number");
      expect(latency).toBeGreaterThanOrEqual(0);
    });

    it("complete 返回空文本时记 empty_response 失败", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { choices: [{ message: { content: "  " } }] },
      } as any);

      await service.complete({
        scene: "filler",
        messages: [{ role: "user", content: "Hi" }],
      });
      await flush();

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          success: false,
          failureReason: "empty_response",
          deviceId: null,
        }),
      });
    });

    it("complete 失败原因归一化：429→rate_limit，ECONNABORTED→timeout，其他→upstream_error", async () => {
      const cases = [
        [{ response: { status: 429, data: {} }, message: "429" }, "rate_limit"],
        [
          { code: "ECONNABORTED", message: "timeout of 30000ms exceeded" },
          "timeout",
        ],
        [{ message: "socket hang up" }, "upstream_error"],
      ] as const;
      for (const [error, expected] of cases) {
        mockedAxios.post.mockRejectedValueOnce(error as any);
        await expect(
          service.complete({
            scene: "safety_l2",
            messages: [{ role: "user", content: "Hi" }],
          }),
        ).rejects.toThrow("LLM request failed");
      }
      await flush();

      const reasons = prismaMock.llmUsageLog.create.mock.calls.map(
        (call) => call[0].data.failureReason,
      );
      expect(reasons).toEqual(["rate_limit", "timeout", "upstream_error"]);
    });

    it("completeStream 记录 TTFT，并捕获末 chunk 的 usage", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: Readable.from([
          'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
          "data: [DONE]\n\n",
        ]),
      } as any);

      const gen = service.completeStream({
        scene: "chat_main",
        deviceId: "device-uuid-2",
        messages: [{ role: "user", content: "Hi" }],
      });
      for await (const _ of gen) {
        // drain
      }
      await flush();

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          scene: "chat_main",
          success: true,
          failureReason: null,
          promptTokens: 3,
          totalTokens: 5,
          deviceId: "device-uuid-2",
        }),
      });
      const data = prismaMock.llmUsageLog.create.mock.calls[0][0].data;
      expect(data.firstTokenMs).not.toBeNull();
      expect(data.firstTokenMs).toBeLessThanOrEqual(data.latencyMs);
    });

    it("completeStream 零内容流记 empty_response", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: Readable.from(["data: [DONE]\n\n"]),
      } as any);

      const gen = service.completeStream({
        scene: "filler",
        messages: [{ role: "user", content: "Hi" }],
      });
      for await (const _ of gen) {
        // drain
      }
      await flush();

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          success: false,
          failureReason: "empty_response",
          firstTokenMs: null,
        }),
      });
    });

    it("completeStream 请求失败记日志后继续抛错", async () => {
      mockedAxios.post.mockRejectedValueOnce({
        code: "ECONNABORTED",
        message: "timeout of 30000ms exceeded",
      } as any);

      const gen = service.completeStream({
        scene: "chat_main",
        messages: [{ role: "user", content: "Hi" }],
      });
      await expect(gen.next()).rejects.toThrow(
        "LLM upstream timeout: ECONNABORTED",
      );
      await flush();

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          success: false,
          failureReason: "timeout",
          failureDetail: expect.stringContaining("ECONNABORTED"),
        }),
      });
    });

    it("埋点写库失败不影响主链路（fire-and-forget）", async () => {
      prismaMock.llmUsageLog.create.mockRejectedValueOnce(new Error("db down"));
      mockedAxios.post.mockResolvedValueOnce({
        data: { choices: [{ message: { content: "你好" } }] },
      } as any);

      const result = await service.complete({
        scene: "parent_report",
        messages: [{ role: "user", content: "Hi" }],
      });
      await flush();

      expect(result.text).toBe("你好");
    });

    it("缺少 API key 时也记失败日志", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PROMPT_REGISTRY_PROVIDER,
          LlmService,
          PROMPT_REGISTRY_PROVIDER,
          PRISMA_MOCK,
          {
            provide: ConfigService,
            useValue: { get: jest.fn().mockReturnValue("") },
          },
        ],
      }).compile();
      const noKeyService = module.get<LlmService>(LlmService);
      const noKeyPrisma = module.get(PrismaService);

      await expect(
        noKeyService.complete({
          scene: "chat_main",
          messages: [{ role: "user", content: "Hi" }],
        }),
      ).rejects.toThrow("LLM API key is not configured");
      await flush();

      expect(noKeyPrisma.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          success: false,
          failureReason: "upstream_error",
        }),
      });
    });

    it("小模型流式带 stream_options.include_usage，末 chunk usage 落库", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: Readable.from([
          'data: {"choices":[{"delta":{"content":"好呀"}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}\n\n',
          "data: [DONE]\n\n",
        ]),
      } as any);

      const gen = service.completeStream({
        scene: "filler",
        model: "qwen-flash",
        messages: [{ role: "user", content: "Hi" }],
      });
      for await (const _ of gen) {
        // drain
      }
      await flush();

      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          model: "qwen-flash",
          stream_options: { include_usage: true },
        }),
        expect.any(Object),
      );
      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          scene: "filler",
          tier: "small",
          promptTokens: 7,
          completionTokens: 2,
          totalTokens: 9,
        }),
      });
    });

    it("主模型流式不下发 stream_options（DeepSeek 网关原生返回 usage）", async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: Readable.from([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      } as any);

      const gen = service.completeStream({
        scene: "chat_main",
        messages: [{ role: "user", content: "Hi" }],
      });
      for await (const _ of gen) {
        // drain
      }

      const payload = mockedAxios.post.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      expect(payload).not.toHaveProperty("stream_options");
    });
  });

  describe("成本与缓存 token 落库", () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    /**
     * Step 0-A 实测样本（2026-11-12 真实调用 api.deepseek.com）：
     * prompt_cache_hit_tokens + prompt_cache_miss_tokens === prompt_tokens
     */
    const DEEPSEEK_USAGE = {
      prompt_tokens: 3607,
      completion_tokens: 2,
      total_tokens: 3609,
      prompt_tokens_details: { cached_tokens: 3456 },
      prompt_cache_hit_tokens: 3456,
      prompt_cache_miss_tokens: 151,
    };

    /** 末 chunk 携带 usage（DeepSeek 官方：统计信息附加在最后一个内容块上） */
    const sseWithUsage = (usage: unknown) =>
      Readable.from([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage,
        })}\n\n`,
        "data: [DONE]\n\n",
      ]);

    const drainStream = async (gen: AsyncGenerator<string>) => {
      const deltas: string[] = [];
      for await (const delta of gen) deltas.push(delta);
      return deltas;
    };

    beforeEach(() => {
      // 只冻结 Date（峰谷判定按请求发生时刻），不影响流与 flush 的调度原语
      jest.useFakeTimers({
        doNotFake: ["setImmediate", "nextTick", "queueMicrotask"],
      });
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it("流式成功：写入 cacheHitInputTokens 与按高峰定价快照的 costMicroCny", async () => {
      jest.setSystemTime(new Date("2026-11-12T01:30:00Z")); // 北京周四 09:30 → 高峰
      mockedAxios.post.mockResolvedValueOnce({
        data: sseWithUsage(DEEPSEEK_USAGE),
      } as never);

      await drainStream(
        service.completeStream({
          scene: "chat_main",
          messages: [{ role: "user", content: "Hi" }],
        }),
      );
      await flush();

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          cacheHitInputTokens: 3456,
          costMicroCny: 456, // 151×2 + 3456×0.04 + 2×8
        }),
      });
    });

    it("同一 usage 落在空闲时段则按半价计（228 micro）", async () => {
      jest.setSystemTime(new Date("2026-11-12T04:30:00Z")); // 北京周四 12:30 → 空闲
      mockedAxios.post.mockResolvedValueOnce({
        data: sseWithUsage(DEEPSEEK_USAGE),
      } as never);

      await drainStream(
        service.completeStream({
          scene: "chat_main",
          messages: [{ role: "user", content: "Hi" }],
        }),
      );
      await flush();

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ costMicroCny: 228 }),
      });
    });

    it("上游未回传缓存字段：cacheHitInputTokens=null，金额退化为未命中价上界", async () => {
      jest.setSystemTime(new Date("2026-11-12T04:30:00Z"));
      mockedAxios.post.mockResolvedValueOnce({
        data: sseWithUsage({ prompt_tokens: 3607, completion_tokens: 2 }),
      } as never);

      await drainStream(
        service.completeStream({
          scene: "chat_main",
          messages: [{ role: "user", content: "Hi" }],
        }),
      );
      await flush();

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          cacheHitInputTokens: null,
          costMicroCny: 3615, // 3607×1 + 2×4
        }),
      });
    });

    it("usage 无 token：两列都是 null，绝不写 0", async () => {
      jest.setSystemTime(new Date("2026-11-12T04:30:00Z"));
      mockedAxios.post.mockResolvedValueOnce({
        data: sseWithUsage({}),
      } as never);

      await drainStream(
        service.completeStream({
          scene: "chat_main",
          messages: [{ role: "user", content: "Hi" }],
        }),
      );
      await flush();

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          cacheHitInputTokens: null,
          costMicroCny: null,
        }),
      });
    });

    it("DashScope 形状 prompt_tokens_details.cached_tokens 也解析并按 qwen 阶梯价计", async () => {
      jest.setSystemTime(new Date("2026-11-12T04:30:00Z"));
      mockedAxios.post.mockResolvedValueOnce({
        data: sseWithUsage({
          prompt_tokens: 1000,
          completion_tokens: 100,
          total_tokens: 1100,
          prompt_tokens_details: { cached_tokens: 512 },
        }),
      } as never);

      await drainStream(
        service.completeStream({
          scene: "filler",
          model: "qwen-flash",
          messages: [{ role: "user", content: "Hi" }],
        }),
      );
      await flush();

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tier: "small",
          cacheHitInputTokens: 512,
          costMicroCny: 239, // 488×0.15 + 512×0.03 + 100×1.5
        }),
      });
    });

    it("未定价模型：token 与缓存数照记，costMicroCny=null（接口据此报未计价条数）", async () => {
      jest.setSystemTime(new Date("2026-11-12T04:30:00Z"));
      mockedAxios.post.mockResolvedValueOnce({
        data: sseWithUsage(DEEPSEEK_USAGE),
      } as never);

      await drainStream(
        service.completeStream({
          scene: "chat_main",
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hi" }],
        }),
      );
      await flush();

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          cacheHitInputTokens: 3456,
          costMicroCny: null,
        }),
      });
    });

    it("计价抛异常时兜底 null：对话内容照常返回，日志照常写库", async () => {
      jest.setSystemTime(new Date("2026-11-12T04:30:00Z"));
      jest.spyOn(llmCostUtil, "costMicroCnyOf").mockImplementation(() => {
        throw new Error("pricing table broken");
      });
      mockedAxios.post.mockResolvedValueOnce({
        data: sseWithUsage(DEEPSEEK_USAGE),
      } as never);

      const deltas = await drainStream(
        service.completeStream({
          scene: "chat_main",
          messages: [{ role: "user", content: "Hi" }],
        }),
      );
      await flush();

      expect(deltas).toEqual(["你"]);
      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          success: true,
          cacheHitInputTokens: 3456,
          costMicroCny: null,
        }),
      });
    });

    it("非流式 complete 同样写入两列", async () => {
      jest.setSystemTime(new Date("2026-11-12T04:30:00Z"));
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: "ok" } }],
          usage: DEEPSEEK_USAGE,
        },
      } as never);

      await service.complete({
        scene: "intent_classify",
        messages: [{ role: "user", content: "Hi" }],
      });
      await flush();

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          cacheHitInputTokens: 3456,
          costMicroCny: 228,
        }),
      });
    });
  });
});
