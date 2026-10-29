import { Test, TestingModule } from "@nestjs/testing";
import { AdventureService } from "./adventure.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";

/**
 * 冒险引擎状态机单测（TDD 先行）
 * 覆盖：开集/续玩/限量、旁白推进、四种交互原语、五类处置、
 * 10s 沉默超时、竞态、重启恢复 sweep、设备隔离。
 */
describe("AdventureService", () => {
  let service: AdventureService;
  let prisma: any;
  let llm: any;

  const episode = {
    id: "ep1",
    characterKey: "elly",
    season: 1,
    episodeNumber: 1,
    title: "听风原野第一天",
    recap: "前情回顾：Elly 住在听风原野。",
    published: true,
  };

  // 0/1 旁白 → 2 二选一(带星光) → 3 旁白 → 4 开放提问 → 5 旁白结局
  const segments = [
    {
      id: "s0",
      episodeId: "ep1",
      order: 0,
      kind: "narration",
      text: "今天 Elly 要出门啦。",
    },
    {
      id: "s1",
      episodeId: "ep1",
      order: 1,
      kind: "narration",
      text: "它来到一条小河边。",
    },
    {
      id: "s2",
      episodeId: "ep1",
      order: 2,
      kind: "interaction",
      text: "我们去森林还是去河边？",
      interactionType: "two_choice",
      options: {
        choices: [
          { key: "forest", text: "森林", reply: "好呀，我们去森林！" },
          { key: "river", text: "河边", reply: "走，我们去河边！" },
        ],
      },
      fallbackText: "没关系，那我替你选森林吧！",
      exitText: "好呀，那我们明天接着玩。",
      rewardStar: true,
    },
    {
      id: "s3",
      episodeId: "ep1",
      order: 3,
      kind: "narration",
      text: "森林里有一只小松鼠。",
    },
    {
      id: "s4",
      episodeId: "ep1",
      order: 4,
      kind: "interaction",
      text: "你觉得 Elly 会怎么做呢？",
      interactionType: "open_question",
      options: null,
      fallbackText: "没关系，我们一起接着看。",
      exitText: "好呀，那我们明天接着玩。",
      rewardStar: false,
    },
    {
      id: "s5",
      episodeId: "ep1",
      order: 5,
      kind: "narration",
      text: "最后，Elly 开开心心地回家了。",
    },
  ];

  const baseProgress = {
    id: "prog1",
    deviceId: "dev-uuid-1",
    episodeId: "ep1",
    nextSegmentOrder: 0,
    status: "in_progress",
    waitingSince: null,
    stars: 0,
    offTopicCount: 0,
    completedAt: null,
  };

  const baseDaily = {
    id: "daily-1",
    deviceId: "dev-uuid-1",
    episodeId: "ep1",
    assignedDate: "2026-10-29",
    status: "in_progress",
    assignedAt: new Date("2026-10-29T08:00:00Z"),
    completedAt: null,
    completedDate: null,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdventureService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: jest.fn((callback) => callback(prisma)),
            device: { findUnique: jest.fn() },
            adventureEpisode: { findFirst: jest.fn(), findMany: jest.fn() },
            adventureSegment: { findMany: jest.fn() },
            adventureDailyRecord: {
              findFirst: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
            adventureEvent: {
              create: jest.fn(),
              upsert: jest.fn(),
            },
            adventureProgress: {
              findFirst: jest.fn(),
              findUnique: jest.fn(),
              findMany: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
          },
        },
        {
          provide: LlmService,
          useValue: {
            complete: jest.fn(),
            buildAdventureInteractionPrompt: jest.fn((params) => [
              { role: "system", content: JSON.stringify(params) },
              { role: "user", content: params.childReply },
            ]),
            get smallModelName() {
              return "small-llm";
            },
          },
        },
      ],
    }).compile();

    service = module.get<AdventureService>(AdventureService);
    prisma = module.get(PrismaService);
    llm = module.get(LlmService);

    prisma.device.findUnique.mockResolvedValue({ characterKey: "elly" });
    prisma.adventureEpisode.findFirst.mockResolvedValue(episode);
    prisma.adventureEpisode.findMany.mockResolvedValue([episode]);
    prisma.adventureSegment.findMany.mockResolvedValue(segments);
    prisma.adventureDailyRecord.create.mockResolvedValue(baseDaily);
    prisma.adventureDailyRecord.update.mockImplementation((args) =>
      Promise.resolve({ ...baseDaily, ...args.data }),
    );
    prisma.adventureEvent.create.mockImplementation((args) =>
      Promise.resolve({ id: `event-${args.data.eventKey}`, ...args.data }),
    );
    prisma.adventureEvent.upsert.mockImplementation((args) =>
      Promise.resolve({ id: `event-${args.where.eventKey}`, ...args.create }),
    );
    prisma.adventureProgress.create.mockImplementation((args) =>
      Promise.resolve({ ...baseProgress, ...args.data }),
    );
    prisma.adventureProgress.update.mockImplementation((args) =>
      Promise.resolve({ ...baseProgress, ...args.data }),
    );
    // 旧用例仍通过 findFirst 准备进度；适配层映射到新 DailyRecord + findUnique 查询。
    prisma.adventureProgress.findUnique.mockImplementation((args) =>
      prisma.adventureProgress.findFirst({
        where: { deviceId: args.where.deviceId_episodeId.deviceId },
      }),
    );
    prisma.adventureProgress.findMany.mockResolvedValue([]);
    prisma.adventureDailyRecord.findFirst.mockImplementation(async (args) => {
      const progress = await prisma.adventureProgress.findFirst({
        where: { deviceId: args.where.deviceId },
      });
      if (!progress) {
        return null;
      }
      if (args.where.completedDate) {
        return progress.status === "completed"
          ? {
              ...baseDaily,
              status: "completed",
              completedAt: new Date(),
              completedDate: args.where.completedDate,
            }
          : null;
      }
      return progress.status === "completed" ? null : baseDaily;
    });
    llm.complete.mockResolvedValue({ text: "哇，你说得真有意思！" });
  });

  it("should start a new episode with recap and first narration on first use of the day", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue(null);

    const reply = await service.startToday("dev-uuid-1");

    expect(reply.texts).toEqual([
      episode.recap,
      segments[0].text,
      segments[1].text,
      segments[2].text,
    ]);
    // 连续旁白推进到第一个交互点停下
    expect(reply.action).toBe("await_reply");
    expect(prisma.adventureProgress.create).toHaveBeenCalled();
    expect(prisma.adventureEpisode.findMany).toHaveBeenCalledWith({
      where: { characterKey: "elly", season: 1 },
      orderBy: { episodeNumber: "asc" },
    });
  });

  it("should select episodes and interaction persona from the device IP", async () => {
    prisma.device.findUnique.mockResolvedValue({ characterKey: "polly" });
    prisma.adventureProgress.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        ...baseProgress,
        status: "awaiting_reply",
        nextSegmentOrder: 3,
        waitingSince: new Date(),
      });

    await service.startToday("dev-uuid-1");
    await service.handleChildReply("dev-uuid-1", "我想吃冰淇淋");

    expect(prisma.adventureEpisode.findMany).toHaveBeenCalledWith({
      where: { characterKey: "polly", season: 1 },
      orderBy: { episodeNumber: "asc" },
    });
    expect(llm.buildAdventureInteractionPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        characterPersona: expect.stringContaining("Polly"),
      }),
    );
  });

  it("should not start a new episode when today's episode is already completed", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "completed",
    });

    expect(await service.startToday("dev-uuid-1")).toBeNull();
  });

  it("should resume an in-progress episode without replaying the recap", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      nextSegmentOrder: 3,
    });

    const reply = await service.startToday("dev-uuid-1");

    expect(reply.texts).not.toContain(episode.recap);
    expect(reply.texts[0]).toBe(segments[3].text);
  });

  it("should start the reply timeout only after the prompt upload is acknowledged", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue(null);

    const reply = await service.startToday("dev-uuid-1");

    expect(reply.action).toBe("await_reply");
    expect(prisma.adventureProgress.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "awaiting_reply",
          waitingSince: null,
        }),
      }),
    );

    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "awaiting_reply",
      nextSegmentOrder: 3,
      waitingSince: null,
    });
    prisma.adventureProgress.update.mockClear();
    await service.markPromptPlaybackComplete("dev-uuid-1");

    expect(prisma.adventureProgress.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { waitingSince: expect.any(Date) },
      }),
    );
  });

  it("should play the pre-generated reply for a matched two-choice answer and award a star", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "awaiting_reply",
      nextSegmentOrder: 3, // 已播完 s2（二选一）
      waitingSince: new Date(),
    });

    const reply = await service.handleChildReply("dev-uuid-1", "我要去森林");

    expect(reply.texts[0]).toBe("好呀，我们去森林！");
    expect(reply.texts).toContain(segments[3].text); // 回应后汇流续播
    expect(reply.action).toBe("await_reply"); // s3 播完到 s4 开放提问
    expect(llm.complete).not.toHaveBeenCalled(); // 二选一命中不调 LLM
    expect(prisma.adventureProgress.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stars: 1 }),
      }),
    );
  });

  it("should gently redirect the first off-topic answer via the small model", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "awaiting_reply",
      nextSegmentOrder: 3,
      waitingSince: new Date(),
    });

    const reply = await service.handleChildReply("dev-uuid-1", "我想吃冰淇淋");

    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(reply.texts[0]).toBe("哇，你说得真有意思！");
    expect(prisma.adventureProgress.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ offTopicCount: 1 }),
      }),
    );
    // 引回后仍停在当前交互点等待，不推进主线
    expect(reply.action).toBe("await_reply");
  });

  it("should fall back to the canned fallback text on the second off-topic answer without calling the LLM", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "awaiting_reply",
      nextSegmentOrder: 3,
      waitingSince: new Date(),
      offTopicCount: 1,
    });

    const reply = await service.handleChildReply("dev-uuid-1", "我还是不想选");

    expect(llm.complete).not.toHaveBeenCalled();
    expect(reply.texts[0]).toBe(segments[2].fallbackText);
    expect(reply.texts).toContain(segments[3].text); // 兜底后推进主线
  });

  it("should call the small model for an open question answer", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "awaiting_reply",
      nextSegmentOrder: 5, // 已播完 s4（开放提问）
      waitingSince: new Date(),
    });

    const reply = await service.handleChildReply("dev-uuid-1", "Elly 会害怕的");

    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(reply.texts[0]).toBe("哇，你说得真有意思！");
    expect(reply.texts).toContain(segments[5].text); // 接话后续播结局
    expect(reply.action).toBe("completed");
  });

  it("should degrade to fallback text when the small model fails", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "awaiting_reply",
      nextSegmentOrder: 5,
      waitingSince: new Date(),
    });
    llm.complete.mockRejectedValue(new Error("small model down"));

    const reply = await service.handleChildReply("dev-uuid-1", "Elly 会害怕");

    expect(reply.texts[0]).toBe(segments[4].fallbackText);
    expect(reply.action).toBe("completed");
  });

  it("should exit the adventure on explicit refusal and keep progress resumable", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "awaiting_reply",
      nextSegmentOrder: 3,
      waitingSince: new Date(),
    });

    const reply = await service.handleChildReply("dev-uuid-1", "我不要听了");

    expect(reply.action).toBe("exit");
    expect(reply.texts).toEqual([segments[2].exitText]);
    // 进度保留（不 completed、不推进），仅明确请求时续玩
    expect(prisma.adventureProgress.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "exited" }),
      }),
    );
  });

  it("should return to free chat after exit and resume only on an explicit story request", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "exited",
      nextSegmentOrder: 3,
    });

    expect(await service.startToday("dev-uuid-1", false)).toBeNull();
    const resumed = await service.startToday("dev-uuid-1", true);
    expect(resumed.texts[0]).toBe(segments[3].text);
  });

  it("should continue with fallback when no reply arrives within 10s", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "awaiting_reply",
      nextSegmentOrder: 3,
      waitingSince: new Date(Date.now() - 11000), // 11 秒前说完引导词
    });

    const reply = await service.checkTimeout("dev-uuid-1");

    expect(reply).not.toBeNull();
    expect(reply.texts[0]).toBe(segments[2].fallbackText);
    expect(reply.texts).toContain(segments[3].text);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("should not trigger timeout before 10s elapses", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "awaiting_reply",
      nextSegmentOrder: 3,
      waitingSince: new Date(Date.now() - 5000), // 才过 5 秒
    });

    expect(await service.checkTimeout("dev-uuid-1")).toBeNull();
  });

  it("should sweep and recover all timed-out waiting progresses (restart recovery)", async () => {
    prisma.adventureProgress.findMany.mockResolvedValue([
      {
        ...baseProgress,
        id: "progA",
        deviceId: "dev-A",
        status: "awaiting_reply",
        nextSegmentOrder: 3,
        waitingSince: new Date(Date.now() - 15000),
      },
      {
        ...baseProgress,
        id: "progB",
        deviceId: "dev-B",
        status: "awaiting_reply",
        nextSegmentOrder: 3,
        waitingSince: new Date(Date.now() - 12000),
      },
    ]);
    prisma.adventureProgress.findFirst.mockImplementation((args) =>
      Promise.resolve({
        ...baseProgress,
        deviceId: args.where.deviceId,
        status: "awaiting_reply",
        nextSegmentOrder: 3,
        waitingSince: new Date(Date.now() - 15000),
      }),
    );

    const timeoutListener = jest.fn().mockResolvedValue(undefined);
    service.registerTimeoutListener(timeoutListener);
    const recovered = await service.sweepTimeouts();

    expect(recovered).toHaveLength(2);
    expect(recovered.map((r) => r.deviceId)).toEqual(["dev-A", "dev-B"]);
    expect(timeoutListener).toHaveBeenCalledTimes(2);
    for (const r of recovered) {
      expect(r.reply.texts[0]).toBe(segments[2].fallbackText);
    }
  });

  it("should keep devices isolated: one device's reply does not cancel another's timeout", async () => {
    // A 设备等待中且已超时；B 设备正常回答不应影响 A 的兜底
    prisma.adventureProgress.findFirst.mockImplementation((args) =>
      Promise.resolve({
        ...baseProgress,
        deviceId: args.where.deviceId,
        status: "awaiting_reply",
        nextSegmentOrder: 3,
        waitingSince: new Date(Date.now() - 11000),
      }),
    );

    await service.handleChildReply("dev-B", "森林");
    const replyA = await service.checkTimeout("dev-A");

    expect(replyA).not.toBeNull();
    expect(replyA.texts[0]).toBe(segments[2].fallbackText);
  });

  it("should mark the episode completed after the last segment", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "awaiting_reply",
      nextSegmentOrder: 5,
      waitingSince: new Date(),
    });

    const reply = await service.handleChildReply("dev-uuid-1", "它会勇敢面对");

    expect(reply.action).toBe("completed");
    expect(prisma.adventureProgress.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "completed" }),
      }),
    );
  });

  it("should return to free chat when no published episode is available", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue(null);
    prisma.adventureEpisode.findMany.mockResolvedValue([]);

    expect(await service.startToday("dev-uuid-1")).toBeNull();
    expect(prisma.adventureProgress.create).not.toHaveBeenCalled();
  });

  it("should not intercept a child reply when the device is not awaiting one", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "in_progress",
    });

    expect(await service.handleChildReply("dev-uuid-1", "森林")).toBeNull();
  });

  it("should not advance when the waiting interaction cannot be found", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "awaiting_reply",
      nextSegmentOrder: 3,
      waitingSince: new Date(),
    });
    prisma.adventureSegment.findMany.mockResolvedValue([segments[0]]);

    expect(await service.handleChildReply("dev-uuid-1", "森林")).toBeNull();
    expect(prisma.adventureProgress.update).not.toHaveBeenCalled();
  });

  it("should ignore a prompt ack when the device is no longer waiting", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "completed",
    });

    await service.markPromptPlaybackComplete("dev-uuid-1");

    expect(prisma.adventureProgress.update).not.toHaveBeenCalled();
  });

  it("should award a reward segment and continue without waiting for a reply", async () => {
    const rewardSegments = [
      {
        id: "reward",
        episodeId: "ep1",
        order: 0,
        kind: "interaction",
        interactionType: "reward",
        text: "你获得了一颗原野星光！",
        rewardStar: true,
      },
      {
        id: "ending",
        episodeId: "ep1",
        order: 1,
        kind: "narration",
        text: "故事结束了。",
      },
    ];
    prisma.adventureProgress.findFirst.mockResolvedValue(baseProgress);
    prisma.adventureSegment.findMany.mockResolvedValue(rewardSegments);

    const reply = await service.startToday("dev-uuid-1");

    expect(reply.action).toBe("completed");
    expect(reply.texts).toEqual(rewardSegments.map((segment) => segment.text));
    expect(prisma.adventureProgress.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stars: 1, status: "completed" }),
      }),
    );
  });

  it("should encourage a repeat-after-me reply and advance without calling the LLM", async () => {
    const repeatSegments = [
      {
        id: "repeat",
        episodeId: "ep1",
        order: 0,
        kind: "interaction",
        interactionType: "repeat_after_me",
        text: "跟我说：谢谢你，好朋友！",
        options: { praise: "说得真好呀！" },
      },
      {
        id: "ending",
        episodeId: "ep1",
        order: 1,
        kind: "narration",
        text: "故事结束了。",
      },
    ];
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "awaiting_reply",
      nextSegmentOrder: 1,
      waitingSince: new Date(),
    });
    prisma.adventureSegment.findMany.mockResolvedValue(repeatSegments);

    const reply = await service.handleChildReply("dev-uuid-1", "谢谢你");

    expect(reply.texts).toEqual(["说得真好呀！", "故事结束了。"]);
    expect(reply.result).toBe("answered");
    expect(reply.action).toBe("completed");
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("should never enter or replay an adventure after today's completion", async () => {
    prisma.adventureDailyRecord.findFirst.mockImplementation((args) =>
      Promise.resolve(
        args.where.completedDate
          ? { ...baseDaily, status: "completed", completedDate: "2026-10-29" }
          : null,
      ),
    );

    expect(await service.startToday("dev-uuid-1", true)).toBeNull();
    expect(prisma.adventureEpisode.findMany).not.toHaveBeenCalled();
    expect(prisma.adventureDailyRecord.create).not.toHaveBeenCalled();
  });

  it("should resume only the assigned unfinished episode after an explicit exit", async () => {
    prisma.adventureDailyRecord.findFirst.mockImplementation((args) =>
      Promise.resolve(args.where.completedDate ? null : baseDaily),
    );
    prisma.adventureProgress.findUnique.mockResolvedValue({
      ...baseProgress,
      status: "exited",
      nextSegmentOrder: 3,
    });

    const reply = await service.startToday("dev-uuid-1", true);

    expect(reply.texts[0]).toBe(segments[3].text);
    expect(prisma.adventureDailyRecord.create).not.toHaveBeenCalled();
    expect(prisma.adventureEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dailyRecordId: "daily-1",
        eventType: "resumed",
      }),
    });
  });

  it("should select the first personally unfinished episode without replaying a completed one", async () => {
    const episode2 = { ...episode, id: "ep2", episodeNumber: 2 };
    prisma.adventureEpisode.findMany.mockResolvedValue([episode, episode2]);
    prisma.adventureProgress.findMany.mockResolvedValue([
      { ...baseProgress, status: "completed" },
    ]);

    await service.startToday("dev-uuid-1", true);

    expect(prisma.adventureDailyRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ episodeId: "ep2" }),
    });
  });

  it("should not skip an unpublished next episode", async () => {
    const episode2 = {
      ...episode,
      id: "ep2",
      episodeNumber: 2,
      published: false,
    };
    const episode3 = { ...episode, id: "ep3", episodeNumber: 3 };
    prisma.adventureEpisode.findMany.mockResolvedValue([
      episode,
      episode2,
      episode3,
    ]);
    prisma.adventureProgress.findMany.mockResolvedValue([
      { ...baseProgress, status: "completed" },
    ]);

    expect(await service.startToday("dev-uuid-1", true)).toBeNull();
    expect(prisma.adventureDailyRecord.create).not.toHaveBeenCalled();
  });

  it("should persist daily completion and an idempotent completion event", async () => {
    prisma.adventureDailyRecord.findFirst.mockImplementation((args) =>
      Promise.resolve(args.where.completedDate ? null : baseDaily),
    );
    prisma.adventureProgress.findUnique.mockResolvedValue({
      ...baseProgress,
      status: "awaiting_reply",
      nextSegmentOrder: 5,
      waitingSince: new Date(),
    });

    const reply = await service.handleChildReply("dev-uuid-1", "它会勇敢面对");

    expect(reply.action).toBe("completed");
    expect(prisma.adventureDailyRecord.update).toHaveBeenCalledWith({
      where: { id: "daily-1" },
      data: expect.objectContaining({
        status: "completed",
        completedAt: expect.any(Date),
        completedDate: expect.any(String),
      }),
    });
    expect(prisma.adventureEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { eventKey: "daily:daily-1:completed" },
        create: expect.objectContaining({ eventType: "completed" }),
      }),
    );
  });

  it("should append presented and interaction events without duplicating narrated text", async () => {
    prisma.adventureDailyRecord.findFirst.mockResolvedValue(baseDaily);

    await service.recordPresented("dev-uuid-1", "turn-1", {
      texts: ["兜底话术", "故事原文"],
      action: "completed",
      result: "timeout",
    });

    expect(prisma.adventureEvent.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.adventureEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          eventType: "segments_presented",
          payload: { action: "completed", textCount: 2 },
        }),
      }),
    );
    expect(prisma.adventureEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ eventType: "timeout" }),
      }),
    );
    const eventPayload = JSON.stringify(
      prisma.adventureEvent.upsert.mock.calls,
    );
    expect(eventPayload).not.toContain("故事原文");
  });

  it("should audit a blocked completed-day entry and its actual route", async () => {
    prisma.adventureDailyRecord.findFirst.mockResolvedValue({
      ...baseDaily,
      status: "completed",
      completedDate: "2026-10-29",
    });

    await service.recordEntryBlocked("dev-uuid-1", "free_story");

    expect(prisma.adventureEvent.create).toHaveBeenCalledTimes(2);
    expect(
      prisma.adventureEvent.create.mock.calls.map(
        (call) => call[0].data.eventType,
      ),
    ).toEqual(["entry_blocked_completed", "routed_other_mode"]);
  });

  it("should sweep on module init and stop sweeping on module destroy", async () => {
    jest.useFakeTimers();
    prisma.adventureProgress.findMany.mockResolvedValue([]);

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(2000);
    expect(prisma.adventureProgress.findMany).toHaveBeenCalledTimes(1);

    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(4000);
    expect(prisma.adventureProgress.findMany).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it("should emit the timeout fallback through the registered listener when the real timer fires", async () => {
    jest.useFakeTimers();
    const now = new Date("2026-10-29T12:00:00Z");
    jest.setSystemTime(now);
    const timeoutListener = jest.fn().mockResolvedValue(undefined);
    service.registerTimeoutListener(timeoutListener);
    prisma.adventureProgress.findFirst
      .mockResolvedValueOnce({
        ...baseProgress,
        status: "awaiting_reply",
        nextSegmentOrder: 3,
        waitingSince: null,
      })
      .mockResolvedValue({
        ...baseProgress,
        status: "awaiting_reply",
        nextSegmentOrder: 3,
        waitingSince: now,
      });

    await service.markPromptPlaybackComplete("dev-uuid-1");
    await jest.advanceTimersByTimeAsync(10000);

    expect(timeoutListener).toHaveBeenCalledWith(
      "dev-uuid-1",
      expect.objectContaining({ result: "timeout" }),
    );
    service.onModuleDestroy();
    jest.useRealTimers();
  });
});
