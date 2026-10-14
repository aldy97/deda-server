import "dotenv/config";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { createServer, Server as HttpServer } from "http";
import { AddressInfo } from "net";
import { Server as SocketIOServer } from "socket.io";
import { io, Socket as ClientSocket } from "socket.io-client";
import { AppModule } from "./../src/app.module";
import { PrismaService } from "./../src/common/prisma/prisma.service";
import { RagService } from "./../src/modules/rag/rag.service";

/**
 * 真实联调 live spec（不进 CI / 默认套件：文件名不以 .e2e-spec.ts 结尾）
 *
 * 与 vendor-stream.e2e-spec.ts 的唯一区别：LlmService 不做 mock，
 * 真实调用小模型（SMALL_LLM_*，百炼 qwen-flash）与大模型（OPENAI_*，deepseek）。
 * 机芯厂云仍为本地假 WS 服务端；Prisma / RAG 仍 mock。
 *
 * 手动运行：
 *   npx jest --config ./test/jest-e2e.json --testRegex "live-spec\.ts$" --forceExit --testTimeout=30000
 *
 * 首音延迟预算（用户目标：说完话 2 秒内听到首音）：
 *   ASR 尾延(机芯厂侧) ~300ms + 上行网络 ~50ms
 *   + 我方 DB/RAG ~50ms + 小模型 TTFT ~500ms + 首 chunk 上传 ack ~50ms
 *   + 机芯厂 TTS/下发/起播 ~500ms + 余量 ~550ms = 2000ms
 *   => 我方可控段「收到文字 -> 小模型首 chunk 到达机芯厂云」阈值定为 800ms。
 */
const FIRST_CHUNK_BUDGET_MS = 800;

