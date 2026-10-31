import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { ParentReportGeneratorService } from "./parent-report-generator.service";
import { reportDayRange } from "./parent-report-date.util";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";

type PrismaMock = {
  device: { findMany: jest.Mock; findUnique: jest.Mock };
  parentReport: { upsert: jest.Mock; updateMany: jest.Mock };
  message: { findMany: jest.Mock };
  learningStat: { findUnique: jest.Mock };
  adventureDailyRecord: { findFirst: jest.Mock };
  habitPlan: { findMany: jest.Mock };
};

describe("ParentReportGeneratorService", () => {
  let service: ParentReportGeneratorService;
  let prisma: PrismaMock;
  let llm: { complete: jest.Mock };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ParentReportGeneratorService,
        {
          provide: PrismaService,
          useValue: {
            device: {
              findMany: jest.fn().mockResolvedValue([]),
              findUnique: jest
                .fn()
                .mockResolvedValue({ timezone: "Asia/Shanghai" }),
            },
            parentReport: {
              upsert: jest.fn().mockResolvedValue({ generationAttempts: 0 }),
              updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            message: { findMany: jest.fn().mockResolvedValue([]) },
            learningStat: { findUnique: jest.fn().mockResolvedValue(null) },
            adventureDailyRecord: {
              findFirst: jest.fn().mockResolvedValue(null),
            },
            habitPlan: { findMany: jest.fn().mockResolvedValue([]) },
          },
        },
        {
          provide: LlmService,
          useValue: { complete: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === "OPENAI_MODEL" ? "primary-test-model" : undefined,
            ),
          },
        },
      ],
    }).compile();

    service = module.get(ParentReportGeneratorService);
    prisma = module.get<PrismaService>(PrismaService) as unknown as PrismaMock;
    llm = module.get<LlmService>(LlmService) as unknown as {
      complete: jest.Mock;
    };
  });

  it("should generate a report from answer-only conversation content", async () => {
    prisma.message.findMany.mockResolvedValue([
      {
        role: "user",
        content: "我想继续冒险",
        rawPayload: {},
        spokeAt: new Date("2026-10-30T02:00:00Z"),
        mode: "adventure_story",
      },
      {
        role: "assistant",
        content: "嗯\n我们一起去找风铃吧。",
        rawPayload: { filler: "嗯", answer: "我们一起去找风铃吧。" },
        spokeAt: new Date("2026-10-30T02:00:02Z"),
        mode: "adventure_story",
      },
    ]);
    llm.complete.mockResolvedValue({
      text: JSON.stringify({
        expressionObservation: "孩子主动表达了继续冒险的愿望。",
        emotionObservation: "表现出参与兴趣。",
        thinkingObservation: "能够延续当前故事语境。",
        suggestion: "明天继续邀请孩子描述故事选择。",
      }),
    });

    await service.generateDeviceReport(
      "device-1",
      "2026-10-30",
      new Date("2026-10-30T17:20:00Z"),
    );

    const llmOptions = llm.complete.mock.calls[0][0];
    const prompt = llmOptions.messages
      .map((message: { content: string }) => message.content)
      .join("\n");
    expect(prompt).toContain("我们一起去找风铃吧。");
    expect(prompt).not.toContain("filler");
    expect(prompt).not.toContain("嗯\n");

    const completion = prisma.parentReport.updateMany.mock.calls.at(-1)?.[0];
    expect(completion).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          generationStatus: "completed",
          expressionObservation: "孩子主动表达了继续冒险的愿望。",
          generatorModel: "primary-test-model",
          promptVersion: "v1",
        }),
      }),
    );
  });

  it("should complete an empty-day report without calling the LLM", async () => {
    await service.generateDeviceReport(
      "device-1",
      "2026-10-30",
      new Date("2026-10-30T17:20:00Z"),
    );

    expect(llm.complete).not.toHaveBeenCalled();
    expect(prisma.parentReport.updateMany.mock.calls.at(-1)?.[0].data).toEqual(
      expect.objectContaining({
        generationStatus: "completed",
        expressionObservation: null,
        suggestion: null,
      }),
    );
  });

  it("should skip generation when another instance owns the report", async () => {
    prisma.parentReport.updateMany.mockResolvedValue({ count: 0 });

    await service.generateDeviceReport(
      "device-1",
      "2026-10-30",
      new Date("2026-10-30T17:20:00Z"),
    );

    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("should mark a failed generation with a five-minute first retry", async () => {
    const now = new Date("2026-10-30T17:20:00Z");
    prisma.message.findMany.mockResolvedValue([
      {
        role: "user",
        content: "讲个故事",
        rawPayload: {},
        spokeAt: new Date("2026-10-30T02:00:00Z"),
        mode: "free_chat",
      },
    ]);
    llm.complete.mockRejectedValue(new Error("model timeout"));

    await service.generateDeviceReport("device-1", "2026-10-30", now);

    expect(prisma.parentReport.updateMany.mock.calls.at(-1)?.[0].data).toEqual(
      expect.objectContaining({
        generationStatus: "failed",
        generationError: "model timeout",
        nextRetryAt: new Date("2026-10-30T17:25:00Z"),
      }),
    );
  });

  it("should only scan devices whose local generation time has arrived", async () => {
    prisma.device.findMany.mockResolvedValue([
      { id: "shanghai", timezone: "Asia/Shanghai" },
      { id: "tokyo", timezone: "Asia/Tokyo" },
    ]);
    prisma.parentReport.updateMany.mockResolvedValue({ count: 0 });

    await service.generateDueReports(new Date("2026-10-30T16:20:00Z"));

    expect(prisma.parentReport.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.parentReport.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deviceId_reportDate: {
            deviceId: "tokyo",
            reportDate: "2026-10-30",
          },
        },
      }),
    );
  });

  it("should compute report day boundaries in the device timezone", () => {
    expect(reportDayRange("2026-10-30", "Asia/Shanghai")).toEqual({
      start: new Date("2026-10-29T16:00:00Z"),
      end: new Date("2026-10-30T16:00:00Z"),
    });
  });

  it("should remain disabled without the generation environment flag", () => {
    service.onModuleInit();
    expect(prisma.device.findMany).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it("should mark malformed model JSON as failed without saving a summary", async () => {
    prisma.message.findMany.mockResolvedValue([
      {
        role: "user",
        content: "讲个故事",
        rawPayload: {},
        spokeAt: new Date("2026-10-30T02:00:00Z"),
        mode: "free_chat",
      },
    ]);
    llm.complete.mockResolvedValue({ text: "not-json" });

    await service.generateDeviceReport(
      "device-1",
      "2026-10-30",
      new Date("2026-10-30T17:20:00Z"),
    );

    const failure = prisma.parentReport.updateMany.mock.calls.at(-1)?.[0];
    expect(failure.data).toEqual(
      expect.objectContaining({ generationStatus: "failed" }),
    );
    expect(failure.data.expressionObservation).toBeUndefined();
  });

  it.each([
    [
      "non-string",
      {
        expressionObservation: null,
        emotionObservation: "",
        thinkingObservation: "",
        suggestion: "",
      },
    ],
    [
      "empty",
      {
        expressionObservation: "",
        emotionObservation: "",
        thinkingObservation: "",
        suggestion: "",
      },
    ],
  ])("should reject a %s summary", async (_caseName, summary) => {
    prisma.message.findMany.mockResolvedValue([
      {
        role: "user",
        content: "讲个故事",
        rawPayload: {},
        spokeAt: new Date("2026-10-30T02:00:00Z"),
        mode: "free_chat",
      },
    ]);
    llm.complete.mockResolvedValue({ text: JSON.stringify(summary) });

    await service.generateDeviceReport(
      "device-1",
      "2026-10-30",
      new Date("2026-10-30T17:20:00Z"),
    );

    expect(prisma.parentReport.updateMany.mock.calls.at(-1)?.[0].data).toEqual(
      expect.objectContaining({ generationStatus: "failed" }),
    );
  });

  it("should continue the scheduled scan after an unexpected device failure", async () => {
    prisma.device.findMany.mockResolvedValue([
      { id: "device-1", timezone: "Asia/Shanghai" },
    ]);
    prisma.parentReport.upsert.mockRejectedValue(new Error("database busy"));

    await expect(
      service.generateDueReports(new Date("2026-10-30T17:20:00Z")),
    ).resolves.toBeUndefined();
  });
});
