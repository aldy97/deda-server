import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import { AdventureService } from "./adventure.service";

/**
 * 冒险故事游玩的集成测试（service 级、内存 mock、不出网）。
 *
 * 模拟的是「假机芯厂云上行 ASR + 真实 AdventureService 状态机」，不测 WS 上传编排。
 * 与 adventure.service.spec.ts 的根本区别：这里用一个有状态的内存库，让
 * progress / daily 的行状态在连续多轮之间真实演进——孩子从开集一路玩到完集，
 * 每一步都依赖上一步落库的结果。这正是单轮静态 mock 测不到的「多轮状态演进」。
 */
describe("AdventureService · 游玩会话（integration）", () => {
  let service: AdventureService;
  let llm: { complete: jest.Mock };
  let segmentFindMany: jest.Mock;
  let state: {
    progress: Record<string, unknown> | null;
    daily: Record<string, unknown> | null;
    events: Array<Record<string, unknown>>;
  };

  const deviceId = "dev-uuid-1";
  const episode = {
    id: "ep1",
    characterKey: "elly",
    season: 1,
    episodeNumber: 1,
    title: "听风原野第一天",
    recap: "前情回顾：Elly 住在听风原野。",
    published: true,
  };

  /** 一集完整游玩内容：旁白 → 二选一(带星) → 旁白 → 开放提问 → 跟读 → 奖励段 → 结尾。 */
  function fullSegments() {
    return [
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
      },
      {
        id: "s2",
        episodeId: "ep1",
        order: 2,
        kind: "narration",
        text: "森林里有一只小松鼠。",
      },
      {
        id: "s3",
        episodeId: "ep1",
        order: 3,
        kind: "interaction",
        interactionType: "open_question",
        text: "你觉得小松鼠会对 Elly 说什么呢？",
        options: null,
        fallbackText: "没关系，我们一起接着看。",
        rewardStar: true,
      },
      {
        id: "s4",
        episodeId: "ep1",
        order: 4,
        kind: "interaction",
        interactionType: "repeat_after_me",
        text: "跟我念：我会每天早晚刷牙。",
        options: { praise: "真棒！" },
        fallbackText: null,
        rewardStar: true,
      },
      {
        id: "s5",
        episodeId: "ep1",
        order: 5,
        kind: "interaction",
        interactionType: "reward",
        text: "你帮 Elly 找到了铃铛，真了不起！",
        options: null,
        fallbackText: null,
        rewardStar: true,
      },
      {
        id: "s6",
        episodeId: "ep1",
        order: 6,
        kind: "narration",
        text: "Elly 开开心心地回家了。",
      },
    ];
  }

  beforeEach(async () => {
    state = { progress: null, daily: null, events: [] };
    segmentFindMany = jest.fn(async () => fullSegments());

    const prisma = {
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
      device: {
        findUnique: jest.fn(async () => ({
          id: deviceId,
          characterKey: "elly",
        })),
      },
      adventureEpisode: { findMany: jest.fn(async () => [episode]) },
      adventureSegment: { findMany: segmentFindMany },
      adventureEpisodeVersion: { findUnique: jest.fn(async () => null) },
      adventureDailyRecord: {
        findFirst: jest.fn(
          async (args: { where?: Record<string, unknown> }) => {
            const status = args?.where?.status;
            if (status === "completed") {
              return state.daily && state.daily.status === "completed"
                ? state.daily
                : null;
            }
            if (status === "in_progress") {
              return state.daily && state.daily.status === "in_progress"
                ? state.daily
                : null;
            }
            return state.daily ?? null;
          },
        ),
        findUnique: jest.fn(async () => state.daily),
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          state.daily = {
            id: "daily-1",
            deviceId,
            assignedAt: new Date(),
            completedAt: null,
            completedDate: null,
            ...args.data,
          };
          return state.daily;
        }),
        update: jest.fn(async (args: { data: Record<string, unknown> }) => {
          state.daily = { ...state.daily, ...args.data };
          return state.daily;
        }),
      },
      adventureProgress: {
        findUnique: jest.fn(async () => state.progress),
        findMany: jest.fn(async () => []),
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          state.progress = {
            id: "prog-1",
            deviceId,
            nextSegmentOrder: 0,
            stars: 0,
            offTopicCount: 0,
            waitingSince: null,
            completedAt: null,
            ...args.data,
          };
          return state.progress;
        }),
        update: jest.fn(async (args: { data: Record<string, unknown> }) => {
          state.progress = { ...state.progress, ...args.data };
          return state.progress;
        }),
      },
      adventureEvent: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          state.events.push(args.data);
          return args.data;
        }),
        upsert: jest.fn(async (args: { create: Record<string, unknown> }) => {
          state.events.push(args.create);
          return args.create;
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdventureService,
        { provide: PrismaService, useValue: prisma },
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
    llm = module.get(LlmService);
    llm.complete.mockResolvedValue({ text: "哇，你观察得真仔细！" });
  });

  function eventTypes() {
    return state.events.map((e) => e.eventType);
  }

  it("孩子从开集一路玩到完集：四种原语走通、发星累计、完集落库", async () => {
    // 1. 开集：播 recap + 第一段旁白 + 二选一引导词，停在二选一
    const start = await service.startToday(deviceId);
    expect(start?.action).toBe("await_reply");
    expect(start?.texts).toEqual([
      "前情回顾：Elly 住在听风原野。",
      "今天 Elly 要出门啦。",
      "我们去森林还是去河边？",
    ]);

    // 2. 引导词播完 ack，进入 10s 回答窗口
    await service.markPromptPlaybackComplete(deviceId);
    expect(state.progress?.status).toBe("awaiting_reply");
    expect(state.progress?.waitingSince).toBeInstanceOf(Date);

    // 3. 孩子答二选一：命中「森林」，播 reply + 发一颗星 + 推进到开放提问
    const choice = await service.handleChildReply(deviceId, "去森林");
    expect(choice?.result).toBe("answered");
    expect(choice?.matchedChoice).toMatchObject({
      index: 0,
      source: "deterministic",
      key: "forest",
    });
    expect(choice?.texts).toEqual([
      "好呀，我们去森林！",
      "森林里有一只小松鼠。",
      "你觉得小松鼠会对 Elly 说什么呢？",
    ]);

    // 4. 孩子答开放提问：小模型接话 + 推进到跟读
    const open = await service.handleChildReply(deviceId, "它说谢谢你帮它");
    expect(open?.result).toBe("answered");
    expect(open?.texts).toEqual([
      "哇，你观察得真仔细！",
      "跟我念：我会每天早晚刷牙。",
    ]);
    expect(open?.action).toBe("await_reply");

    // 5. 孩子跟读漏了一个词，也算成功：播 praise + 推进到奖励段 + 完集
    const repeat = await service.handleChildReply(deviceId, "我会每天刷牙");
    expect(repeat?.result).toBe("answered");
    expect(repeat?.action).toBe("completed");
    expect(repeat?.texts).toEqual([
      "真棒！",
      "你帮 Elly 找到了铃铛，真了不起！",
      "Elly 开开心心地回家了。",
    ]);

    // 6. 完集落库：星星累计 = 二选一命中 1 颗 + 奖励段 1 颗 = 2 颗
    expect(state.progress?.status).toBe("completed");
    expect(state.progress?.stars).toBe(2);
    expect(state.daily?.status).toBe("completed");
    expect(eventTypes()).toContain("completed");
  });

  it("跟读说完全无关的话也算成功，照常鼓励推进", async () => {
    await service.startToday(deviceId);
    await service.handleChildReply(deviceId, "去森林");
    await service.handleChildReply(deviceId, "它说谢谢你");

    const reply = await service.handleChildReply(deviceId, "我想出去玩");

    expect(reply?.result).toBe("answered");
    expect(reply?.texts[0]).toBe("真棒！");
  });

  it("跑题每个互动点独立给两次机会，跨点不累计", async () => {
    segmentFindMany.mockResolvedValue([
      {
        id: "a0",
        episodeId: "ep1",
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
        fallbackText: "没关系，去森林吧。",
        rewardStar: false,
      },
      {
        id: "a1",
        episodeId: "ep1",
        order: 1,
        kind: "narration",
        text: "过场。",
      },
      {
        id: "a2",
        episodeId: "ep1",
        order: 2,
        kind: "interaction",
        interactionType: "two_choice",
        text: "唱歌还是讲故事？",
        options: {
          choices: [
            { key: "sing", text: "唱歌", reply: "唱歌！" },
            { key: "story", text: "讲故事", reply: "讲故事！" },
          ],
        },
        fallbackText: "没关系，唱歌吧。",
        rewardStar: false,
      },
      {
        id: "a3",
        episodeId: "ep1",
        order: 3,
        kind: "narration",
        text: "结尾。",
      },
    ]);

    await service.startToday(deviceId);

    // 第一个二选一：第一次跑题 → 引回，停在原处
    const off1 = await service.handleChildReply(deviceId, "我想吃糖");
    expect(off1?.result).toBe("off_topic");
    expect(off1?.action).toBe("await_reply");

    // 第一个二选一：第二次跑题 → 兜底推进到第二个二选一
    const fallback1 = await service.handleChildReply(deviceId, "还是不知道");
    expect(fallback1?.result).toBe("fallback");

    // 第二个二选一：第一次跑题 → 又是引回而不是兜底（offTopicCount 已跨点重置）
    const off2 = await service.handleChildReply(deviceId, "我还想吃糖");
    expect(off2?.result).toBe("off_topic");
    expect(off2?.action).toBe("await_reply");
  });

  it("退出后当日不自动续玩，明确请求后从未回答的交互点续玩", async () => {
    await service.startToday(deviceId);
    expect(state.progress?.nextSegmentOrder).toBe(2);

    const exit = await service.handleChildReply(deviceId, "不想玩了");
    expect(exit?.texts).toEqual(["好的，那么我们之后再一起继续冒险吧"]);
    expect(state.progress?.status).toBe("exited");

    // 不明确请求：不自动续玩
    expect(await service.startToday(deviceId)).toBeNull();

    // 明确请求：退回未回答的二选一，重新念引导词
    const resume = await service.startToday(deviceId, true);
    expect(resume?.action).toBe("await_reply");
    expect(resume?.texts).toEqual(["我们去森林还是去河边？"]);
  });

  it("10s 沉默超时后，用当前交互点的兜底话术推进", async () => {
    await service.startToday(deviceId);
    await service.markPromptPlaybackComplete(deviceId);

    state.progress = {
      ...state.progress,
      waitingSince: new Date(Date.now() - 11_000),
    };

    const timeout = await service.checkTimeout(deviceId);
    expect(timeout?.result).toBe("timeout");
    expect(timeout?.texts[0]).toBe("没关系，那我替你选森林吧！");
  });

  it("完集后当天额度用尽，startToday 不再进入新的冒险", async () => {
    await service.startToday(deviceId);
    await service.handleChildReply(deviceId, "去森林");
    await service.handleChildReply(deviceId, "它说谢谢你");
    await service.handleChildReply(deviceId, "我会每天刷牙");

    expect(state.daily?.status).toBe("completed");
    expect(await service.startToday(deviceId)).toBeNull();
  });
});
