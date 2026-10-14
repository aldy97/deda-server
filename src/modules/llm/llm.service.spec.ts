import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { LlmService } from "./llm.service";
import axios from "axios";
import { Readable } from "stream";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("LlmService", () => {
  let service: LlmService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const map: Record<string, string> = {
                OPENAI_BASE_URL: "https://api.deepseek.com/v1",
                OPENAI_API_KEY: "sk-test",
                OPENAI_MODEL: "deepseek-flash",
                LLM_TIMEOUT_MS: "30000",
              };
              return map[key];
            }),
          },
        },
      ],
    }).compile();

    service = module.get<LlmService>(LlmService);
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
          messages: [{ role: "user", content: "Hi" }],
        }),
      ).rejects.toThrow("LLM request failed");
    });
  });

  describe("buildEnglishTutorPrompt", () => {
    it("should include context and user message", () => {
      const messages = service.buildEnglishTutorPrompt(
        "How are you?",
        "Unit 1: Greetings",
        "Greetings",
      );

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain("Unit 1: Greetings");
      expect(messages[0].content).toContain(
        "friendly English-speaking AI companion",
      );
      expect(messages[0].content).toContain("seems off-topic");
      expect(messages[0].content).toContain("football player when you grow up");
      expect(messages[1].role).toBe("user");
      expect(messages[1].content).toBe("How are you?");
    });

    it("should include conversation history", () => {
      const messages = service.buildEnglishTutorPrompt(
        "I'm fine.",
        "Unit 1: Greetings",
        "Greetings",
        [
          { role: "user", content: "How are you?" },
          { role: "assistant", content: "I am fine, thank you." },
        ],
      );

      expect(messages).toHaveLength(4);
      expect(messages[0].role).toBe("system");
      expect(messages[1]).toEqual({ role: "user", content: "How are you?" });
      expect(messages[2]).toEqual({
        role: "assistant",
        content: "I am fine, thank you.",
      });
      expect(messages[3]).toEqual({ role: "user", content: "I'm fine." });
    });

    it("should handle missing context", () => {
      const messages = service.buildEnglishTutorPrompt("Hello", "");

      expect(messages[0].content).toContain(
        "No specific textbook context is selected",
      );
    });

    it("should include child profile in system prompt", () => {
      const messages = service.buildEnglishTutorPrompt(
        "Hello",
        "",
        undefined,
        undefined,
        {
          childProfile: {
            name: "Alice",
            birthday: "2018-05-20",
            englishName: "Ali",
          },
        },
      );

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
      const messages = service.buildEnglishTutorPrompt(
        "Hello",
        "",
        undefined,
        undefined,
        { promptTemplate: template },
      );

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
        "Unit 1: Morning routines",
        "Morning routines",
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
      expect(system).toContain("Current textbook context (Morning routines)");
    });

    it("should keep default behavior when options are omitted", () => {
      const messagesWithOptions = service.buildEnglishTutorPrompt(
        "Hello",
        "Unit 1: Greetings",
        "Greetings",
        undefined,
        {},
      );
      const messagesWithoutOptions = service.buildEnglishTutorPrompt(
        "Hello",
        "Unit 1: Greetings",
        "Greetings",
      );

      expect(messagesWithOptions[0].content).toBe(
        messagesWithoutOptions[0].content,
      );
    });

    it("should tell the model to skip repeated acknowledgments after the filler", () => {
      const messages = service.buildEnglishTutorPrompt("我喜欢上海的天气", "");

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

    it("should fall back to primary credentials when small-model env is not set", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          LlmService,
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
          messages: [{ role: "user", content: "Hi" }],
        }),
      );

      expect(deltas).toEqual(["ok"]);
    });

    it("should throw when API key is missing", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          LlmService,
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
  });
});
