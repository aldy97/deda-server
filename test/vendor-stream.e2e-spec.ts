import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { createServer, Server as HttpServer } from "http";
import { AddressInfo } from "net";
import { Server as SocketIOServer } from "socket.io";
import { io, Socket as ClientSocket } from "socket.io-client";
import { AppModule } from "./../src/app.module";
import { PrismaService } from "./../src/common/prisma/prisma.service";
import { RagService } from "./../src/modules/rag/rag.service";
import { LlmService } from "./../src/modules/llm/llm.service";

/**
 * 流式全链路 e2e（TDD：模拟机芯厂云，不依赖真实外部服务）
 * 回路：假机芯厂云通过入站 WS 推 ASR 文字（vendor:text:in）
 *   → 我方并行调用小模型（filler 首响）与大模型（answer）
 *   → 我方作为 WS 客户端按 chunk 顺序调用假机芯厂云的上传接口
 *     （vendor:text:chunk × N，最后 vendor:text:out 全量兜底）
 * 断言核心：机芯厂云收到的 chunk 顺序严格对齐（seq 递增、filler 先于 answer）。
 * TODO(可用性): 本套件默认两个 LLM API 均可用且速度正常；LLM 超时/限流/流中断、
 * 上传断连重连、多设备并发串流隔离等用例待补。
 */
