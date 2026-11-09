import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { LlmService } from "./llm.service";
import { PrismaService } from "@/common/prisma/prisma.service";
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
        LlmService,
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

    it("should throw error when API key is missing", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          LlmService,
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
      expect(messages[0].content).toContain("Character persona");
      expect(messages[0].content).toContain("小象 Elly");
    });

    it("should fall back to elly persona for unknown characterKey and omit persona when absent", () => {
      const unknown = service.buildEnglishTutorPrompt("Hello", undefined, {
        characterKey: "nonexistent",
      });
      expect(unknown[0].content).toContain("小象 Elly");

      const without = service.buildEnglishTutorPrompt("Hello");
      expect(without[0].content).not.toContain("Character persona");
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
      expect(messages[0].content).toContain("English Name: Ali");
      expect(messages[0].content).toContain(
        "address the child using their name",
      );
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
      expect(system).toContain("English Name: Bobby");
      expect(system).toContain("Birthday: not provided");
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

    it("should tell the model to skip repeated acknowledgments after the filler", () => {
      const messages = service.buildEnglishTutorPrompt("我喜欢上海的天气");

      // 衔接丝滑：filler 寒暄已先行播报，正式回答直接进入正题、不得重复承接
      expect(messages[0].content).toContain(
        "just heard a short warm acknowledgment",
      );
      expect(messages[0].content).toContain("go straight into your reply");
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
          LlmService,
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
          LlmService,
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
          LlmService,
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
          LlmService,
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
        response: { data: { error: "rate limited" } },
      } as any);

      const gen = service.completeStream({
        scene: "chat_main",
        messages: [{ role: "user", content: "Hi" }],
      });

      await expect(gen.next()).rejects.toThrow("LLM request failed");
    });
  });

  describe("buildFillerPrompt", () => {
    it("should build a first-response prompt echoing the user input", () => {
      const messages = service.buildFillerPrompt("我喜欢上海的天气");

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain("first-response");
      expect(messages[0].content).toContain("same language");
      expect(messages[0].content).toContain("Never answer");
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

    it("should include few-shot examples and a variety constraint", () => {
      const messages = service.buildFillerPrompt("我喜欢上海的天气");

      // 业内 filler prompt 标配：few-shot 示例 + 措辞多样性约束
      expect(messages[0].content).toContain("Examples:");
      expect(messages[0].content).toContain("原来你喜欢上海的天气呀");
      expect(messages[0].content).toContain("That is such a fun question!");
      expect(messages[0].content).toContain("vary");
    });

    it("should require a trailing transitional tone for a smooth handover", () => {
      const messages = service.buildFillerPrompt("Hello");

      // 衔接丝滑：filler 以承接语气收尾，让大模型回答自然接棒
      expect(messages[0].content).toContain("transitional tone");
    });

    it("should enforce a minimum length so the filler audio covers the answer TTFT", () => {
      const messages = service.buildFillerPrompt("Hello");

      // 防死空气：filler 音频是等待大模型首 chunk 的天然缓冲，
      // 过短的 filler（如「嗯嗯」）音频不足 1 秒，缓冲失效——故约束下限
      expect(messages[0].content).toContain("at least 10 characters");
      expect(messages[0].content).toContain("at least 6 words");
    });

    it("should list recent fillers as banned openers when provided", () => {
      const messages = service.buildFillerPrompt("我喜欢上海的天气", [
        "原来你喜欢上海的天气呀",
        "Wow, that sounds fun!",
      ]);

      // 跨轮次多样性：最近用过的 filler 原文进入禁用清单
      expect(messages[0].content).toContain("do NOT reuse");
      expect(messages[0].content).toContain("原来你喜欢上海的天气呀");
      expect(messages[0].content).toContain("Wow, that sounds fun!");
      // 用户输入仍在 user 消息，不被历史污染
      expect(messages).toHaveLength(2);
      expect(messages[1].content).toBe("我喜欢上海的天气");
    });

    it("should not add a banned-openers section when recent fillers are absent", () => {
      // 首轮对话 / 旧数据无 filler：prompt 保持原样（向后兼容）
      for (const recent of [undefined, [] as string[]]) {
        const messages = service.buildFillerPrompt("Hello", recent);
        expect(messages[0].content).not.toContain("do NOT reuse");
      }
    });

    it("should forbid announcing or starting actual content", () => {
      const messages = service.buildFillerPrompt("继续冒险故事");

      // 衔接防矛盾：filler 绝不预告/抢跑实质内容（故事开头、模式启动等）
      expect(messages[0].content).toContain(
        "Never announce, preview, promise, or start any actual content",
      );
      expect(messages[0].content).toContain("once upon a time");
    });

    it("should include a decline context when today's adventure is already done", () => {
      const messages = service.buildFillerPrompt("继续冒险故事", [], {
        intent: "adventure_story",
        adventureDeclined: true,
      });

      // 门禁拒绝情境：filler 只能中性拖延，不得预告冒险
      expect(messages[0].content).toContain("ALREADY FINISHED");
      expect(messages[0].content).toContain("Do NOT announce");
    });

    it("should include a story context for story intents without decline", () => {
      const messages = service.buildFillerPrompt("讲一个英语故事", [], {
        intent: "english_story",
      });

      expect(messages[0].content).toContain("the main reply WILL tell a story");
      expect(messages[0].content).toContain("never start or preview the story");
    });

    it("should add no context section for plain free chat", () => {
      const messages = service.buildFillerPrompt("你好", [], {
        intent: "free_chat",
      });

      expect(messages[0].content).not.toContain("Context for this turn");
    });

    it("should include identity guardrail when persona is provided", () => {
      const messages = service.buildFillerPrompt("你叫什么名字", [], {
        persona: "小象 Elly：听风原野的居民，性格温暖好奇。",
      });

      // 身份兜底：filler 不得编造名字（防与主回答人设矛盾）
      expect(messages[0].content).toContain("Your identity");
      expect(messages[0].content).toContain("小象 Elly");
      expect(messages[0].content).toContain("Never invent a different name");
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
      await expect(gen.next()).rejects.toThrow("LLM request failed");
      await flush();

      expect(prismaMock.llmUsageLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          success: false,
          failureReason: "timeout",
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
          LlmService,
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
});
