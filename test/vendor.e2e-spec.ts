import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { io, Socket as ClientSocket } from "socket.io-client";
import { AppModule } from "./../src/app.module";
import { PrismaService } from "./../src/common/prisma/prisma.service";
import { RagService } from "./../src/modules/rag/rag.service";
import { LlmService } from "./../src/modules/llm/llm.service";
import { ChildMemoriesService } from "./../src/modules/child-memories/child-memories.service";

describe("Vendor WebSocket (e2e)", () => {
  let app: INestApplication;
  let client: ClientSocket;
  let baseUrl: string;

  const mockPrismaService = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    device: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockResolvedValue({ id: "e2e-device-uuid", deviceId: "e2e-dev-001" }),
    },
    deviceConfig: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    childProfile: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
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
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    unit: {
      upsert: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    adventureEpisode: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    adventureSegment: { findMany: jest.fn().mockResolvedValue([]) },
    adventureDailyRecord: { findFirst: jest.fn().mockResolvedValue(null) },
    adventureProgress: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
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

  const mockLlmService = {
    buildEnglishTutorPrompt: jest.fn().mockReturnValue([
      { role: "system", content: "prompt" },
      { role: "user", content: "你好" },
    ]),
    complete: jest.fn().mockResolvedValue({
      text: "Hello! I'm fine, thank you.",
    }),
  };

  beforeAll(async () => {
    // 本套件锁定非流式（单模型）契约；流式全链路见 vendor-stream.e2e-spec.ts
    process.env.LLM_STREAM_ENABLED = "false";

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .overrideProvider(RagService)
      .useValue(mockRagService)
      .overrideProvider(LlmService)
      .useValue(mockLlmService)
      .overrideProvider(ChildMemoriesService)
      .useValue({
        extractAndStore: jest.fn().mockResolvedValue(0),
        buildPromptBlock: jest
          .fn()
          .mockResolvedValue({ text: "", memoryIds: [] }),
        markInjected: jest.fn().mockResolvedValue(undefined),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0);

    const server = app.getHttpServer();
    const address = server.address();
    const port = typeof address === "string" ? 0 : address.port;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    if (client?.connected) {
      client.disconnect();
    }
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (client?.connected) {
      client.disconnect();
    }
  });

  const connectClient = (): Promise<ClientSocket> => {
    return new Promise((resolve, reject) => {
      const socket = io(`${baseUrl}/vendor`, {
        transports: ["websocket"],
        forceNew: true,
      });

      // 防止无限等待
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

  it("should connect to /vendor namespace", async () => {
    client = await connectClient();
    expect(client.connected).toBe(true);
  });

  it("should respond to vendor:ping with vendor:pong", async () => {
    client = await connectClient();

    const pong = await new Promise<{ timestamp: number }>((resolve, reject) => {
      client.once("vendor:pong", (data) => resolve(data));
      client.emit("vendor:ping");

      setTimeout(() => reject(new Error("pong timeout")), 2000);
    });

    expect(pong).toHaveProperty("timestamp");
    expect(typeof pong.timestamp).toBe("number");
  });

  it("should reply vendor:text:in as vendor:text:out via RAG/LLM", async () => {
    client = await connectClient();

    const reply = await new Promise<{
      deviceId: string;
      responseText: string;
    }>((resolve, reject) => {
      client.once("vendor:text:out", (data) => resolve(data));
      client.emit("vendor:text:in", {
        deviceId: "e2e-dev-001",
        asrText: "你好",
      });

      setTimeout(() => reject(new Error("text out timeout")), 2000);
    });

    expect(reply.deviceId).toBe("e2e-dev-001");
    expect(reply.responseText).toBe("Hello! I'm fine, thank you.");
  });

  it("should return vendor:error for invalid text payload", async () => {
    client = await connectClient();

    const error = await new Promise<{
      event: string;
      message: string;
    }>((resolve, reject) => {
      client.once("vendor:error", (data) => resolve(data));
      client.emit("vendor:text:in", {
        deviceId: "",
        asrText: "",
      });

      setTimeout(() => reject(new Error("error timeout")), 2000);
    });

    expect(error.event).toBe("vendor:text:in");
    expect(error.message).toContain("deviceId");
  });
});
