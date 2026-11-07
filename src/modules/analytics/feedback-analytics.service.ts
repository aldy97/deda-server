import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";

export interface ParentReportFeedbackQuery {
  startDate?: string;
  endDate?: string;
  isUseful?: boolean;
  page?: number;
  pageSize?: number;
}

export interface UserFeedbackQuery {
  startDate?: string;
  endDate?: string;
  hasContact?: boolean;
  page?: number;
  pageSize?: number;
}

/**
 * 反馈分析（dashboard 内部用）：
 * - parent-reports：家长报告有用性反馈，日期区间按 reportDate（业务日期）过滤；
 *   summary 为区间内整体有用率，刻意不受 isUseful 列表过滤影响（否则恒为 100%）。
 * - user-feedbacks：用户反馈，日期区间按 createdAt（服务器本地时区当日边界）过滤；
 *   用户已注销时 user 为 null（Feedback.user 是 SetNull 关系）。
 */
@Injectable()
export class FeedbackAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async listParentReportFeedbacks(query: ParentReportFeedbackQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const dateWhere: Prisma.ParentReportFeedbackWhereInput = {};
    if (query.startDate || query.endDate) {
      dateWhere.reportDate = {
        ...(query.startDate ? { gte: query.startDate } : {}),
        ...(query.endDate ? { lte: query.endDate } : {}),
      };
    }
    const listWhere: Prisma.ParentReportFeedbackWhereInput = {
      ...dateWhere,
      ...(query.isUseful !== undefined ? { isUseful: query.isUseful } : {}),
    };

    const [total, rows, grouped] = await Promise.all([
      this.prisma.parentReportFeedback.count({ where: listWhere }),
      this.prisma.parentReportFeedback.findMany({
        where: listWhere,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          reportDate: true,
          isUseful: true,
          updatedAt: true,
          user: { select: { nickname: true, phone: true } },
          report: {
            select: {
              device: {
                select: {
                  deviceId: true,
                  deviceCode: true,
                  characterKey: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.parentReportFeedback.groupBy({
        by: ["isUseful"],
        where: dateWhere,
        _count: { _all: true },
      }),
    ]);

    const usefulCount =
      grouped.find((group) => group.isUseful)?._count._all ?? 0;
    const notUsefulCount =
      grouped.find((group) => !group.isUseful)?._count._all ?? 0;
    const rangeTotal = usefulCount + notUsefulCount;

    return {
      total,
      page,
      pageSize,
      summary: {
        usefulCount,
        notUsefulCount,
        usefulRate:
          rangeTotal === 0 ? 0 : Number((usefulCount / rangeTotal).toFixed(4)),
      },
      items: rows.map((row) => ({
        id: row.id,
        reportDate: row.reportDate,
        isUseful: row.isUseful,
        feedbackAt: row.updatedAt,
        user: row.user,
        device: row.report.device,
      })),
    };
  }

  async listUserFeedbacks(query: UserFeedbackQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.FeedbackWhereInput = {};
    if (query.startDate || query.endDate) {
      // createdAt 为 DateTime：区间按服务器本地时区的当日边界，endDate 含全天
      const createdAt: Prisma.DateTimeFilter = {};
      if (query.startDate) {
        createdAt.gte = new Date(`${query.startDate}T00:00:00`);
      }
      if (query.endDate) {
        const endExclusive = new Date(`${query.endDate}T00:00:00`);
        endExclusive.setDate(endExclusive.getDate() + 1);
        createdAt.lt = endExclusive;
      }
      where.createdAt = createdAt;
    }
    if (query.hasContact) {
      where.AND = [{ contact: { not: null } }, { contact: { not: "" } }];
    }

    const [total, rows] = await Promise.all([
      this.prisma.feedback.count({ where }),
      this.prisma.feedback.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          content: true,
          contact: true,
          createdAt: true,
          user: { select: { nickname: true, phone: true } },
        },
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      items: rows.map((row) => ({
        id: row.id,
        content: row.content,
        contact: row.contact,
        createdAt: row.createdAt,
        user: row.user,
      })),
    };
  }
}
