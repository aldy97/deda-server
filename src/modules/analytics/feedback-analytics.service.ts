import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";

export interface ParentReportFeedbackQuery {
  startDate?: string;
  endDate?: string;
  isUseful?: boolean;
  /** 业务设备 ID（Device.deviceId），内部 resolve 成 Device.id */
  deviceId?: string;
  page?: number;
  pageSize?: number;
}

export interface UserFeedbackQuery {
  startDate?: string;
  endDate?: string;
  hasContact?: boolean;
  /** 业务设备 ID：经 UserDeviceBinding 反查该设备全部绑定账号的反馈 */
  deviceId?: string;
  page?: number;
  pageSize?: number;
}

/** 两个列表共用的空页结构（设备不存在 / 无绑定用户时短路返回） */
function emptyPage(page: number, pageSize: number) {
  return { total: 0, page, pageSize, items: [] as never[] };
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

  /** 业务 deviceId → 内部 UUID；查不到返回 null（调用方短路空页） */
  private async resolveDeviceId(bizDeviceId: string): Promise<string | null> {
    const device = await this.prisma.device.findUnique({
      where: { deviceId: bizDeviceId },
      select: { id: true },
    });
    return device?.id ?? null;
  }

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

    // 单设备过滤（用户详情页）：ParentReportFeedback.deviceId 存内部 UUID
    let deviceFilter: Prisma.ParentReportFeedbackWhereInput = {};
    if (query.deviceId) {
      const internalId = await this.resolveDeviceId(query.deviceId);
      if (!internalId) {
        return {
          ...emptyPage(page, pageSize),
          summary: { usefulCount: 0, notUsefulCount: 0, usefulRate: 0 },
        };
      }
      deviceFilter = { deviceId: internalId };
      dateWhere.deviceId = internalId;
    }

    const listWhere: Prisma.ParentReportFeedbackWhereInput = {
      ...dateWhere,
      ...deviceFilter,
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
              reportDate: true,
              generationStatus: true,
              expressionObservation: true,
              emotionObservation: true,
              thinkingObservation: true,
              suggestion: true,
              generatedAt: true,
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
        // 反馈对应的日报内容（同设备同 reportDate），供反馈页对照展示
        report: {
          reportDate: row.report.reportDate,
          generationStatus: row.report.generationStatus,
          expressionObservation: row.report.expressionObservation,
          emotionObservation: row.report.emotionObservation,
          thinkingObservation: row.report.thinkingObservation,
          suggestion: row.report.suggestion,
          generatedAt: row.report.generatedAt,
        },
      })),
    };
  }

  async listUserFeedbacks(query: UserFeedbackQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.FeedbackWhereInput = {};

    // 单设备过滤（用户详情页）：Feedback 只有 userId，经绑定关系反查
    // 该设备全部绑定账号；设备不存在或无绑定时短路空页
    if (query.deviceId) {
      const internalId = await this.resolveDeviceId(query.deviceId);
      if (!internalId) return emptyPage(page, pageSize);
      const bindings = await this.prisma.userDeviceBinding.findMany({
        where: { deviceId: internalId },
        select: { userId: true },
      });
      const userIds = bindings.map((binding) => binding.userId);
      if (userIds.length === 0) return emptyPage(page, pageSize);
      where.userId = { in: userIds };
    }

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
