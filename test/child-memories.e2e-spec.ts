import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { ChildMemory } from "@prisma/client";
import { PrismaService } from "./../src/common/prisma/prisma.service";
import { VendorService } from "./../src/modules/vendor/vendor.service";
import { VendorReplyUploader } from "./../src/modules/vendor/vendor-reply.uploader";
import { LlmService } from "./../src/modules/llm/llm.service";
import { ChildMemoriesService } from "./../src/modules/child-memories/child-memories.service";
import { AdventureService } from "./../src/modules/adventure/adventure.service";
import { ConversationSessionService } from "./../src/modules/vendor/conversation-session.service";
import { ChildSafetyService } from "./../src/modules/vendor/child-safety.service";
import { SleepConfigsService } from "./../src/modules/sleep-configs/sleep-configs.service";
import { SleepVoiceConfigService } from "./../src/modules/sleep-configs/sleep-voice-config.service";

const extraction = (value: string, operation = "assert", evidence: string) =>
  JSON.stringify([
    {
      key: "favorite_color",
      value,
      operation,
      evidence,
      confidence: 0.95,
    },
  ]);

async function* streamOf(...chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("Child memories conversation pipeline (e2e)", () => {
  let vendorService: VendorService;
  let childMemoriesService: ChildMemoriesService;
  let memories: ChildMemory[];
  let mockLlmService: {
    complete: jest.Mock;
    completeStream: jest.Mock;
    buildEnglishTutorPrompt: jest.Mock;
    buildFillerPrompt: jest.Mock;
    smallModelName: string;
  };
  let mockReplyUploader: { sendChunk: jest.Mock; sendFullReply: jest.Mock };

  const waitFor = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error("waitFor timeout");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  beforeEach(async () => {
    memories = [];
    const prismaMock = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $transaction: jest.fn((callback) => callback(prismaMock)),
      device: {
        findUnique: jest.fn().mockResolvedValue({
          id: "device-uuid",
          deviceId: "device-external",
        }),
      },
      deviceConfig: {
        findFirst: jest.fn().mockResolvedValue({
          mode: "free_chat",
          conversationModeKey: "free_chat_casual",
        }),
      },
      childProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      conversationMode: {
        findFirst: jest.fn().mockResolvedValue({ promptTemplate: null }),
      },
      message: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(({ data }) => Promise.resolve(data)),
      },
      conversationSession: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
      childMemory: {
        findMany: jest.fn(({ where }) =>
          Promise.resolve(
            memories
              .filter(
                (memory) =>
                  memory.deviceId === where.deviceId &&
                  memory.status === where.status,
              )
              .sort(
                (a, b) =>
                  b.lastConfirmedAt.getTime() - a.lastConfirmedAt.getTime(),
              ),
          ),
        ),
        findFirst: jest.fn(({ where }) => {
          if (where.sourceTurnId) {
            return Promise.resolve(
              memories.find(
                (memory) =>
                  memory.deviceId === where.deviceId &&
                  memory.sourceTurnId === where.sourceTurnId &&
                  memory.key === where.key,
              ) ?? null,
            );
          }
          return Promise.resolve(
            memories
              .filter(
                (memory) =>
                  memory.deviceId === where.deviceId &&
                  memory.key === where.key &&
                  memory.status === where.status,
              )
              .sort((a, b) => b.version - a.version)[0] ?? null,
          );
        }),
        create: jest.fn(({ data }) => {
          const now = new Date();
          const memory = {
            ...data,
            createdAt: now,
            updatedAt: now,
          } as ChildMemory;
          memories.push(memory);
          return Promise.resolve(memory);
        }),
        update: jest.fn(({ where, data }) => {
          const memory = memories.find((item) => item.id === where.id);
          if (!memory) {
            return Promise.reject(new Error("memory not found"));
          }
          Object.assign(memory, data, { updatedAt: new Date() });
          return Promise.resolve(memory);
        }),
        updateMany: jest.fn(({ where, data }) => {
          const selected = memories.filter(
            (memory) =>
              where.id.in.includes(memory.id) && memory.status === where.status,
          );
          for (const memory of selected) {
            memory.lastInjectedAt = data.lastInjectedAt;
            memory.injectionCount += data.injectionCount.increment;
          }
          return Promise.resolve({ count: selected.length });
        }),
      },
    };

    mockLlmService = {
      complete: jest.fn(),
      completeStream: jest.fn((options) =>
        options.model === "small-llm"
          ? streamOf("嗯")
          : streamOf("I still answer."),
      ),
      buildEnglishTutorPrompt: jest.fn((asrText: string) => [
        { role: "user", content: asrText },
      ]),
      buildFillerPrompt: jest.fn().mockReturnValue([]),
      smallModelName: "small-llm",
    };
    mockReplyUploader = {
      sendChunk: jest.fn().mockResolvedValue(undefined),
      sendFullReply: jest.fn().mockResolvedValue(undefined),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      providers: [
        VendorService,
        ChildMemoriesService,
        ConversationSessionService,
        // 真实安全服务：L1 纯本地正则；L2 走被 mock 的 complete，
        // 默认返回 undefined 时 fail-open 为 safe，不改变被测链路语义
        ChildSafetyService,
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
        { provide: LlmService, useValue: mockLlmService },
        { provide: VendorReplyUploader, useValue: mockReplyUploader },
        {
          provide: AdventureService,
          useValue: {
            handleChildReply: jest.fn().mockResolvedValue(null),
            isCompletedToday: jest.fn().mockResolvedValue(false),
            registerTimeoutListener: jest.fn(),
          },
        },
        // 哄睡配置依赖：本链路不触及，仅满足 VendorService 构造签名
        {
          provide: SleepConfigsService,
          useValue: {
            applyVoiceUpdate: jest.fn(),
            getByDeviceId: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: SleepVoiceConfigService,
          useValue: { handle: jest.fn() },
        },
      ],
    }).compile();

    vendorService = moduleFixture.get(VendorService);
    childMemoriesService = moduleFixture.get(ChildMemoriesService);
  });

  it("should preserve red history, activate blue v2, and recall only blue", async () => {
    // 按 scene 分派而非按调用顺序排队：一轮里 L2 安全分类与意图分类是
    // Promise.all 并行发起的，谁先消费 mock 队列并不确定；且意图分类在
    // 移除前置关键词过滤后每轮都会调用，位置式队列必然错位。
    const extractionResponses = [
      extraction("red", "assert", "我最喜欢红色"),
      extraction("blue", "supersede", "我现在最喜欢蓝色"),
    ];
    mockLlmService.complete.mockImplementation(
      (options: { scene?: string }) => {
        if (options.scene === "safety_l2") {
          return Promise.resolve({ text: "safe" });
        }
        if (options.scene === "intent_classify") {
          return Promise.resolve({ text: "free_chat" });
        }
        if (options.scene === "memory_extract") {
          return Promise.resolve({ text: extractionResponses.shift() ?? "[]" });
        }
        return Promise.resolve({ text: "[]" });
      },
    );

    await vendorService.handleTextIn({
      deviceId: "device-external",
      asrText: "我最喜欢红色",
    });
    await waitFor(() => memories.length === 1);
    await vendorService.handleTextIn({
      deviceId: "device-external",
      asrText: "我现在最喜欢蓝色",
    });
    await waitFor(() => memories.length === 2);

    // 两条记忆抽取响应都被按 scene 正确消费，没有被其他场景误吞
    expect(extractionResponses).toHaveLength(0);

    const red = memories.find((memory) => memory.version === 1);
    const blue = memories.find((memory) => memory.version === 2);
    expect(red).toMatchObject({
      valueText: "red",
      status: "superseded",
      supersededById: blue?.id,
    });
    expect(blue).toMatchObject({ valueText: "blue", status: "active" });

    // 全量注入：无关键词也返回全部 active 记忆；superseded 的 red 不带出
    const recalled = await childMemoriesService.buildPromptBlock(
      "device-uuid",
      [],
    );
    expect(recalled.text).toContain("blue");
    expect(recalled.text).not.toContain("red");
    expect(recalled.memoryIds).toEqual([blue?.id]);
  });

  it("should keep uploading the answer when memory extraction fails", async () => {
    mockLlmService.complete.mockRejectedValue(
      new Error("extractor unavailable"),
    );

    await expect(
      vendorService.handleTextIn({
        deviceId: "device-external",
        asrText: "Hello",
      }),
    ).resolves.toMatchObject({ responseText: "嗯\nI still answer." });

    expect(
      mockReplyUploader.sendChunk.mock.calls.some(
        ([chunk]) => chunk.source === "answer",
      ),
    ).toBe(true);
    expect(memories).toHaveLength(0);
  });
});
