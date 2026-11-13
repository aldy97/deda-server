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
            adventureEpisodeVersion: {
              findUnique: jest.fn(),
              findFirst: jest.fn(),
            },
            adventureDailyRecord: {
              findFirst: jest.fn(),
              findUnique: jest.fn().mockResolvedValue(null),
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
              upsert: jest.fn(),
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
    // 版本固定：默认无 pin、无版本行 → 走既有 segments 表读路径，旧用例行为不变。
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(null);
    prisma.adventureEpisodeVersion.findFirst.mockResolvedValue(null);
    prisma.adventureProgress.upsert.mockImplementation((args) =>
      Promise.resolve({ ...baseProgress, ...args.create }),
    );
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

  it("should resume the unanswered interaction after an explicit story request", async () => {
    prisma.adventureProgress.findFirst.mockResolvedValue({
      ...baseProgress,
      status: "exited",
      nextSegmentOrder: 3,
    });

    expect(await service.startToday("dev-uuid-1", false)).toBeNull();
    const resumed = await service.startToday("dev-uuid-1", true);
    expect(resumed.texts[0]).toBe(segments[2].text);
    expect(prisma.adventureProgress.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextSegmentOrder: 3,
          status: "awaiting_reply",
        }),
      }),
    );
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

    expect(reply.texts[0]).toBe(segments[2].text);
    expect(prisma.adventureDailyRecord.create).not.toHaveBeenCalled();
    expect(prisma.adventureEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dailyRecordId: "daily-1",
        eventType: "resumed",
      }),
    });
  });

  it("should resume the same exited episode on a later day without assigning a new story", async () => {
    const previouslyAssignedDaily = {
      ...baseDaily,
      assignedDate: "2026-10-29",
    };
    prisma.adventureDailyRecord.findFirst.mockImplementation((args) =>
      Promise.resolve(
        args.where.completedDate ? null : previouslyAssignedDaily,
      ),
    );
    prisma.adventureProgress.findUnique.mockResolvedValue({
      ...baseProgress,
      status: "exited",
      nextSegmentOrder: 3,
    });

    const reply = await service.startToday("dev-uuid-1", true);

    expect(reply.texts[0]).toBe(segments[2].text);
    expect(reply.texts).not.toContain(episode.recap);
    expect(prisma.adventureDailyRecord.create).not.toHaveBeenCalled();
    expect(prisma.adventureEpisode.findMany).not.toHaveBeenCalled();
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

  // ---------------------------------------------------------------------------
  // 内容版本固定（pinning）、retired 语义、故障重分配
  // ---------------------------------------------------------------------------

  const today = (() => {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${mm}-${dd}`;
  })();

  /** v1：孩子被分配时锁定的版本，内容与 segments 表原样一致 */
  const v1Payload = {
    title: episode.title,
    recap: "v1 的前情回顾。",
    segments: segments.map((segment) => ({ ...segment })),
  };

  /** admin 发布 v2 之后 segments 表的样子：只剩 2 段，交互点也被改掉 */
  const v2Segments = [
    {
      id: "n0",
      episodeId: "ep1",
      order: 0,
      kind: "narration",
      text: "新版第一段。",
    },
    {
      id: "n1",
      episodeId: "ep1",
      order: 1,
      kind: "narration",
      text: "新版第二段（全剧终）。",
    },
  ];

  const v1Row = {
    id: "v1",
    episodeId: "ep1",
    version: 1,
    status: "superseded",
    payload: v1Payload,
  };

  /** 让 isCompletedToday 返回 false，同时让 findCurrentDaily 返回指定行 */
  const stubDaily = (row: unknown) => {
    prisma.adventureDailyRecord.findFirst.mockImplementation((args) =>
      Promise.resolve(args?.where?.completedDate ? null : row),
    );
  };

  const ep2 = {
    ...episode,
    id: "ep2",
    episodeNumber: 2,
    title: "第二集",
    recap: "第二集的前情回顾。",
    published: true,
    retiredAt: null,
    currentVersionId: null,
  };

  describe("version pinning", () => {
    it("keeps playing the pinned version after the live content was replaced", async () => {
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(v1Row);
      prisma.adventureSegment.findMany.mockResolvedValue(v2Segments);
      prisma.adventureProgress.findFirst.mockResolvedValue({
        ...baseProgress,
        episodeVersionId: "v1",
        nextSegmentOrder: 3,
      });

      const reply = await service.startToday("dev-uuid-1");

      expect(reply.texts).toEqual([segments[3].text, segments[4].text]);
      expect(reply.action).toBe("await_reply");
      expect(reply.texts).not.toContain(v2Segments[0].text);
    });

    it("does not prematurely complete a pinned episode whose live table shrank", async () => {
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(v1Row);
      prisma.adventureSegment.findMany.mockResolvedValue(v2Segments);
      prisma.adventureProgress.findFirst.mockResolvedValue({
        ...baseProgress,
        episodeVersionId: "v1",
        nextSegmentOrder: 3,
      });

      const reply = await service.startToday("dev-uuid-1");

      // 未固定版本时 nextSegmentOrder(3) >= 表内段数(2) 会被误判完集
      expect(reply.action).not.toBe("completed");
      expect(prisma.adventureDailyRecord.update).not.toHaveBeenCalled();
    });

    it("still matches the pinned two_choice options after the live version became open_question", async () => {
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(v1Row);
      prisma.adventureSegment.findMany.mockResolvedValue(
        segments.map((segment) =>
          segment.order === 2
            ? { ...segment, interactionType: "open_question", options: null }
            : segment,
        ),
      );
      prisma.adventureProgress.findFirst.mockResolvedValue({
        ...baseProgress,
        episodeVersionId: "v1",
        status: "awaiting_reply",
        nextSegmentOrder: 3,
        waitingSince: new Date(),
      });

      const reply = await service.handleChildReply("dev-uuid-1", "森林");

      expect(reply.texts[0]).toBe("好呀，我们去森林！");
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it("uses the pinned version's fallback text on silence timeout", async () => {
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(v1Row);
      prisma.adventureSegment.findMany.mockResolvedValue(
        segments.map((segment) =>
          segment.order === 4
            ? { ...segment, fallbackText: "新版本的兜底话术。" }
            : segment,
        ),
      );
      prisma.adventureProgress.findFirst.mockResolvedValue({
        ...baseProgress,
        episodeVersionId: "v1",
        status: "awaiting_reply",
        nextSegmentOrder: 5,
        waitingSince: new Date(Date.now() - 60000),
      });

      const reply = await service.checkTimeout("dev-uuid-1");

      expect(reply.texts[0]).toBe(segments[4].fallbackText);
    });

    it("reads the segment table for legacy progress without a pinned version", async () => {
      prisma.adventureProgress.findFirst.mockResolvedValue({
        ...baseProgress,
        episodeVersionId: null,
        nextSegmentOrder: 3,
      });

      const reply = await service.startToday("dev-uuid-1");

      expect(reply.texts[0]).toBe(segments[3].text);
      expect(prisma.adventureEpisodeVersion.findUnique).not.toHaveBeenCalled();
    });

    it("falls back to the segment table when the pinned version row is gone", async () => {
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(null);
      prisma.adventureProgress.findFirst.mockResolvedValue({
        ...baseProgress,
        episodeVersionId: "ghost-version",
        nextSegmentOrder: 3,
      });

      const reply = await service.startToday("dev-uuid-1");

      expect(reply.texts[0]).toBe(segments[3].text);
    });

    it("pins the current version and takes the recap from the version payload on assignment", async () => {
      const published = {
        ...episode,
        recap: "episode 行上遗留的旧 recap",
        currentVersionId: "v2",
        retiredAt: null,
      };
      prisma.adventureEpisode.findMany.mockResolvedValue([published]);
      prisma.adventureProgress.findFirst.mockResolvedValue(null);
      prisma.adventureEpisodeVersion.findUnique.mockResolvedValue({
        id: "v2",
        episodeId: "ep1",
        version: 2,
        status: "published",
        payload: { ...v1Payload, recap: "v2 的前情回顾。" },
      });

      const reply = await service.startToday("dev-uuid-1");

      expect(reply.texts[0]).toBe("v2 的前情回顾。");
      expect(prisma.adventureProgress.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ episodeVersionId: "v2" }),
        }),
      );
    });
  });

  describe("retired episodes", () => {
    it("skips a retired episode and assigns the next published one", async () => {
      const retired = { ...episode, retiredAt: new Date() };
      prisma.adventureEpisode.findMany.mockResolvedValue([retired, ep2]);
      prisma.adventureProgress.findFirst.mockResolvedValue(null);
      prisma.adventureProgress.findMany.mockResolvedValue([]);

      await service.startToday("dev-uuid-1");

      expect(prisma.adventureDailyRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ episodeId: "ep2" }),
        }),
      );
    });

    it("still treats an unpublished episode as a hard boundary and never skips it", async () => {
      const draft = { ...episode, published: false, retiredAt: null };
      prisma.adventureEpisode.findMany.mockResolvedValue([draft, ep2]);
      prisma.adventureProgress.findFirst.mockResolvedValue(null);
      prisma.adventureProgress.findMany.mockResolvedValue([]);

      expect(await service.startToday("dev-uuid-1")).toBeNull();
      expect(prisma.adventureDailyRecord.create).not.toHaveBeenCalled();
    });

    it("does not resume an abandoned progress and falls through to selection", async () => {
      stubDaily({ ...baseDaily, status: "in_progress" });
      prisma.adventureProgress.findUnique.mockResolvedValue({
        ...baseProgress,
        status: "abandoned",
      });
      prisma.adventureProgress.findFirst.mockResolvedValue(null);
      prisma.adventureEpisode.findMany.mockResolvedValue([
        { ...episode, retiredAt: new Date() },
        ep2,
      ]);
      prisma.adventureProgress.findMany.mockResolvedValue([
        { episodeId: "ep1", status: "abandoned" },
      ]);

      await service.startToday("dev-uuid-1");

      expect(prisma.adventureDailyRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ episodeId: "ep2" }),
        }),
      );
    });

    it("keeps a failed_over episode retryable while excluding completed and abandoned ones", async () => {
      const ep3 = { ...ep2, id: "ep3", episodeNumber: 3 };
      prisma.adventureEpisode.findMany.mockResolvedValue([episode, ep2, ep3]);
      prisma.adventureProgress.findFirst.mockResolvedValue(null);
      prisma.adventureProgress.findMany.mockResolvedValue([
        { episodeId: "ep1", status: "completed" },
        { episodeId: "ep2", status: "failed_over" },
      ]);
      stubDaily(null);

      await service.startToday("dev-uuid-1");

      expect(prisma.adventureDailyRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ episodeId: "ep2" }),
        }),
      );
    });

    it("resets an existing failed_over progress instead of violating the unique constraint", async () => {
      prisma.adventureEpisode.findMany.mockResolvedValue([episode, ep2]);
      prisma.adventureProgress.findFirst.mockResolvedValue(null);
      prisma.adventureProgress.findMany.mockResolvedValue([
        { episodeId: "ep1", status: "completed" },
      ]);
      prisma.adventureProgress.findUnique.mockResolvedValue({
        ...baseProgress,
        id: "prog-stale",
        episodeId: "ep2",
        status: "failed_over",
        nextSegmentOrder: 4,
        stars: 3,
      });
      stubDaily(null);

      await service.startToday("dev-uuid-1");

      expect(prisma.adventureProgress.create).not.toHaveBeenCalled();
      expect(prisma.adventureProgress.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "prog-stale" },
          data: expect.objectContaining({
            status: "in_progress",
            nextSegmentOrder: 0,
            stars: 0,
            offTopicCount: 0,
          }),
        }),
      );
    });
  });

  describe("recoverToNextEpisode", () => {
    const brokenEp1 = { ...episode, id: "ep1" };

    beforeEach(() => {
      prisma.adventureEpisode.findMany.mockResolvedValue([brokenEp1, ep2]);
      prisma.adventureProgress.findMany.mockResolvedValue([]);
      prisma.adventureSegment.findMany.mockResolvedValue(segments);
      prisma.adventureEvent.create.mockClear();
      prisma.adventureDailyRecord.create.mockClear();
      prisma.adventureDailyRecord.update.mockClear();
    });

    it("moves the child to the next episode within the same day", async () => {
      stubDaily({ ...baseDaily, assignedDate: today, episodeId: "ep1" });
      prisma.adventureProgress.findUnique.mockResolvedValue({
        ...baseProgress,
        episodeId: "ep1",
        status: "in_progress",
        nextSegmentOrder: 3,
      });

      const reply = await service.recoverToNextEpisode(
        "dev-uuid-1",
        "payload_corrupt",
      );

      expect(reply.texts[0]).toBe(ep2.recap);
      expect(prisma.adventureProgress.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "failed_over" }),
        }),
      );
      // 当日 daily 行复用（受 @@unique([deviceId, assignedDate]) 约束，不能再 create）
      expect(prisma.adventureDailyRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "daily-1" },
          data: expect.objectContaining({
            episodeId: "ep2",
            status: "in_progress",
          }),
        }),
      );
      expect(prisma.adventureDailyRecord.create).not.toHaveBeenCalled();
    });

    it("records an auditable event for the reassignment", async () => {
      stubDaily({ ...baseDaily, assignedDate: today, episodeId: "ep1" });
      prisma.adventureProgress.findUnique.mockResolvedValue({
        ...baseProgress,
        episodeId: "ep1",
        status: "in_progress",
      });

      await service.recoverToNextEpisode("dev-uuid-1", "payload_corrupt");

      expect(prisma.adventureEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: "reassigned_after_failure",
            payload: expect.objectContaining({ reason: "payload_corrupt" }),
          }),
        }),
      );
    });

    it("does nothing when today's episode is already completed", async () => {
      prisma.adventureDailyRecord.findFirst.mockImplementation((args) =>
        Promise.resolve(
          args?.where?.completedDate
            ? { ...baseDaily, status: "completed", completedDate: today }
            : null,
        ),
      );

      expect(
        await service.recoverToNextEpisode("dev-uuid-1", "payload_corrupt"),
      ).toBeNull();
      expect(prisma.adventureDailyRecord.update).not.toHaveBeenCalled();
      expect(prisma.adventureDailyRecord.create).not.toHaveBeenCalled();
    });

    it("closes a stale cross-day daily and assigns a fresh one for today", async () => {
      stubDaily({ ...baseDaily, assignedDate: "2026-10-29", episodeId: "ep1" });
      prisma.adventureProgress.findUnique.mockResolvedValue({
        ...baseProgress,
        episodeId: "ep1",
        status: "in_progress",
        nextSegmentOrder: 3,
      });
      prisma.adventureDailyRecord.create.mockImplementation((args) =>
        Promise.resolve({ ...baseDaily, ...args.data }),
      );

      const reply = await service.recoverToNextEpisode(
        "dev-uuid-1",
        "stale_broken",
      );

      expect(prisma.adventureDailyRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "daily-1" },
          data: expect.objectContaining({ status: "failed_over" }),
        }),
      );
      expect(prisma.adventureDailyRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            episodeId: "ep2",
            assignedDate: today,
            status: "in_progress",
          }),
        }),
      );
      expect(reply.texts[0]).toBe(ep2.recap);
    });

    it("returns null instead of throwing when no next episode is available", async () => {
      prisma.adventureEpisode.findMany.mockResolvedValue([brokenEp1]);
      stubDaily({ ...baseDaily, assignedDate: today, episodeId: "ep1" });
      prisma.adventureProgress.findUnique.mockResolvedValue({
        ...baseProgress,
        episodeId: "ep1",
        status: "in_progress",
      });

      expect(
        await service.recoverToNextEpisode("dev-uuid-1", "payload_corrupt"),
      ).toBeNull();
      expect(prisma.adventureDailyRecord.create).not.toHaveBeenCalled();
    });

    it("returns null when there is no adventure in flight", async () => {
      stubDaily(null);
      prisma.adventureProgress.findUnique.mockResolvedValue(null);

      expect(
        await service.recoverToNextEpisode("dev-uuid-1", "payload_corrupt"),
      ).toBeNull();
    });
  });

  describe("defensive guards", () => {
    it("ignores a non-interaction segment when locating the awaited interaction point", async () => {
      prisma.adventureSegment.findMany.mockResolvedValue(
        segments.map((segment) =>
          segment.order === 2
            ? { ...segment, kind: "narration", interactionType: null }
            : segment,
        ),
      );
      prisma.adventureProgress.findFirst.mockResolvedValue({
        ...baseProgress,
        status: "awaiting_reply",
        nextSegmentOrder: 3,
        waitingSince: new Date(),
      });

      expect(await service.handleChildReply("dev-uuid-1", "森林")).toBeNull();
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it("keeps recovering other devices when one device's timeout handling throws", async () => {
      prisma.adventureProgress.findMany.mockResolvedValue([
        { deviceId: "dev-bad" },
        { deviceId: "dev-uuid-1" },
      ]);
      prisma.adventureDailyRecord.findFirst.mockImplementation((args) => {
        if (args?.where?.deviceId === "dev-bad") {
          return Promise.reject(new Error("db exploded"));
        }
        return Promise.resolve(args?.where?.completedDate ? null : baseDaily);
      });
      prisma.adventureProgress.findUnique.mockImplementation((args) =>
        Promise.resolve(
          args.where.deviceId_episodeId.deviceId === "dev-uuid-1"
            ? {
                ...baseProgress,
                status: "awaiting_reply",
                nextSegmentOrder: 3,
                waitingSince: new Date(Date.now() - 60000),
              }
            : null,
        ),
      );

      const recovered = await service.sweepTimeouts();

      expect(recovered.map((item) => item.deviceId)).toContain("dev-uuid-1");
    });
  });

  /**
   * L2 兜底：引擎自己抛错时，绝不让异常冒到对话入口（那等于孩子听到沉默），
   * 而是先把当日这一集换成下一集；换不动就返回 null，让上层继续降级到
   * 自由创作与 L0 话术。「今天已经完成过一集则不换」由 recoverToNextEpisode
   * 的既有门禁保证——每日额度是硬约束，兜底不得绕过它。
   */
  describe("引擎异常兜底", () => {
    type PrivateEngine = {
      startTodayInternal: (
        deviceId: string,
        explicit?: boolean,
      ) => Promise<unknown>;
      handleChildReplyInternal: (
        deviceId: string,
        asrText: string,
      ) => Promise<unknown>;
      checkTimeoutInternal: (deviceId: string) => Promise<unknown>;
    };

    beforeEach(() => {
      prisma.adventureEpisode.findMany.mockResolvedValue([
        { ...episode, id: "ep1" },
        ep2,
      ]);
      prisma.adventureProgress.findMany.mockResolvedValue([]);
      prisma.adventureSegment.findMany.mockResolvedValue(segments);
      prisma.adventureEvent.create.mockClear();
      stubDaily({ ...baseDaily, assignedDate: today, episodeId: "ep1" });
      prisma.adventureProgress.findUnique.mockResolvedValue({
        ...baseProgress,
        episodeId: "ep1",
        status: "in_progress",
        nextSegmentOrder: 3,
      });
    });

    const failInternals = (reason = "boom") => {
      const internals = service as unknown as PrivateEngine;
      jest
        .spyOn(internals, "startTodayInternal")
        .mockRejectedValue(new Error(reason));
      jest
        .spyOn(internals, "handleChildReplyInternal")
        .mockRejectedValue(new Error(reason));
      jest
        .spyOn(internals, "checkTimeoutInternal")
        .mockRejectedValue(new Error(reason));
    };

    it("startToday 内部抛错时平移到下一集，而不是把异常抛给对话入口", async () => {
      failInternals();

      const reply = await service.startToday("dev-uuid-1", true);

      expect(reply).not.toBeNull();
      expect(reply.texts[0]).toBe(ep2.recap);
      expect(prisma.adventureProgress.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "failed_over" }),
        }),
      );
    });

    it("handleChildReply 内部抛错时同样平移到下一集", async () => {
      failInternals();

      const reply = await service.handleChildReply("dev-uuid-1", "森林");

      expect(reply).not.toBeNull();
      expect(reply.texts[0]).toBe(ep2.recap);
    });

    it("checkTimeout 内部抛错时同样平移到下一集", async () => {
      failInternals();

      const reply = await service.checkTimeout("dev-uuid-1");

      expect(reply).not.toBeNull();
      expect(reply.texts[0]).toBe(ep2.recap);
    });

    it("连换集都失败时返回 null，绝不向上抛（上层继续降级到自由创作/L0）", async () => {
      failInternals();
      jest
        .spyOn(service, "recoverToNextEpisode")
        .mockRejectedValue(new Error("db down"));

      expect(await service.startToday("dev-uuid-1", true)).toBeNull();
      expect(await service.handleChildReply("dev-uuid-1", "森林")).toBeNull();
      expect(await service.checkTimeout("dev-uuid-1")).toBeNull();
    });

    it("今天已经完成过一集时不做平移：每日额度是硬门禁，兜底不得绕过", async () => {
      failInternals();
      prisma.adventureDailyRecord.findFirst.mockImplementation((args) =>
        Promise.resolve(
          args?.where?.completedDate
            ? {
                ...baseDaily,
                status: "completed",
                completedDate: args.where.completedDate,
              }
            : null,
        ),
      );

      expect(await service.startToday("dev-uuid-1", true)).toBeNull();
      expect(prisma.adventureProgress.update).not.toHaveBeenCalled();
    });

    it("没有下一集可接管时返回 null，不抛错", async () => {
      failInternals();
      prisma.adventureEpisode.findMany.mockResolvedValue([
        { ...episode, id: "ep1" },
      ]);

      expect(await service.startToday("dev-uuid-1", true)).toBeNull();
    });

    it("抛错时向失败监听器上报 phase / reason / recovered", async () => {
      failInternals("payload exploded");
      const reports: unknown[] = [];
      service.registerFailureListener((report) => {
        reports.push(report);
      });

      await service.startToday("dev-uuid-1", true);
      await service.handleChildReply("dev-uuid-1", "森林");

      expect(reports).toHaveLength(2);
      expect(reports[0]).toMatchObject({
        deviceInternalId: "dev-uuid-1",
        phase: "start_today",
        recovered: true,
      });
      expect((reports[0] as { reason: string }).reason).toContain(
        "payload exploded",
      );
      expect((reports[0] as { at: string }).at).toBeTruthy();
      expect(reports[1]).toMatchObject({
        phase: "handle_reply",
        recovered: true,
      });
    });

    it("换集失败时上报 recovered=false，让后台知道这台设备已经降到最后一级", async () => {
      failInternals();
      jest
        .spyOn(service, "recoverToNextEpisode")
        .mockRejectedValue(new Error("db down"));
      const reports: Array<{ recovered: boolean; phase: string }> = [];
      service.registerFailureListener((report) => {
        reports.push(report);
      });

      await service.checkTimeout("dev-uuid-1");

      expect(reports).toEqual([
        expect.objectContaining({ phase: "check_timeout", recovered: false }),
      ]);
    });

    it("监听器自己抛错不影响兜底结果（上报是尽力而为）", async () => {
      failInternals();
      service.registerFailureListener(() => {
        throw new Error("listener down");
      });

      const reply = await service.startToday("dev-uuid-1", true);

      expect(reply).not.toBeNull();
      expect(reply.texts[0]).toBe(ep2.recap);
    });

    it("未注册监听器时兜底照常工作", async () => {
      failInternals();

      const reply = await service.startToday("dev-uuid-1", true);

      expect(reply.texts[0]).toBe(ep2.recap);
    });
  });

  /**
   * @@unique([deviceId, assignedDate]) 决定了一个设备一天只能有一行 daily。
   * 既有实现无条件 create，于是只要当天已经存在一行**非 completed** 的 daily
   * （进度被 retired/abandoned 收走、被 failed_over 收走、或进度行丢失），
   * 下一次 startToday 就撞唯一约束抛错——孩子从此再也进不去冒险，
   * 而且这是永久性的：那行 daily 不会自己消失。这里验复用而非新建。
   */
  describe("当日 daily 行复用", () => {
    beforeEach(() => {
      prisma.adventureEpisode.findMany.mockResolvedValue([
        { ...episode, id: "ep1" },
        ep2,
      ]);
      prisma.adventureProgress.findMany.mockResolvedValue([
        { episodeId: "ep1", status: "abandoned" },
      ]);
      prisma.adventureProgress.findFirst.mockResolvedValue(null);
      prisma.adventureSegment.findMany.mockResolvedValue(segments);
      prisma.adventureEvent.create.mockClear();
      prisma.adventureDailyRecord.create.mockClear();
      prisma.adventureDailyRecord.update.mockClear();
      // findCurrentDaily（status=in_progress）查不到行，才会走到开新集分支
      stubDaily(null);
    });

    it("当天已有被收走的 daily 行时复用改指下一集，而不是撞唯一约束", async () => {
      prisma.adventureDailyRecord.findUnique.mockResolvedValue({
        ...baseDaily,
        id: "daily-today",
        assignedDate: today,
        episodeId: "ep1",
        status: "abandoned",
      });

      const reply = await service.startToday("dev-uuid-1", true);

      expect(prisma.adventureDailyRecord.create).not.toHaveBeenCalled();
      expect(prisma.adventureDailyRecord.update).toHaveBeenCalledWith({
        where: { id: "daily-today" },
        data: { episodeId: "ep2", status: "in_progress" },
      });
      expect(reply.texts[0]).toBe(ep2.recap);
    });

    it("当天没有 daily 行时照常新建（既有行为不回归）", async () => {
      prisma.adventureDailyRecord.findUnique.mockResolvedValue(null);
      prisma.adventureDailyRecord.create.mockImplementation((args) =>
        Promise.resolve({ ...baseDaily, ...args.data }),
      );

      await service.startToday("dev-uuid-1", true);

      expect(prisma.adventureDailyRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deviceId: "dev-uuid-1",
            episodeId: "ep2",
            assignedDate: today,
            status: "in_progress",
          }),
        }),
      );
      expect(prisma.adventureDailyRecord.update).not.toHaveBeenCalled();
    });

    it("当天 daily 行已是 completed 时不覆盖：宁可不写，也不抹掉孩子的完集记录", async () => {
      prisma.adventureDailyRecord.findUnique.mockResolvedValue({
        ...baseDaily,
        id: "daily-today",
        assignedDate: today,
        episodeId: "ep1",
        status: "completed",
        completedDate: today,
      });

      await service.startToday("dev-uuid-1", true);

      expect(prisma.adventureDailyRecord.update).not.toHaveBeenCalled();
      expect(prisma.adventureDailyRecord.create).not.toHaveBeenCalled();
    });
  });
});
