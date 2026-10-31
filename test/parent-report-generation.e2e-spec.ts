import { randomUUID } from "crypto";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../src/common/prisma/prisma.service";
import { LlmService } from "../src/modules/llm/llm.service";
import { ParentReportGeneratorService } from "../src/modules/learning-stats/parent-report-generator.service";
import { LearningStatsService } from "../src/modules/learning-stats/learning-stats.service";

const REPORT_DATE = "2026-10-30";
const BEFORE_DUE = new Date("2026-10-30T17:14:00Z");
const AFTER_DUE = new Date("2026-10-30T17:15:00Z");

describe("Parent report generation with PostgreSQL", () => {
  let prisma: PrismaService;
  let generator: ParentReportGeneratorService;
  let learningStats: LearningStatsService;
  let llmComplete: jest.Mock;
  let userId: string;
  let deviceInternalId: string;
  let deviceId: string;
  let openid: string;

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is required for parent report e2e");
    }
    prisma = new PrismaService();
    await prisma.$connect();
    learningStats = new LearningStatsService(prisma);
  });

  beforeEach(async () => {
    openid = `test-parent-report-${randomUUID()}`;
    deviceId = `TEST-PR-${randomUUID()}`;
    const user = await prisma.user.create({ data: { openid } });
    userId = user.id;
    const device = await prisma.device.create({
      data: { deviceId, timezone: "Asia/Shanghai" },
    });
    deviceInternalId = device.id;
    await prisma.userDeviceBinding.create({
      data: { userId, deviceId: deviceInternalId },
    });

    llmComplete = jest.fn().mockResolvedValue({
      text: JSON.stringify({
        expressionObservation: "孩子主动表达了继续冒险的愿望。",
        emotionObservation: "表现出参与兴趣。",
        thinkingObservation: "能够延续当前故事语境。",
        suggestion: "明天可以继续邀请孩子讲完一个故事。",
      }),
    });
    const configService = {
      get: jest.fn((key: string) =>
        key === "OPENAI_MODEL" ? "primary-e2e-model" : undefined,
      ),
    } as unknown as ConfigService;
    generator = new ParentReportGeneratorService(
      prisma,
      { complete: llmComplete } as unknown as LlmService,
      configService,
    );
  });

  afterEach(async () => {
    if (!prisma) return;
    await prisma.device.deleteMany({ where: { deviceId } });
    await prisma.user.deleteMany({ where: { openid } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("generates after local 01:15, strips filler, reads back and stays idempotent", async () => {
    await prisma.message.createMany({
      data: [
        {
          deviceId: deviceInternalId,
          turnId: "turn-current",
          role: "user",
          content: "我想继续冒险",
          mode: "adventure_story",
          hitUnitIds: [],
          spokeAt: new Date("2026-10-30T02:00:00Z"),
        },
        {
          deviceId: deviceInternalId,
          turnId: "turn-current",
          role: "assistant",
          content: "这只是filler不应进入报告\n我们一起去找风铃吧。",
          rawPayload: {
            filler: "这只是filler不应进入报告",
            answer: "我们一起去找风铃吧。",
          },
          mode: "adventure_story",
          hitUnitIds: [],
          spokeAt: new Date("2026-10-30T02:00:02Z"),
        },
        {
          deviceId: deviceInternalId,
          turnId: "turn-old",
          role: "user",
          content: "前一天的消息不应进入报告",
          hitUnitIds: [],
          spokeAt: new Date("2026-10-29T15:59:59Z"),
        },
      ],
    });

    await generator.generateDueReports(BEFORE_DUE);
    await expect(
      prisma.parentReport.findUnique({
        where: {
          deviceId_reportDate: {
            deviceId: deviceInternalId,
            reportDate: REPORT_DATE,
          },
        },
      }),
    ).resolves.toBeNull();
    expect(llmComplete).not.toHaveBeenCalled();

    await generator.generateDueReports(AFTER_DUE);

    const report = await prisma.parentReport.findUniqueOrThrow({
      where: {
        deviceId_reportDate: {
          deviceId: deviceInternalId,
          reportDate: REPORT_DATE,
        },
      },
    });
    expect(report.generationStatus).toBe("completed");
    expect(report.generationAttempts).toBe(1);
    expect(report.generatorModel).toBe("primary-e2e-model");
    expect(report.promptVersion).toBe("v1");
    expect(report.expressionObservation).toContain("继续冒险");

    const prompt = llmComplete.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain("我们一起去找风铃吧。");
    expect(prompt).not.toContain("这只是filler不应进入报告");
    expect(prompt).not.toContain("前一天的消息不应进入报告");

    const response = await learningStats.getParentReport(
      userId,
      deviceId,
      REPORT_DATE,
    );
    expect(response.summary?.suggestion).toContain("明天");
    expect(response.modeUsage).toEqual([{ mode: "adventure_story", count: 1 }]);

    await generator.generateDueReports(AFTER_DUE);
    expect(llmComplete).toHaveBeenCalledTimes(1);
    const unchanged = await prisma.parentReport.findUniqueOrThrow({
      where: {
        deviceId_reportDate: {
          deviceId: deviceInternalId,
          reportDate: REPORT_DATE,
        },
      },
    });
    expect(unchanged.generationAttempts).toBe(1);
  });

  it("completes an empty-day report without calling the LLM", async () => {
    await generator.generateDeviceReport(
      deviceInternalId,
      REPORT_DATE,
      AFTER_DUE,
    );

    const report = await prisma.parentReport.findUniqueOrThrow({
      where: {
        deviceId_reportDate: {
          deviceId: deviceInternalId,
          reportDate: REPORT_DATE,
        },
      },
    });
    expect(report.generationStatus).toBe("completed");
    expect(report.expressionObservation).toBeNull();
    expect(report.emotionObservation).toBeNull();
    expect(report.thinkingObservation).toBeNull();
    expect(report.suggestion).toBeNull();
    expect(llmComplete).not.toHaveBeenCalled();
  });
});
