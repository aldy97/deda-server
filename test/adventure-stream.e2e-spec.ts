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
import { AdventureService } from "./../src/modules/adventure/adventure.service";

/**
 * 冒险故事全链路 e2e：假机芯厂云上行 ASR，真实我方状态机与 WS 上传编排。
 * LLM、DB 均为内存 mock，不出网；超时用过期 waitingSince + sweep 避免真实等待 10s。
 */
describe("Adventure streaming pipeline (e2e)", () => {
  let app: INestApplication;
  let asrClient: ClientSocket;
  let adventureService: AdventureService;
  let baseUrl: string;
  let vendorHttpServer: HttpServer;
  let vendorCloud: SocketIOServer;

  const uploadedEvents: Array<{ event: string; data: any }> = [];
  const messages: any[] = [];
  const device = { id: "adventure-device-uuid", deviceId: "adventure-dev-001" };
  const episode = {
    id: "episode-1",
    season: 1,
    episodeNumber: 1,
    title: "听风原野第一天",
    recap: "前情回顾：Elly 住在听风原野。",
    published: true,
  };
  const segments = [
    {
      id: "s0",
      episodeId: episode.id,
      order: 0,
      kind: "narration",
      text: "今天 Elly 要去找银色铃铛。",
    },
    {
      id: "s1",
      episodeId: episode.id,
      order: 1,
      kind: "interaction",
      interactionType: "two_choice",
      text: "我们去森林还是去河边？",
      options: {
        choices: [
          { key: "forest", text: "森林", reply: "好呀，我们去森林！" },
          { key: "river", text: "河边", reply: "好呀，我们去河边！" },
        ],
      },
      fallbackText: "没关系，那我们先去森林吧！",
      exitText: "好呀，我们明天接着玩。",
      rewardStar: true,
    },
    {
      id: "s2",
      episodeId: episode.id,
      order: 2,
      kind: "narration",
      text: "森林里有一只抱着铃铛的小松鼠。",
    },
    {
      id: "s3",
      episodeId: episode.id,
      order: 3,
      kind: "interaction",
      interactionType: "open_question",
      text: "你觉得 Elly 会对小松鼠说什么呢？",
      options: null,
      fallbackText: "没关系，我们一起接着看。",
      exitText: "好呀，我们明天接着玩。",
      rewardStar: false,
    },
    {
      id: "s4",
      episodeId: episode.id,
      order: 4,
      kind: "narration",
      text: "Elly 谢谢小松鼠，还请它一起把铃铛送回去。",
    },
    {
      id: "s5",
      episodeId: episode.id,
      order: 5,
      kind: "interaction",
      interactionType: "two_choice",
      text: "我们唱歌回去，还是讲故事回去？",
      options: {
        choices: [
          { key: "sing", text: "唱歌", reply: "好呀，我们一起唱歌！" },
          { key: "story", text: "讲故事", reply: "好呀，我们来讲故事！" },
        ],
      },
      fallbackText: "没关系，那我们就唱着歌回去吧！",
      exitText: "好呀，我们明天接着玩。",
      rewardStar: false,
    },
    {
      id: "s6",
      episodeId: episode.id,
      order: 6,
      kind: "narration",
      text: "铃铛在风里唱起歌，Elly 开开心心地回家了。",
    },
  ];
  let progress: any = null;
  let dailyRecord: any = null;
  const events: any[] = [];

  const mockPrismaService = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $transaction: jest.fn((callback) => callback(mockPrismaService)),
    device: {
      findUnique: jest.fn(({ where }) => {
        if (where.id === device.id || where.deviceId === device.deviceId) {
          return Promise.resolve(device);
        }
        return Promise.resolve(null);
      }),
      create: jest.fn().mockResolvedValue(device),
    },
    deviceConfig: { findFirst: jest.fn().mockResolvedValue(null) },
    childProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    message: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(({ data }) => {
        const row = { id: `message-${messages.length + 1}`, ...data };
        messages.push(row);
        return Promise.resolve(row);
      }),
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
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    adventureEpisode: {
      findMany: jest.fn().mockResolvedValue([episode]),
    },
    adventureSegment: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(segments)),
    },
    adventureDailyRecord: {
      findFirst: jest.fn(({ where }) => {
        if (where.completedDate) {
          return Promise.resolve(
            dailyRecord?.status === "completed" &&
              dailyRecord.completedDate === where.completedDate
              ? dailyRecord
              : null,
          );
        }
        if (where.status === "in_progress") {
          return Promise.resolve(
            dailyRecord?.status === "in_progress" ? dailyRecord : null,
          );
        }
        return Promise.resolve(dailyRecord);
      }),
      create: jest.fn(({ data }) => {
        dailyRecord = {
          id: "daily-1",
          assignedAt: new Date(),
          completedAt: null,
          completedDate: null,
          ...data,
        };
        return Promise.resolve(dailyRecord);
      }),
      update: jest.fn(({ data }) => {
        dailyRecord = { ...dailyRecord, ...data };
        return Promise.resolve(dailyRecord);
      }),
    },
    adventureEvent: {
      create: jest.fn(({ data }) => {
        const row = { id: `event-${events.length + 1}`, ...data };
        events.push(row);
        return Promise.resolve(row);
      }),
      upsert: jest.fn(({ where, create }) => {
        const existing = events.find((row) => row.eventKey === where.eventKey);
        if (existing) {
          return Promise.resolve(existing);
        }
        const row = { id: `event-${events.length + 1}`, ...create };
        events.push(row);
        return Promise.resolve(row);
      }),
    },
    adventureProgress: {
      findUnique: jest.fn(({ where }) =>
        Promise.resolve(
          progress &&
            progress.deviceId === where.deviceId_episodeId.deviceId &&
            progress.episodeId === where.deviceId_episodeId.episodeId
            ? progress
            : null,
        ),
      ),
      findMany: jest.fn(({ where }) => {
        if (
          where.waitingSince?.lte &&
          progress?.status === "awaiting_reply" &&
          progress.waitingSince &&
          progress.waitingSince <= where.waitingSince.lte
        ) {
          return Promise.resolve([progress]);
        }
        if (where.episode) {
          return Promise.resolve(
            progress
              ? [{ episodeId: progress.episodeId, status: progress.status }]
              : [],
          );
        }
        return Promise.resolve([]);
      }),
      create: jest.fn(({ data }) => {
        progress = {
          id: "progress-1",
          nextSegmentOrder: 0,
          stars: 0,
          offTopicCount: 0,
          waitingSince: null,
          completedAt: null,
          ...data,
        };
        return Promise.resolve(progress);
      }),
      update: jest.fn(({ data }) => {
        progress = { ...progress, ...data };
        return Promise.resolve(progress);
      }),
    },
  };

  const mockRagService = {
    retrieve: jest.fn(),
    truncateContent: jest.fn((content: string) => content),
  };
  const mockLlmService = {
    get smallModelName() {
      return "small-llm";
    },
    buildAdventureInteractionPrompt: jest.fn((params) => [
      { role: "system", content: JSON.stringify(params) },
      { role: "user", content: params.childReply },
    ]),
    complete: jest.fn().mockResolvedValue({ text: "这个想法真温柔呀！" }),
    completeStream: jest.fn(),
    buildFillerPrompt: jest.fn(),
    buildEnglishTutorPrompt: jest.fn(),
  };

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error("waitFor timeout");
      }
      await sleep(20);
    }
  };

  const sendAsr = async (asrText: string, expectedAssistantRows: number) => {
    const fullReplyCount = uploadedEvents.filter(
      (event) => event.event === "vendor:text:out",
    ).length;
    asrClient.emit("vendor:text:in", { deviceId: device.deviceId, asrText });
    await waitFor(
      () =>
        uploadedEvents.filter((event) => event.event === "vendor:text:out")
          .length > fullReplyCount &&
        messages.filter((row) => row.role === "assistant").length >=
          expectedAssistantRows,
    );
  };

  const chunksSince = (index: number) =>
    uploadedEvents
      .slice(index)
      .filter((event) => event.event === "vendor:text:chunk")
      .map((event) => event.data);

  beforeAll(async () => {
    vendorHttpServer = createServer();
    vendorCloud = new SocketIOServer(vendorHttpServer, {
      cors: { origin: "*" },
    });
    vendorCloud.on("connection", (socket) => {
      socket.on("vendor:text:chunk", (data, ack) => {
        uploadedEvents.push({ event: "vendor:text:chunk", data });
        if (typeof ack === "function") ack();
      });
      socket.on("vendor:text:out", (data, ack) => {
        uploadedEvents.push({ event: "vendor:text:out", data });
        if (typeof ack === "function") ack();
      });
    });
    await new Promise<void>((resolve) =>
      vendorHttpServer.listen(0, () => resolve()),
    );
    const vendorPort = (vendorHttpServer.address() as AddressInfo).port;
    process.env.VENDOR_WS_UPLOAD_URL = `http://localhost:${vendorPort}`;

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
    adventureService = app.get(AdventureService);
    const address = app.getHttpServer().address();
    baseUrl = `http://localhost:${typeof address === "string" ? 0 : address.port}`;

    asrClient = io(`${baseUrl}/vendor`, {
      transports: ["websocket"],
      forceNew: true,
    });
    await waitFor(() => asrClient.connected);
  });

  afterAll(async () => {
    asrClient?.disconnect();
    await app.close();
    await new Promise<void>((resolve) => vendorCloud.close(() => resolve()));
    delete process.env.VENDOR_WS_UPLOAD_URL;
  });

  it("should play a full episode in order with interaction, timeout, progress and persistence", async () => {
    // 1) 开集：recap + 旁白 + 二选一引导词
    let eventIndex = uploadedEvents.length;
    await sendAsr("讲故事", 1);
    let chunks = chunksSince(eventIndex);
    expect(chunks.map((chunk) => chunk.delta)).toEqual([
      episode.recap,
      segments[0].text,
      segments[1].text,
      "",
    ]);
    expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2, 3]);
    expect(chunks.every((chunk) => chunk.source === "answer")).toBe(true);
    expect(chunks[3].isFinal).toBe(true);
    expect(progress).toMatchObject({
      status: "awaiting_reply",
      nextSegmentOrder: 2,
      stars: 0,
    });
    expect(progress.waitingSince).toBeInstanceOf(Date);

    // 2) 二选一命中：预生成回应 + 旁白 + 开放提问，不调小模型
    eventIndex = uploadedEvents.length;
    await sendAsr("森林", 2);
    chunks = chunksSince(eventIndex);
    expect(chunks.map((chunk) => chunk.delta)).toEqual([
      "好呀，我们去森林！",
      segments[2].text,
      segments[3].text,
      "",
    ]);
    expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2, 3]);
    expect(progress).toMatchObject({
      status: "awaiting_reply",
      nextSegmentOrder: 4,
      stars: 1,
    });
    // 开集分类调用一次；二选一命中本身不调用互动小模型。
    expect(mockLlmService.complete).toHaveBeenCalledTimes(1);
    expect(
      mockLlmService.complete.mock.calls.filter(
        ([options]) => options.maxTokens === 80,
      ),
    ).toHaveLength(0);

    // 3) 开放提问：小模型只接话，主线仍播人写下一段
    eventIndex = uploadedEvents.length;
    await sendAsr("Elly 会说谢谢", 3);
    chunks = chunksSince(eventIndex);
    expect(chunks.map((chunk) => chunk.delta)).toEqual([
      "这个想法真温柔呀！",
      segments[4].text,
      segments[5].text,
      "",
    ]);
    expect(mockLlmService.complete).toHaveBeenCalledTimes(2);
    expect(
      mockLlmService.complete.mock.calls.filter(
        ([options]) => options.maxTokens === 80,
      ),
    ).toHaveLength(1);
    expect(mockLlmService.buildAdventureInteractionPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "open_question" }),
    );
    expect(progress).toMatchObject({
      status: "awaiting_reply",
      nextSegmentOrder: 6,
      stars: 1,
    });

    // 4) 沉默：过期后 sweep 上传兜底与结局，不产生 user 行
    const userRowsBeforeTimeout = messages.filter(
      (row) => row.role === "user",
    ).length;
    eventIndex = uploadedEvents.length;
    progress.waitingSince = new Date(Date.now() - 11000);
    await adventureService.sweepTimeouts();
    chunks = chunksSince(eventIndex);
    expect(chunks.map((chunk) => chunk.delta)).toEqual([
      segments[5].fallbackText,
      segments[6].text,
      "",
    ]);
    expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2]);
    expect(messages.filter((row) => row.role === "user")).toHaveLength(
      userRowsBeforeTimeout,
    );
    expect(progress).toMatchObject({
      status: "completed",
      nextSegmentOrder: 7,
      stars: 1,
      waitingSince: null,
      completedAt: expect.any(Date),
    });
    expect(dailyRecord).toMatchObject({
      status: "completed",
      completedAt: expect.any(Date),
      completedDate: expect.any(String),
    });
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "daily_assigned",
        "started",
        "segments_presented",
        "answered",
        "timeout",
        "completed",
      ]),
    );
    expect(
      events.filter((event) => event.eventType === "completed"),
    ).toHaveLength(1);

    const assistantRows = messages.filter((row) => row.role === "assistant");
    expect(assistantRows).toHaveLength(4);
    expect(assistantRows[0].content).toBe(
      [episode.recap, segments[0].text, segments[1].text].join("\n"),
    );
    expect(assistantRows[3].content).toBe(
      [segments[5].fallbackText, segments[6].text].join("\n"),
    );
    expect(assistantRows[3].rawPayload).toEqual({
      filler: null,
      answer: [segments[5].fallbackText, segments[6].text].join("\n"),
      interactionResult: "timeout",
    });
    expect(assistantRows.every((row) => row.mode === "adventure_story")).toBe(
      true,
    );
    expect(mockRagService.retrieve).not.toHaveBeenCalled();
    expect(mockLlmService.completeStream).not.toHaveBeenCalled();
    await expect(
      adventureService.startToday(device.id, true),
    ).resolves.toBeNull();
  });
});
