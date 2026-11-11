import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";

export interface ParentReportsQuery {
  /** 业务设备 ID（Device.deviceId），内部 resolve 成 Device.id */
  deviceId: string;
  page?: number;
  pageSize?: number;
}

/**
 * 家长日报浏览（dashboard 用户详情页用）：单设备维度，按 reportDate 倒序。
 * 设备不存在 404（与 memories 设备详情口径一致）；generationStatus 非
 * completed 的行也返回（观察字段为空），便于排查生成失败。
 */
@Injectable()
export class ParentReportsAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async listByDevice(query: ParentReportsQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const device = await this.prisma.device.findUnique({
      where: { deviceId: query.deviceId },
      select: {
        id: true,
        deviceId: true,
        deviceCode: true,
        characterKey: true,
      },
    });
    if (!device) {
      throw new NotFoundException("device not found");
    }

    const where = { deviceId: device.id };
    const [total, rows] = await Promise.all([
      this.prisma.parentReport.count({ where }),
      this.prisma.parentReport.findMany({
        where,
        orderBy: { reportDate: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          reportDate: true,
          generationStatus: true,
          expressionObservation: true,
          emotionObservation: true,
          thinkingObservation: true,
          suggestion: true,
          generatorModel: true,
          generatedAt: true,
          // 该日报的家长反馈（多个绑定账号可分别评价 → 数组）
          feedbacks: {
            select: {
              isUseful: true,
              updatedAt: true,
              user: { select: { nickname: true, phone: true } },
            },
          },
        },
      }),
    ]);

    return {
      total,
      page,
      pageSize,
      device: {
        deviceId: device.deviceId,
        deviceCode: device.deviceCode,
        characterKey: device.characterKey,
      },
      items: rows.map((row) => ({
        reportDate: row.reportDate,
        generationStatus: row.generationStatus,
        expressionObservation: row.expressionObservation,
        emotionObservation: row.emotionObservation,
        thinkingObservation: row.thinkingObservation,
        suggestion: row.suggestion,
        generatorModel: row.generatorModel,
        generatedAt: row.generatedAt,
        feedbacks: row.feedbacks.map((feedback) => ({
          isUseful: feedback.isUseful,
          // feedbackAt 口径与反馈列表一致：updatedAt（家长可改票，取最新状态时间）
          feedbackAt: feedback.updatedAt,
          user: feedback.user,
        })),
      })),
    };
  }
}
