import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import {
  isParentReportDue,
  previousReportDate,
  reportDayRange,
  resolveReportTimezone,
} from "./parent-report-date.util";

const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const GENERATION_LEASE_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5, 15, 45].map((minutes) => minutes * 60 * 1000);
const PROMPT_VERSION = "v1";
const MAX_TRANSCRIPT_CHARS = 24_000;

type ReportSummary = {
  expressionObservation: string | null;
  emotionObservation: string | null;
  thinkingObservation: string | null;
  suggestion: string | null;
};

@Injectable()
export class ParentReportGeneratorService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ParentReportGeneratorService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    if (
      this.configService.get<string>("PARENT_REPORT_GENERATION_ENABLED") !==
      "true"
    ) {
      return;
    }
    void this.generateDueReports();
    this.timer = setInterval(() => {
      void this.generateDueReports();
    }, SCAN_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async generateDueReports(now = new Date()): Promise<void> {
    const devices = await this.prisma.device.findMany({
      where: { bindings: { some: {} } },
      select: { id: true, timezone: true },
    });

    for (const device of devices) {
      const timezone = resolveReportTimezone(device.timezone);
      if (!isParentReportDue(now, timezone)) continue;
      try {
        await this.generateDeviceReport(
          device.id,
          previousReportDate(now, timezone),
          now,
        );
      } catch (error) {
        this.logger.error(
          `Unexpected parent report failure: ${this.errorMessage(error)}`,
        );
      }
    }
  }

  async generateDeviceReport(
    deviceId: string,
    reportDate: string,
    now = new Date(),
  ): Promise<void> {
    const attempt = await this.claimReport(deviceId, reportDate, now);
    if (attempt === null) return;

    try {
      const device = await this.prisma.device.findUnique({
        where: { id: deviceId },
        select: { timezone: true },
      });
      const { start, end } = reportDayRange(reportDate, device?.timezone);
      const messages = await this.prisma.message.findMany({
        where: {
          deviceId,
          spokeAt: { gte: start, lt: end },
        },
        orderBy: { spokeAt: "asc" },
        select: {
          role: true,
          content: true,
          rawPayload: true,
          spokeAt: true,
          mode: true,
        },
      });

      if (!messages.some((message) => message.role === "user")) {
        await this.completeReport(deviceId, reportDate, now, {
          expressionObservation: null,
          emotionObservation: null,
          thinkingObservation: null,
          suggestion: null,
        });
        return;
      }

      const [learningStat, adventureDaily, habitPlans] = await Promise.all([
        this.prisma.learningStat.findUnique({
          where: { deviceId_statDate: { deviceId, statDate: reportDate } },
          select: { durationSeconds: true },
        }),
        this.prisma.adventureDailyRecord.findFirst({
          where: {
            deviceId,
            OR: [{ assignedDate: reportDate }, { completedDate: reportDate }],
          },
          orderBy: { assignedAt: "desc" },
          select: { status: true },
        }),
        this.prisma.habitPlan.findMany({
          where: { deviceId, status: "active" },
          select: {
            title: true,
            targetDays: true,
            dailyRecords: {
              where: { recordDate: reportDate },
              select: { completed: true },
            },
          },
        }),
      ]);

      const prompt = this.buildPrompt({
        reportDate,
        messages,
        durationSeconds: learningStat?.durationSeconds ?? 0,
        adventureStatus: adventureDaily?.status ?? null,
        habits: habitPlans.map((plan) => ({
          title: plan.title,
          targetDays: plan.targetDays,
          completed: plan.dailyRecords.some((record) => record.completed),
        })),
      });
      const result = await this.llmService.complete({
        temperature: 0.2,
        maxTokens: 900,
        messages: [
          {
            role: "system",
            content:
              "你是儿童陪伴产品的家长报告撰写器。只输出一个 JSON 对象，不要 Markdown。" +
              "字段为 expressionObservation、emotionObservation、thinkingObservation、suggestion。" +
              "只能依据输入对话，使用审慎措辞，不做心理、智力或人格诊断，不给孩子贴标签。" +
              "证据不足的字段返回空字符串；建议必须温和、具体、第二天可执行。每段不超过 500 字。",
          },
          { role: "user", content: prompt },
        ],
      });
      await this.completeReport(
        deviceId,
        reportDate,
        now,
        this.parseSummary(result.text),
      );
    } catch (error) {
      await this.failReport(
        deviceId,
        reportDate,
        now,
        attempt,
        this.errorMessage(error),
      );
    }
  }

  private async claimReport(
    deviceId: string,
    reportDate: string,
    now: Date,
  ): Promise<number | null> {
    const existing = await this.prisma.parentReport.upsert({
      where: { deviceId_reportDate: { deviceId, reportDate } },
      create: { deviceId, reportDate },
      update: {},
      select: { generationAttempts: true },
    });
    const staleBefore = new Date(now.getTime() - GENERATION_LEASE_MS);
    const claimed = await this.prisma.parentReport.updateMany({
      where: {
        deviceId,
        reportDate,
        OR: [
          { generationStatus: "pending" },
          {
            generationStatus: "failed",
            generationAttempts: { lt: MAX_ATTEMPTS },
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
          },
          { generationStatus: "generating", generationStartedAt: null },
          {
            generationStatus: "generating",
            generationStartedAt: { lt: staleBefore },
          },
        ],
      },
      data: {
        generationStatus: "generating",
        generationStartedAt: now,
        generationAttempts: { increment: 1 },
        generationError: null,
        nextRetryAt: null,
      },
    });
    return claimed.count === 1 ? existing.generationAttempts + 1 : null;
  }

  private buildPrompt(input: {
    reportDate: string;
    messages: Array<{
      role: string;
      content: string;
      rawPayload: unknown;
      spokeAt: Date;
      mode: string | null;
    }>;
    durationSeconds: number;
    adventureStatus: string | null;
    habits: Array<{ title: string; targetDays: number; completed: boolean }>;
  }): string {
    const modeCounts = new Map<string, number>();
    const transcript: string[] = [];
    for (const message of input.messages) {
      if (message.role === "user") {
        const mode = message.mode || "unknown";
        modeCounts.set(mode, (modeCounts.get(mode) ?? 0) + 1);
        transcript.push(
          `${message.spokeAt.toISOString()} 孩子：${message.content}`,
        );
        continue;
      }
      const answer = LlmService.extractAnswer(
        message.content,
        message.rawPayload,
      );
      if (answer !== null) {
        transcript.push(`${message.spokeAt.toISOString()} Elly：${answer}`);
      }
    }

    const fullTranscript = transcript.join("\n");
    const boundedTranscript =
      fullTranscript.length <= MAX_TRANSCRIPT_CHARS
        ? fullTranscript
        : `${fullTranscript.slice(0, 6000)}\n……中间内容已省略……\n${fullTranscript.slice(-18_000)}`;
    const metadata = {
      reportDate: input.reportDate,
      durationMinutes: Math.round(input.durationSeconds / 60),
      modeUsage: Array.from(modeCounts, ([mode, count]) => ({ mode, count })),
      adventureStatus: input.adventureStatus,
      habits: input.habits,
    };
    return `请根据以下数据撰写昨天家长报告。\n${JSON.stringify(metadata)}\n对话记录：\n${boundedTranscript}`;
  }

  private parseSummary(text: string): ReportSummary {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid parent report JSON");
    }
    const record = parsed as Record<string, unknown>;
    const summary: ReportSummary = {
      expressionObservation: "",
      emotionObservation: "",
      thinkingObservation: "",
      suggestion: "",
    };
    for (const key of Object.keys(summary) as Array<keyof ReportSummary>) {
      const value = record[key];
      if (typeof value !== "string" || value.length > 500) {
        throw new Error(`Invalid parent report field: ${key}`);
      }
      summary[key] = value.trim() || null;
    }
    if (Object.values(summary).every((value) => value === null)) {
      throw new Error("Empty parent report summary");
    }
    return summary;
  }

  private async completeReport(
    deviceId: string,
    reportDate: string,
    now: Date,
    summary: ReportSummary,
  ) {
    await this.prisma.parentReport.updateMany({
      where: {
        deviceId,
        reportDate,
        generationStatus: "generating",
        generationStartedAt: now,
      },
      data: {
        ...summary,
        generationStatus: "completed",
        generatedAt: now,
        generatorModel:
          this.configService.get<string>("OPENAI_MODEL") ?? "primary",
        promptVersion: PROMPT_VERSION,
        generationError: null,
        nextRetryAt: null,
      },
    });
  }

  private async failReport(
    deviceId: string,
    reportDate: string,
    now: Date,
    attempt: number,
    message: string,
  ) {
    await this.prisma.parentReport.updateMany({
      where: {
        deviceId,
        reportDate,
        generationStatus: "generating",
        generationStartedAt: now,
      },
      data: {
        generationStatus: "failed",
        generationError: message,
        nextRetryAt:
          attempt < MAX_ATTEMPTS
            ? new Date(now.getTime() + RETRY_DELAYS_MS[attempt - 1])
            : null,
      },
    });
  }

  private errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(
      0,
      300,
    );
  }
}
