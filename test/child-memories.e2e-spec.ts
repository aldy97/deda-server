import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { ChildMemory } from "@prisma/client";
import { PrismaService } from "./../src/common/prisma/prisma.service";
import { VendorService } from "./../src/modules/vendor/vendor.service";
import { VendorReplyUploader } from "./../src/modules/vendor/vendor-reply.uploader";
import { RagService } from "./../src/modules/rag/rag.service";
import { LlmService } from "./../src/modules/llm/llm.service";
import { ChildMemoriesService } from "./../src/modules/child-memories/child-memories.service";
import { AdventureService } from "./../src/modules/adventure/adventure.service";

const extraction = (value: string, operation = "assert") =>
  JSON.stringify([
    {
      key: "favorite_color",
      value,
      operation,
      evidence: "孩子明确表达",
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
          textbookId: null,
          unitId: null,
          conversationModeKey: "companion",
        }),
      },
      childProfile: { findUnique: jest.fn().mockResolvedValue(null) },
      conversationMode: {
        findFirst: jest.fn().mockResolvedValue({ promptTemplate: null }),
      },
      textbook: { findUnique: jest.fn().mockResolvedValue(null) },
      unit: { findUnique: jest.fn().mockResolvedValue(null) },
      message: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(({ data }) => Promise.resolve(data)),
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
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
        {
          provide: RagService,
          useValue: {
            retrieve: jest.fn().mockResolvedValue({
              unitName: null,
              content: "",
              found: false,
            }),
            truncateContent: jest.fn((content: string) => content),
          },
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
      ],
    }).compile();

    vendorService = moduleFixture.get(VendorService);
    childMemoriesService = moduleFixture.get(ChildMemoriesService);
  });

  it("should preserve red history, activate blue v2, and recall only blue", async () => {
    mockLlmService.complete
      .mockResolvedValueOnce({ text: extraction("red") })
      .mockResolvedValueOnce({ text: extraction("blue", "supersede") });

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

    const red = memories.find((memory) => memory.version === 1);
    const blue = memories.find((memory) => memory.version === 2);
    expect(red).toMatchObject({
      valueText: "red",
      status: "superseded",
      supersededById: blue?.id,
    });
    expect(blue).toMatchObject({ valueText: "blue", status: "active" });

    const recalled = await childMemoriesService.buildPromptBlock(
      "device-uuid",
      "你还记得我喜欢什么颜色吗？",
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