describe("Vendor streaming pipeline (live LLM)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let asrClient: ClientSocket;

  // 假机芯厂云：接收我方出站上传，并记录到达时间
  let vendorHttpServer: HttpServer;
  let vendorCloud: SocketIOServer;
  const uploadedEvents: Array<{ event: string; data: any; at: number }> = [];

  const hasLlmKeys =
    !!process.env.SMALL_LLM_API_KEY && !!process.env.OPENAI_API_KEY;

  const mockPrismaService = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    device: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: "live-device-uuid",
        deviceId: "live-dev-001",
      }),
    },
    deviceConfig: { findFirst: jest.fn().mockResolvedValue(null) },
    childProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    message: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: "live-msg-001" }),
    },
    conversationModeCategory: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    conversationMode: {
      upsert: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    textbook: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({
        id: "book-uuid",
        textbookId: "sample-textbook",
        promptTemplate: null,
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    unit: {
      upsert: jest.fn().mockResolvedValue({}),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: "unit-uuid", unitId: "unit-1" }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  const mockRagService = {
    retrieve: jest.fn().mockResolvedValue({
      textbookId: "sample-textbook",
      unitId: "unit-1",
      unitName: "Greetings",
      content: "Hello! How are you?",
      found: true,
    }),
    truncateContent: jest.fn((content: string) => content),
  };

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 25000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error("waitFor timeout");
      }
      await sleep(20);
    }
  };

  const connectAsrClient = (): Promise<ClientSocket> => {
    return new Promise((resolve, reject) => {
      const socket = io(`${baseUrl}/vendor`, {
        transports: ["websocket"],
        forceNew: true,
      });
      const timer = setTimeout(
        () => reject(new Error("socket connect timeout")),
        5000,
      );
      socket.on("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.on("connect_error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  };

  beforeAll(async () => {
    if (!hasLlmKeys) {
      return;
    }

    // 1) 起假机芯厂云 WS 服务端
    vendorHttpServer = createServer();
    vendorCloud = new SocketIOServer(vendorHttpServer, {
      cors: { origin: "*" },
    });
    vendorCloud.on("connection", (socket) => {
      socket.on("vendor:text:chunk", (data, ack) => {
        uploadedEvents.push({
          event: "vendor:text:chunk",
          data,
          at: Date.now(),
        });
        if (typeof ack === "function") {
          ack();
        }
      });
      socket.on("vendor:text:out", (data, ack) => {
        uploadedEvents.push({ event: "vendor:text:out", data, at: Date.now() });
        if (typeof ack === "function") {
          ack();
        }
      });
    });
    await new Promise<void>((resolve) =>
      vendorHttpServer.listen(0, () => resolve()),
    );
    const vendorPort = (vendorHttpServer.address() as AddressInfo).port;

    // 2) 指向假机芯厂云，再启动我方应用（uploader 在 init 时读取该 env）
    process.env.VENDOR_WS_UPLOAD_URL = `http://localhost:${vendorPort}`;
    delete process.env.LLM_STREAM_ENABLED;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .overrideProvider(RagService)
      .useValue(mockRagService)
      // 注意：LlmService 不 override，真实调用小模型与大模型
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address();
    const port = typeof address === "string" ? 0 : address.port;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    if (!hasLlmKeys) {
      return;
    }
    if (asrClient?.connected) {
      asrClient.disconnect();
    }
    await app.close();
    await new Promise<void>((resolve) => vendorCloud.close(() => resolve()));
    delete process.env.VENDOR_WS_UPLOAD_URL;
  });

  beforeEach(() => {
    uploadedEvents.length = 0;
    mockPrismaService.message.create.mockClear();
  });

  afterEach(() => {
    if (asrClient?.connected) {
      asrClient.disconnect();
    }
  });

  it("should hit first chunk under budget and keep filler-before-answer order with real LLMs", async () => {
    if (!hasLlmKeys) {
      console.warn(
        "SKIP: SMALL_LLM_API_KEY / OPENAI_API_KEY 未配置，跳过真实联调测试",
      );
      return;
    }

    asrClient = await connectAsrClient();

    // t0：机芯厂云推 ASR 文字的时刻（模拟用户说完话、我方收到文字）
    const t0 = Date.now();
    asrClient.emit("vendor:text:in", {
      deviceId: "live-dev-001",
      asrText: "我喜欢上海的天气",
    });

    // 等待全量兜底上传（一轮播报结束的标志）
    await waitFor(() =>
      uploadedEvents.some((e) => e.event === "vendor:text:out"),
    );

    const chunks = uploadedEvents.filter(
      (e) => e.event === "vendor:text:chunk",
    );
    const firstChunk = chunks[0];
    const fillerChunks = chunks.filter((e) => e.data.source === "filler");
    const answerChunks = chunks.filter((e) => e.data.source === "answer");

    // ---- 延迟打表（供汇报实测数据）----
    const firstChunkLatency = firstChunk.at - t0;
    const fillerDoneLatency =
      fillerChunks.length > 0
        ? fillerChunks[fillerChunks.length - 1].at - t0
        : -1;
    const firstAnswerLatency =
      answerChunks.length > 0 ? answerChunks[0].at - t0 : -1;
    const totalLatency = uploadedEvents[uploadedEvents.length - 1].at - t0;
    console.log(
      `[live] 首 chunk(小模型)=${firstChunkLatency}ms, ` +
        `filler 完毕=${fillerDoneLatency}ms, ` +
        `首个 answer chunk=${firstAnswerLatency}ms, ` +
        `整轮=${totalLatency}ms, ` +
        `chunks=${chunks.length}`,
    );
    console.log(
      `[live] filler="${fillerChunks.map((c) => c.data.delta).join("")}"`,
    );
    console.log(
      `[live] answer="${answerChunks.map((c) => c.data.delta).join("")}"`,
    );

    // ---- 核心断言 1：首音预算 ----
    expect(firstChunkLatency).toBeLessThan(FIRST_CHUNK_BUDGET_MS);
    expect(firstChunk.data.source).toBe("filler");

    // ---- 核心断言 2：chunk 顺序严格对齐 ----
    expect(chunks.map((c) => c.data.seq)).toEqual(chunks.map((_, i) => i));
    // filler 全部先于 answer
    const lastFillerIdx = chunks
      .map((c, i) => (c.data.source === "filler" ? i : -1))
      .filter((i) => i >= 0)
      .pop();
    const firstAnswerIdx = chunks.findIndex((c) => c.data.source === "answer");
    if (firstAnswerIdx >= 0 && lastFillerIdx !== undefined) {
      expect(lastFillerIdx).toBeLessThan(firstAnswerIdx);
    }
    // 一轮内共享同一 turnId
    expect(new Set(chunks.map((c) => c.data.turnId)).size).toBe(1);

    // ---- 核心断言 3：落库与全量兜底均为 filler + answer 播报全文 ----
    const fillerText = fillerChunks.map((c) => c.data.delta).join("");
    const answerText = answerChunks.map((c) => c.data.delta).join("");
    expect(fillerText.length).toBeGreaterThan(0);
    expect(answerText.length).toBeGreaterThan(0);

    const outEvent = uploadedEvents[uploadedEvents.length - 1];
    expect(outEvent.event).toBe("vendor:text:out");
    expect(outEvent.data.responseText).toBe(`${fillerText}\n${answerText}`);

    const assistantCall = mockPrismaService.message.create.mock.calls.find(
      (call) => call[0].data.role === "assistant",
    );
    expect(assistantCall).toBeDefined();
    expect(assistantCall[0].data.content).toBe(`${fillerText}\n${answerText}`);
    // 边界标注（方案 3）：rawPayload 结构化存 filler/answer
    expect(assistantCall[0].data.rawPayload).toEqual({
      filler: fillerText,
      answer: answerText,
    });
  }, 30000);
});