describe("Vendor streaming pipeline (e2e)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let asrClient: ClientSocket;

  // 假机芯厂云：接收我方出站上传
  let vendorHttpServer: HttpServer;
  let vendorCloud: SocketIOServer;
  const uploadedEvents: Array<{ event: string; data: any }> = [];

  // 记录双模型调用顺序，验证并发编排
  const llmCalls: Array<{ kind: "filler" | "answer"; model?: string }> = [];

  const mockPrismaService = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    device: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockResolvedValue({ id: "e2e-device-uuid", deviceId: "e2e-dev-001" }),
    },
    deviceConfig: { findFirst: jest.fn().mockResolvedValue(null) },
    childProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    message: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: "e2e-msg-001" }),
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

  // 小模型故意慢于大模型：大模型先完成也只能进缓冲，不得抢跑
  async function* fillerStream(): AsyncGenerator<string> {
    await sleep(20);
    yield "原来";
    yield "你喜欢上海呀";
  }

  async function* answerStream(): AsyncGenerator<string> {
    yield "I ";
    yield "like ";
    yield "Shanghai.";
  }

  const mockLlmService = {
    get smallModelName() {
      return "small-llm";
    },
    buildFillerPrompt: jest.fn().mockReturnValue([
      { role: "system", content: "filler prompt" },
      { role: "user", content: "我喜欢上海的天气" },
    ]),
    buildEnglishTutorPrompt: jest.fn().mockReturnValue([
      { role: "system", content: "prompt" },
      { role: "user", content: "我喜欢上海的天气" },
    ]),
    complete: jest.fn(),
    completeStream: jest.fn(),
  };

  const waitFor = async (
    predicate: () => boolean,
    timeoutMs = 5000,
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
    // 1) 起假机芯厂云 WS 服务端（loopback，非真实网络）
    vendorHttpServer = createServer();
    vendorCloud = new SocketIOServer(vendorHttpServer, {
      cors: { origin: "*" },
    });
    vendorCloud.on("connection", (socket) => {
      socket.on("vendor:text:chunk", (data, ack) => {
        uploadedEvents.push({ event: "vendor:text:chunk", data });
        if (typeof ack === "function") {
          ack(); // 模拟机芯厂 ack，我方据此保序发送下一个 chunk
        }
      });
      socket.on("vendor:text:out", (data, ack) => {
        uploadedEvents.push({ event: "vendor:text:out", data });
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
      .overrideProvider(LlmService)
      .useValue(mockLlmService)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address();
    const port = typeof address === "string" ? 0 : address.port;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    if (asrClient?.connected) {
      asrClient.disconnect();
    }
    await app.close();
    await new Promise<void>((resolve) => vendorCloud.close(() => resolve()));
    delete process.env.VENDOR_WS_UPLOAD_URL;
  });

  beforeEach(() => {
    uploadedEvents.length = 0;
    llmCalls.length = 0;
    mockLlmService.completeStream.mockImplementation((options: any) => {
      if (options.model === "small-llm") {
        llmCalls.push({ kind: "filler", model: options.model });
        return fillerStream();
      }
      llmCalls.push({ kind: "answer", model: options.model });
      return answerStream();
    });
  });

  afterEach(() => {
    if (asrClient?.connected) {
      asrClient.disconnect();
    }
  });

  it("should upload filler-then-answer chunks in order to the vendor cloud", async () => {
    asrClient = await connectAsrClient();

    // 入站兼容应答（旧固件仍收 vendor:text:out）
    const inboundReplyPromise = new Promise<{ responseText: string }>(
      (resolve, reject) => {
        asrClient.once("vendor:text:out", (data) => resolve(data));
        setTimeout(() => reject(new Error("inbound text out timeout")), 5000);
      },
    );

    // 假机芯厂云通过入站 WS 推用户 ASR 文字
    asrClient.emit("vendor:text:in", {
      deviceId: "e2e-dev-001",
      asrText: "我喜欢上海的天气",
    });

    // 等待全量兜底上传到机芯厂云（chunk 流结束的标志）
    await waitFor(() =>
      uploadedEvents.some((e) => e.event === "vendor:text:out"),
    );
    const inboundReply = await inboundReplyPromise;

    const chunks = uploadedEvents
      .filter((e) => e.event === "vendor:text:chunk")
      .map((e) => e.data);

    // 核心断言：机芯厂云收到的 chunk 顺序严格对齐
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // filler（小模型首响）全部先于 answer（大模型正式回答）
    expect(chunks[0]).toMatchObject({
      deviceId: "e2e-dev-001",
      source: "filler",
      delta: "原来",
      isFinal: false,
    });
    expect(chunks[1]).toMatchObject({
      source: "filler",
      delta: "你喜欢上海呀",
    });
    expect(chunks[2]).toMatchObject({
      source: "filler",
      delta: "",
      isFinal: true,
    });
    expect(chunks[3]).toMatchObject({ source: "answer", delta: "I " });
    expect(chunks[4]).toMatchObject({ source: "answer", delta: "like " });
    expect(chunks[5]).toMatchObject({
      source: "answer",
      delta: "Shanghai.",
    });
    expect(chunks[6]).toMatchObject({
      source: "answer",
      delta: "",
      isFinal: true,
    });
    // 一轮内所有 chunk 共享同一 turnId
    expect(new Set(chunks.map((c) => c.turnId)).size).toBe(1);

    // 全量兜底在最后一个 chunk 之后到达机芯厂云；内容为播报全文（filler + answer）
    const lastEvent = uploadedEvents[uploadedEvents.length - 1];
    expect(lastEvent.event).toBe("vendor:text:out");
    expect(lastEvent.data.responseText).toBe(
      "原来你喜欢上海呀\nI like Shanghai.",
    );

    // 双模型异步并发调用：大模型泵先启动（不等待小模型），filler 走小模型
    expect(mockLlmService.completeStream).toHaveBeenCalledTimes(2);
    expect(llmCalls.map((c) => c.kind)).toEqual(["answer", "filler"]);
    expect(mockLlmService.completeStream).toHaveBeenCalledWith(
      expect.objectContaining({ model: "small-llm" }),
    );

    // 落库为用户实际播报全文：小模型 filler + 大模型答案
    const assistantCall = mockPrismaService.message.create.mock.calls.find(
      (call) => call[0].data.role === "assistant",
    );
    expect(assistantCall[0].data.content).toBe(
      "原来你喜欢上海呀\nI like Shanghai.",
    );

    // 入站兼容应答为播报全文
    expect(inboundReply.responseText).toBe(
      "原来你喜欢上海呀\nI like Shanghai.",
    );
  });

  it("should still upload an ordered answer when the small model fails", async () => {
    mockLlmService.completeStream.mockImplementation((options: any) => {
      if (options.model === "small-llm") {
        llmCalls.push({ kind: "filler", model: options.model });
        return (async function* (): AsyncGenerator<string> {
          throw new Error("small model unavailable");
        })();
      }
      llmCalls.push({ kind: "answer", model: options.model });
      return answerStream();
    });

    asrClient = await connectAsrClient();
    asrClient.emit("vendor:text:in", {
      deviceId: "e2e-dev-001",
      asrText: "hi",
    });

    await waitFor(() =>
      uploadedEvents.some((e) => e.event === "vendor:text:out"),
    );

    const chunks = uploadedEvents
      .filter((e) => e.event === "vendor:text:chunk")
      .map((e) => e.data);
    // 小模型失败：无 filler，answer 从 seq=0 开始且顺序完整
    expect(chunks.every((c) => c.source === "answer")).toBe(true);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3]);
    expect(chunks[3]).toMatchObject({ isFinal: true });
  });
});
