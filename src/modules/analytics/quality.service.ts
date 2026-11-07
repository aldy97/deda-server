import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  isValidReportDate,
  reportDateInTimezone,
  reportDayRange,
} from "../learning-stats/parent-report-date.util";

export interface ConversationQualityQuery {
  startDate: string;
  endDate: string;
  granularity?: "day" | "week" | "month";
}

interface DayQuality {
  totalTurns: number;
  failedTurns: number;
  safetyBlockedTurns: number;
}

function bucketKeyOf(dateKey: string, granularity: string): string {
  if (granularity === "day") return dateKey;
  if (granularity === "month") return dateKey.slice(0, 7);
  const date = new Date(`${dateKey}T00:00:00Z`);
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum);
  return date.toISOString().slice(0, 10);
}

function hasSafetyCategory(rawPayload: unknown): boolean {
  return (
    typeof rawPayload === "object" &&
    rawPayload !== null &&
    "safetyCategory" in rawPayload
  );
}

@Injectable()
export class QualityService {
  constructor(private readonly prisma: PrismaService) {}

  async getConversationQuality(query: ConversationQualityQuery) {
    if (
      !isValidReportDate(query.startDate) ||
      !isValidReportDate(query.endDate)
    ) {
      throw new BadRequestException("Invalid date");
    }
    if (query.startDate > query.endDate) {
      throw new BadRequestException("startDate must be <= endDate");
    }
    const granularity = query.granularity ?? "day";

    const { start } = reportDayRange(query.startDate, DEFAULT_REPORT_TIMEZONE);
    const { end } = reportDayRange(query.endDate, DEFAULT_REPORT_TIMEZONE);

    const messages = await this.prisma.message.findMany({
      where: { spokeAt: { gte: start, lt: end } },
      select: { role: true, status: true, spokeAt: true, rawPayload: true },
    });

    const byBucket = new Map<string, DayQuality>();
    for (const message of messages) {
      const dateKey = reportDateInTimezone(
        message.spokeAt,
        DEFAULT_REPORT_TIMEZONE,
      );
      const bucketKey = bucketKeyOf(dateKey, granularity);
      let bucket = byBucket.get(bucketKey);
      if (!bucket) {
        bucket = { totalTurns: 0, failedTurns: 0, safetyBlockedTurns: 0 };
        byBucket.set(bucketKey, bucket);
      }
      // 一轮 = 一条 user 消息；失败/安全拦截挂在 assistant/user 行上分别计数
      if (message.role === "user") {
        bucket.totalTurns += 1;
        if (hasSafetyCategory(message.rawPayload)) {
          bucket.safetyBlockedTurns += 1;
        }
      } else if (message.role === "assistant" && message.status === "failed") {
        bucket.failedTurns += 1;
      }
    }

    const series = Array.from(byBucket.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, bucket]) => ({
        date,
        totalTurns: bucket.totalTurns,
        failedTurns: bucket.failedTurns,
        failureRate:
          bucket.totalTurns > 0
            ? Math.round((bucket.failedTurns / bucket.totalTurns) * 10000) /
              10000
            : null,
        safetyBlockedTurns: bucket.safetyBlockedTurns,
        safetyRate:
          bucket.totalTurns > 0
            ? Math.round(
                (bucket.safetyBlockedTurns / bucket.totalTurns) * 10000,
              ) / 10000
            : null,
      }));

    return { granularity, series };
  }
}
