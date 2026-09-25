import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { LlmService } from "./llm.service";
import axios from "axios";

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
                OPENAI_MODEL: "deepseek-chat",
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
          model: "deepseek-chat",
          messages: [
            { role: "system", content: "You are a tutor." },
            { role: "user", content: "How are you?" },
          ],
          temperature: 0.7,
          max_tokens: 512,
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
  });
});
