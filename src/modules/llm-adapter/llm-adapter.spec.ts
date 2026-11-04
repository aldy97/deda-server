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
import { OpenAiExceptionFilter } from "./filters/openai-exception.filter";

const VALID_TOKEN = "test-adapter-key";

describe("LlmAdapterModule", () => {
  let service: LlmAdapterService;
  let controller: LlmAdapterController;
  let llm: {
    buildEnglishTutorPrompt: jest.Mock;
    completeStream: jest.Mock;
  };
  let childSafety: {
    checkL1: jest.Mock;
    cannedReply: jest.Mock;
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
      completeStream: jest.fn(),
    };
    childSafety = {
      checkL1: jest.fn().mockReturnValue({
        blocked: false,
        category: null,
        layer: null,
      }),
      cannedReply: jest.fn().mockReturnValue("这个话题不适合小朋友聊哦。"),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [LlmAdapterController],
      providers: [
        LlmAdapterService,
        { provide: LlmService, useValue: llm },
        { provide: ChildSafetyService, useValue: childSafety },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === "LLM_ADAPTER_API_KEY" ? VALID_TOKEN : undefined,
          },
        },
      ],
    }).compile();

    service = module.get(LlmAdapterService);
    controller = module.get(LlmAdapterController);
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

  describe("service without configured api key", () => {
    it("rejects every token when LLM_ADAPTER_API_KEY is unset", async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          LlmAdapterService,
          { provide: LlmService, useValue: llm },
          { provide: ChildSafetyService, useValue: childSafety },
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
