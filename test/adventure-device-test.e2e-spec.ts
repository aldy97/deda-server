import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { AddressInfo } from "net";
import { AppModule } from "./../src/app.module";
import { PrismaService } from "./../src/common/prisma/prisma.service";
import { LlmService } from "./../src/modules/llm/llm.service";
import { AdventureTestAccessService } from "./../src/modules/adventure/adventure-test-access.service";
import { adventureTestNotFoundText } from "./../src/modules/adventure/adventure.constants";

/**
 * 样机试播 e2e：真实 AppModule（Redis 走 e2e-database.setup 的内存兜底），
 * Prisma/Llm 按 adventure-stream 的既有口径 mock，不出网、不写库。
 * 通过主链路 OpenAI 兼容端点 POST /v1/chat/completions 验证：
 * 触发词开播 → 同日无限重玩（runSeq 事件键不撞）→ 草稿标题命中 → 未知标题话术。
 */
describe("Adventure device test (e2e)", () => {
  let app: INestApplication;
  let testAccess: AdventureTestAccessService;
  let baseUrl: string;
  let prisma: typeof mockPrismaService;

  const device = {
    id: "test-device-uuid",
    deviceId: "test-dev-001",
    characterKey: "elly",
  };
  const episode = {
    id: "episode-1",
    characterKey: "elly",
    season: 1,
    episodeNumber: 1,
    title: "听风原野第一天",
    recap: "前情回顾：Elly 住在听风原野。",
    published: true,
    currentVersionId: null,
  };
  const segments = [
    {
      id: "s0",
      episodeId: "episode-1",
      order: 0,
      kind: "narration",
      text: "今天 Elly 要去找银色铃铛。",
    },
    {
      id: "s1",
      episodeId: "episode-1",
      order: 1,
      kind: "interaction",
      interactionType: "two_choice",
      text: "我们去森林还是去河边？",
      options: { choices: [] },
      fallbackText: "没关系，那我们先去森林吧！",
      rewardStar: true,
    },
  ];
  const baseDaily = {
    id: "daily-1",
    deviceId: device.id,
    episodeId: episode.id,
    assignedDate: "2026-11-20",
    status: "in_progress",
    assignedAt: new Date(),
    completedAt: null,
    completedDate: null,
  };
  const baseProgress = {
    id: "progress-1",
    deviceId: device.id,
    episodeId: episode.id,
    nextSegmentOrder: 0,
    status: "in_progress",
    waitingSince: null,
    stars: 0,
    offTopicCount: 0,
    completedAt: null,
    episodeVersionId: null,
  };

  const eventCalls: Array<{ eventKey: string; payload: unknown }> = [];
  const progressCreates: Array<Record<string, unknown>> = [];

  type PrismaCall = { data?: Record<string, unknown> };

  const mockPrismaService = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
      callback(mockPrismaService),
    ),
    device: {
      findFirst: jest.fn().mockResolvedValue(device),
      findUnique: jest.fn().mockResolvedValue({ characterKey: "elly" }),
    },
    message: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ id: "message-1" }),
    },
    adventureEpisode: {
      findMany: jest.fn().mockResolvedValue([episode]),
      findUnique: jest.fn().mockResolvedValue(episode),
    },
    adventureEpisodeVersion: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    adventureSegment: { findMany: jest.fn().mockResolvedValue(segments) },
    adventureDailyRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(baseDaily),
      update: jest
        .fn()
        .mockImplementation((args: PrismaCall) =>
          Promise.resolve({ ...baseDaily, ...args.data }),
        ),
    },
    adventureProgress: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((args: PrismaCall) => {
        progressCreates.push(args.data ?? {});
        return Promise.resolve({ ...baseProgress, ...args.data });
      }),
      update: jest
        .fn()
        .mockImplementation((args: PrismaCall) =>
          Promise.resolve({ ...baseProgress, ...args.data }),
        ),
    },
    adventureEvent: {
      create: jest.fn().mockImplementation((args: PrismaCall) => {
        const data = (args.data ?? {}) as {
          eventKey: string;
          payload: unknown;
        };
        eventCalls.push({ eventKey: data.eventKey, payload: data.payload });
        return Promise.resolve({ id: `event-${data.eventKey}`, ...data });
      }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    turnDecisionLog: { upsert: jest.fn().mockResolvedValue({}) },
  };

  const mockLlmService = {
    complete: jest.fn().mockResolvedValue({ text: "free_chat" }),
    completeStream: jest.fn(async function* () {
      yield "自由对话兜底";
    }),
    buildEnglishTutorPrompt: jest.fn(),
    buildAdventureInteractionPrompt: jest.fn(),
    buildAdventureChoiceMatchPrompt: jest.fn(),
  };

  beforeAll(async () => {
    process.env.LLM_ADAPTER_API_KEY = "test-key";
    process.env.ADVENTURE_TEST_MODE_ENABLED = "true";

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .overrideProvider(LlmService)
      .useValue(mockLlmService)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0);
    testAccess = app.get(AdventureTestAccessService);
    prisma = mockPrismaService;
    const address = app.getHttpServer().address();
    baseUrl = `http://localhost:${
      typeof address === "string" ? 0 : (address as AddressInfo).port
    }`;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.LLM_ADAPTER_API_KEY;
    delete process.env.ADVENTURE_TEST_MODE_ENABLED;
  });

  async function chatCompletions(asrText: string): Promise<string> {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "x-deda-device-id": device.deviceId,
      },
      body: JSON.stringify({
        model: "deda",
        stream: false,
        messages: [{ role: "user", content: asrText }],
      }),
    });
    expect(res.status).toBe(201); // Nest POST 默认 201；@Res() 透传不覆写
    const body = await res.json();
    return body.choices[0].message.content;
  }

  it("replies with the deterministic not-found line for an unknown title and never arms", async () => {
    prisma.adventureEpisode.findMany.mockResolvedValue([]);
    prisma.adventureEpisodeVersion.findMany.mockResolvedValue([]);

    const content = await chatCompletions("我想玩不存在的故事");

    expect(content).toBe(adventureTestNotFoundText("不存在的故事"));
    expect(await testAccess.peek(device.id)).toBeNull();
    expect(eventCalls).toHaveLength(0);
  });

  it("plays the triggered episode from segment 0 and arms the session", async () => {
    prisma.adventureEpisode.findMany.mockResolvedValue([episode]);
    prisma.adventureEpisodeVersion.findMany.mockResolvedValue([]);

    const content = await chatCompletions("我想玩听风原野第一天");

    expect(content).toBe(
      [episode.recap, segments[0].text, segments[1].text].join(""),
    );
    const session = await testAccess.peek(device.id);
    expect(session).toMatchObject({
      episodeId: "episode-1",
      title: "听风原野第一天",
      runSeq: 1,
      source: "voice_trigger",
    });
    expect(eventCalls.some((e) => e.eventKey.includes("assigned:run:1"))).toBe(
      true,
    );
    expect(
      eventCalls.find((e) => e.eventKey.includes("assigned:run:1"))?.payload,
    ).toMatchObject({ test: true, runSeq: 1 });
  });

  it("replays the same episode on the same day without colliding event keys", async () => {
    const content = await chatCompletions("我想玩听风原野第一天");

    expect(content).toBe(
      [episode.recap, segments[0].text, segments[1].text].join(""),
    );
    const session = await testAccess.peek(device.id);
    expect(session?.runSeq).toBe(2);
    expect(eventCalls.some((e) => e.eventKey.includes("assigned:run:2"))).toBe(
      true,
    );
  });

  it("plays the draft version when the spoken title matches the draft payload", async () => {
    const draftPayload = {
      title: "未发布的新标题",
      recap: "草稿回顾：这一集还在打磨。",
      segments: [segments[0], segments[1]],
    };
    prisma.adventureEpisode.findMany.mockResolvedValue([]);
    prisma.adventureEpisodeVersion.findMany.mockResolvedValue([
      { id: "v-draft-9", payload: draftPayload, episode },
    ]);
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue({
      id: "v-draft-9",
      version: 9,
      payload: draftPayload,
    });

    const content = await chatCompletions("我想玩未发布的新标题");

    expect(content).toBe(
      ["草稿回顾：这一集还在打磨。", segments[0].text, segments[1].text].join(
        "",
      ),
    );
    expect(
      progressCreates.some((p) => p.episodeVersionId === "v-draft-9"),
    ).toBe(true);
  });

  it("starts the episode despite a trailing period in the ASR title", async () => {
    prisma.adventureEpisode.findMany.mockResolvedValue([episode]);
    prisma.adventureEpisodeVersion.findMany.mockResolvedValue([]);

    const content = await chatCompletions("我想玩听风原野第一天。");

    expect(content).toBe(
      [episode.recap, segments[0].text, segments[1].text].join(""),
    );
  });
});
