import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import { AdventureService } from "./adventure.service";
import { ADVENTURE_EXIT_TEXT } from "./adventure.constants";

/**
 * 以「孩子游玩时的产品预期」为基准的交互契约测试。
 *
 * 与 adventure.service.spec.ts 的区别：这里不 mock 内部细节、不按代码路径逐条对齐，
 * 只断言孩子在这个产品里应该体验到的行为。目的是让函数按产品需求满足游玩体验，
 * 所以宁可用「反例」钉死那些容易被实现悄悄破坏的契约。
 */
describe("AdventureService · 游玩交互契约", () => {
  let service: AdventureService;
  let prisma: {
    device: { findUnique: jest.Mock };
    adventureEpisode: { findMany: jest.Mock };
    adventureSegment: { findMany: jest.Mock };
    adventureEpisodeVersion: { findUnique: jest.Mock };
    adventureDailyRecord: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    adventureProgress: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    adventureEvent: { create: jest.Mock; upsert: jest.Mock };
  };
  let llm: { complete: jest.Mock };

  const episode = {
    id: "ep1",
    characterKey: "elly",
    season: 1,
    episodeNumber: 1,
    title: "听风原野第一天",
    recap: "前情回顾。",
    published: true,
  };

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
    episodeVersionId: null,
  };

  const baseDaily = {
    id: "daily-1",
    deviceId: "dev-uuid-1",
    episodeId: "ep1",
    assignedDate: "2026-10-29",
    status: "in_progress",
    assignedAt: new Date("2026-10-29T08:00:00Z"),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdventureService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: jest.fn((callback: (tx: unknown) => unknown) =>
              callback(prisma),
            ),
            device: { findUnique: jest.fn() },
            adventureEpisode: { findMany: jest.fn() },
            adventureSegment: { findMany: jest.fn() },
            adventureEpisodeVersion: { findUnique: jest.fn() },
            adventureDailyRecord: {
              findFirst: jest.fn(),
              findUnique: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
            adventureProgress: {
              findUnique: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
            adventureEvent: { create: jest.fn(), upsert: jest.fn() },
          },
        },
        {
          provide: LlmService,
          useValue: {
            complete: jest.fn(),
            buildAdventureInteractionPrompt: jest.fn(() => []),
            buildAdventureChoiceMatchPrompt: jest.fn(() => []),
            get smallModelName() {
              return "small-llm";
            },
          },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<AdventureService>(AdventureService);
    prisma = module.get(PrismaService);
    llm = module.get(LlmService);

    prisma.device.findUnique.mockResolvedValue({ characterKey: "elly" });
    prisma.adventureEpisode.findMany.mockResolvedValue([episode]);
    prisma.adventureEpisodeVersion.findUnique.mockResolvedValue(null);
    prisma.adventureProgress.update.mockImplementation(
      (args: { where: { id: string }; data: Record<string, unknown> }) =>
        Promise.resolve({ ...baseProgress, ...args.data }),
    );
    prisma.adventureDailyRecord.update.mockImplementation(
      (args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...baseDaily, ...args.data }),
    );
    prisma.adventureDailyRecord.create.mockResolvedValue(baseDaily);
    prisma.adventureProgress.create.mockImplementation(
      (args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...baseProgress, ...args.data }),
    );
    prisma.adventureEvent.create.mockResolvedValue({});
    prisma.adventureEvent.upsert.mockResolvedValue({});
    llm.complete.mockResolvedValue({ text: "哇，你说得真有意思！" });

    // 默认：今天未完成，且没有飞行中的冒险。
    // findFirst 同时服务 isCompletedToday（status=completed）与 findCurrentDaily
    // （status=in_progress），必须按 where 区分，否则会把「未完成」误判成「已完成」。
    prisma.adventureDailyRecord.findFirst.mockImplementation(
      (args: { where?: { status?: string } } | undefined) => {
        if (args?.where?.status === "completed") {
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      },
    );
  });

  /** 让引擎认为当前有一个「停在指定状态」的飞行冒险。 */
  function mockInFlight(overrides: Partial<typeof baseProgress> = {}) {
    const progress = { ...baseProgress, ...overrides };
    prisma.adventureProgress.findUnique.mockResolvedValue(progress);
    prisma.adventureDailyRecord.findFirst.mockImplementation(
      (args: { where?: { status?: string } } | undefined) => {
        if (args?.where?.status === "completed") {
          return Promise.resolve(null);
        }
        return Promise.resolve({ ...baseDaily, episodeId: progress.episodeId });
      },
    );
    return progress;
  }

  /** 构造带 id/episodeId 的段落，并按传入 shape 设置 segments 表 mock。 */
  function mockSegments(
    shapes: Array<{
      order: number;
      kind: string;
      text: string;
      interactionType?: string;
      options?: unknown;
      fallbackText?: string | null;
      rewardStar?: boolean;
      exitText?: string;
    }>,
  ) {
    const segments = shapes.map((s, i) => ({
      id: `seg-${i}`,
      episodeId: "ep1",
      ...s,
    }));
    prisma.adventureSegment.findMany.mockResolvedValue(segments);
    return segments;
  }

  /** 提取 progress.update 落库过的 stars 值序列。 */
  function starUpdates() {
    return prisma.adventureProgress.update.mock.calls
      .map((c) => (c[0] as { data?: { stars?: number } })?.data?.stars)
      .filter((v): v is number => v !== undefined);
  }

  describe("退出话术：任何互动环节、打断旁白，都念同一句", () => {
    const fullSegments = () =>
      mockSegments([
        { order: 0, kind: "narration", text: "今天 Elly 要出门啦。" },
        {
          order: 1,
          kind: "interaction",
          interactionType: "two_choice",
          text: "我们去森林还是去河边？",
          options: {
            choices: [
              { key: "forest", text: "森林", reply: "好呀，我们去森林！" },
              { key: "river", text: "河边", reply: "走，我们去河边！" },
            ],
          },
          fallbackText: "没关系，那我替你选森林吧！",
          rewardStar: true,
          // 历史数据残留的逐段退出话术——引擎应当无视
          exitText: "好呀，那我们明天接着玩。",
        },
        {
          order: 2,
          kind: "interaction",
          interactionType: "repeat_after_me",
          text: "跟我念：银色的铃铛。",
          options: { praise: "说得真好！" },
          fallbackText: null,
          rewardStar: true,
        },
        {
          order: 3,
          kind: "interaction",
          interactionType: "open_question",
          text: "你觉得小松鼠会说什么呢？",
          options: null,
          fallbackText: "没关系，我们一起接着看。",
          rewardStar: true,
        },
      ]);

    it("在二选一等待时退出，念全局那句，且无视段上残留的 exitText", async () => {
      fullSegments();
      mockInFlight({ status: "awaiting_reply", nextSegmentOrder: 2 });

      const reply = await service.handleChildReply("dev-uuid-1", "退出");

      expect(reply?.texts).toEqual([ADVENTURE_EXIT_TEXT]);
      expect(reply?.texts[0]).not.toContain("明天接着玩");
      expect(reply?.action).toBe("exit");
    });

    it("在开放提问等待时退出，同样是全局那句", async () => {
      fullSegments();
      mockInFlight({ status: "awaiting_reply", nextSegmentOrder: 4 });

      const reply = await service.handleChildReply("dev-uuid-1", "不想玩了");

      expect(reply?.texts).toEqual([ADVENTURE_EXIT_TEXT]);
    });

    it("在跟读等待时退出，同样是全局那句", async () => {
      fullSegments();
      mockInFlight({ status: "awaiting_reply", nextSegmentOrder: 3 });

      const reply = await service.handleChildReply("dev-uuid-1", "别讲了");

      expect(reply?.texts).toEqual([ADVENTURE_EXIT_TEXT]);
    });

    it("打断旁白（还没到互动点）退出，同样是全局那句，并落 exited", async () => {
      fullSegments();
      mockInFlight({ status: "in_progress", nextSegmentOrder: 0 });

      const reply = await service.handleChildReply("dev-uuid-1", "不要听了");

      expect(reply?.texts).toEqual([ADVENTURE_EXIT_TEXT]);
      expect(prisma.adventureProgress.update).toHaveBeenCalledWith({
        where: { id: "prog1" },
        data: { status: "exited", waitingSince: null },
      });
    });

    it("英语关键词 exit 也能退出，大小写不敏感", async () => {
      fullSegments();
      mockInFlight({ status: "awaiting_reply", nextSegmentOrder: 2 });

      const reply = await service.handleChildReply("dev-uuid-1", "EXIT");

      expect(reply?.texts).toEqual([ADVENTURE_EXIT_TEXT]);
    });
  });

  describe("发星契约：只有 reward 段与二选一命中发星，其余交互挂 rewardStar 也不发", () => {
    it("奖励段发一颗星，播完即继续，不等孩子回答", async () => {
      mockSegments([
        { order: 0, kind: "narration", text: "开场。" },
        {
          order: 1,
          kind: "interaction",
          interactionType: "reward",
          text: "你做到了！",
          rewardStar: true,
        },
        { order: 2, kind: "narration", text: "结尾。" },
      ]);
      mockInFlight({ status: "in_progress", nextSegmentOrder: 1, stars: 0 });

      const reply = await service.startToday("dev-uuid-1");

      expect(reply?.action).toBe("completed");
      expect(starUpdates()).toContain(1);
    });

    it("二选一确定性命中且 rewardStar=true，发一颗星", async () => {
      mockSegments([
        {
          order: 0,
          kind: "interaction",
          interactionType: "two_choice",
          text: "森林还是河边？",
          options: {
            choices: [
              { key: "forest", text: "森林", reply: "去森林！" },
              { key: "river", text: "河边", reply: "去河边！" },
            ],
          },
          fallbackText: "没关系。",
          rewardStar: true,
        },
        { order: 1, kind: "narration", text: "结尾。" },
      ]);
      mockInFlight({ status: "awaiting_reply", nextSegmentOrder: 1, stars: 0 });

      const reply = await service.handleChildReply("dev-uuid-1", "去森林");

      expect(reply?.matchedChoice).toMatchObject({ index: 0, key: "forest" });
      expect(starUpdates()).toContain(1);
    });

    it("开放提问挂 rewardStar=true，孩子回答后也不发星", async () => {
      mockSegments([
        {
          order: 0,
          kind: "interaction",
          interactionType: "open_question",
          text: "你觉得呢？",
          options: null,
          fallbackText: "没关系。",
          rewardStar: true,
        },
        { order: 1, kind: "narration", text: "结尾。" },
      ]);
      mockInFlight({ status: "awaiting_reply", nextSegmentOrder: 1, stars: 0 });

      await service.handleChildReply("dev-uuid-1", "它说谢谢");

      expect(starUpdates()).not.toContain(1);
    });

    it("跟读挂 rewardStar=true，孩子跟读后也不发星", async () => {
      mockSegments([
        {
          order: 0,
          kind: "interaction",
          interactionType: "repeat_after_me",
          text: "跟我念。",
          options: { praise: "真棒！" },
          fallbackText: null,
          rewardStar: true,
        },
        { order: 1, kind: "narration", text: "结尾。" },
      ]);
      mockInFlight({ status: "awaiting_reply", nextSegmentOrder: 1, stars: 0 });

      await service.handleChildReply("dev-uuid-1", "跟我念");

      expect(starUpdates()).not.toContain(1);
    });
  });

  describe("跟读：以鼓励为主，不苛求精确复读", () => {
    it("读到内容作者的 praise 并推进主线，result=answered，不调 LLM", async () => {
      mockSegments([
        {
          order: 0,
          kind: "interaction",
          interactionType: "repeat_after_me",
          text: "跟我念：银色的铃铛。",
          options: { praise: "说得真好！" },
          fallbackText: null,
          rewardStar: false,
        },
        { order: 1, kind: "narration", text: "结尾。" },
      ]);
      mockInFlight({ status: "awaiting_reply", nextSegmentOrder: 1, stars: 0 });

      const reply = await service.handleChildReply("dev-uuid-1", "银色的铃铛");

      expect(reply?.texts[0]).toBe("说得真好！");
      expect(reply?.result).toBe("answered");
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it("段落没有 praise 时兜底默认鼓励话术，不崩", async () => {
      mockSegments([
        {
          order: 0,
          kind: "interaction",
          interactionType: "repeat_after_me",
          text: "跟我念。",
          options: null,
          fallbackText: null,
          rewardStar: false,
        },
        { order: 1, kind: "narration", text: "结尾。" },
      ]);
      mockInFlight({ status: "awaiting_reply", nextSegmentOrder: 1, stars: 0 });

      const reply = await service.handleChildReply("dev-uuid-1", "跟我念");

      expect(reply?.texts[0]).toBe("说得真好！给你鼓掌！");
      expect(reply?.result).toBe("answered");
    });

    it("复读漏了词也算成功（「我会每天早晚刷牙」复读为「我会每天刷牙」）", async () => {
      mockSegments([
        {
          order: 0,
          kind: "interaction",
          interactionType: "repeat_after_me",
          text: "跟我念：我会每天早晚刷牙。",
          options: { praise: "真棒！" },
          fallbackText: null,
          rewardStar: false,
        },
        { order: 1, kind: "narration", text: "结尾。" },
      ]);
      mockInFlight({ status: "awaiting_reply", nextSegmentOrder: 1, stars: 0 });

      const reply = await service.handleChildReply(
        "dev-uuid-1",
        "我会每天刷牙",
      );

      expect(reply?.texts[0]).toBe("真棒！");
      expect(reply?.result).toBe("answered");
      expect(reply?.action).not.toBe("exit");
    });
  });
});
