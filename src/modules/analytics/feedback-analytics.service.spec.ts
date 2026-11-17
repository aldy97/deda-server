import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import { FeedbackAnalyticsService } from "./feedback-analytics.service";

type Row = Record<string, any>;

function buildPrisma(data: {
  parentReportFeedbacks?: Row[];
  feedbacks?: Row[];
  device?: Row | null;
  boundUserIds?: string[];
}) {
  return {
    device: {
      findUnique: jest.fn((_args?: any) =>
        Promise.resolve(data.device ?? null),
      ),
    },
    userDeviceBinding: {
      findMany: jest.fn((_args?: any) =>
        Promise.resolve(
          (data.boundUserIds ?? []).map((userId) => ({ userId })),
        ),
      ),
    },
    parentReportFeedback: {
      count: jest.fn(
        (_args?: any) => (data.parentReportFeedbacks ?? []).length,
      ),
      findMany: jest.fn((_args?: any) => data.parentReportFeedbacks ?? []),
      groupBy: jest.fn((_args?: any) => [
        { isUseful: true, _count: { _all: 3 } },
        { isUseful: false, _count: { _all: 1 } },
      ]),
    },
    feedback: {
      count: jest.fn((_args?: any) => (data.feedbacks ?? []).length),
      findMany: jest.fn((_args?: any) => data.feedbacks ?? []),
    },
  };
}

async function buildService(prisma: unknown) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      FeedbackAnalyticsService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return module.get(FeedbackAnalyticsService);
}

describe("FeedbackAnalyticsService", () => {
  describe("listParentReportFeedbacks", () => {
    it("映射 user/device 与 feedbackAt=updatedAt，按 updatedAt 倒序分页", async () => {
      const updatedAt = new Date("2026-11-01T08:00:00Z");
      const prisma = buildPrisma({
        parentReportFeedbacks: [
          {
            id: "f1",
            reportDate: "2026-10-31",
            isUseful: true,
            updatedAt,
            user: { nickname: "熊妈", phone: "138****0000" },
            report: {
              reportDate: "2026-10-31",
              generationStatus: "completed",
              expressionObservation: "主动用了三个新单词",
              emotionObservation: null,
              thinkingObservation: null,
              suggestion: "多鼓励开口",
              generatedAt: new Date("2026-11-01T00:30:00Z"),
              device: {
                deviceId: "dev-1",
                deviceCode: "DEDA-001",
                characterKey: "elly",
              },
            },
          },
        ],
      });
      const service = await buildService(prisma);

      const result = await service.listParentReportFeedbacks({
        page: 2,
        pageSize: 10,
      });

      expect(result.total).toBe(1);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(10);
      expect(result.items[0]).toEqual({
        id: "f1",
        reportDate: "2026-10-31",
        isUseful: true,
        feedbackAt: updatedAt,
        user: { nickname: "熊妈", phone: "138****0000" },
        device: {
          deviceId: "dev-1",
          deviceCode: "DEDA-001",
          characterKey: "elly",
        },
        // 反馈对应的日报内容（同 reportDate 同设备）
        report: {
          reportDate: "2026-10-31",
          generationStatus: "completed",
          expressionObservation: "主动用了三个新单词",
          emotionObservation: null,
          thinkingObservation: null,
          suggestion: "多鼓励开口",
          generatedAt: new Date("2026-11-01T00:30:00Z"),
        },
      });
      const findManyArgs = prisma.parentReportFeedback.findMany.mock
        .calls[0]?.[0] as any;
      expect(findManyArgs.orderBy).toEqual({ updatedAt: "desc" });
      expect(findManyArgs.skip).toBe(10);
      expect(findManyArgs.take).toBe(10);
    });

    it("日期区间按 reportDate 过滤；isUseful 只过滤列表不影响 summary", async () => {
      const prisma = buildPrisma({});
      const service = await buildService(prisma);

      const result = await service.listParentReportFeedbacks({
        startDate: "2026-10-01",
        endDate: "2026-10-31",
        isUseful: true,
      });

      const countArgs = prisma.parentReportFeedback.count.mock
        .calls[0]?.[0] as any;
      expect(countArgs.where).toEqual({
        reportDate: { gte: "2026-10-01", lte: "2026-10-31" },
        isUseful: true,
      });
      const groupByArgs = prisma.parentReportFeedback.groupBy.mock
        .calls[0]?.[0] as any;
      expect(groupByArgs.where).toEqual({
        reportDate: { gte: "2026-10-01", lte: "2026-10-31" },
      });
      // summary 来自 mock：useful 3 / notUseful 1 → 0.75
      expect(result.summary).toEqual({
        usefulCount: 3,
        notUsefulCount: 1,
        usefulRate: 0.75,
      });
    });

    it("区间内无反馈时 usefulRate 为 0", async () => {
      const prisma = buildPrisma({});
      prisma.parentReportFeedback.groupBy.mockReturnValue([]);
      const service = await buildService(prisma);

      const result = await service.listParentReportFeedbacks({});

      expect(result.summary).toEqual({
        usefulCount: 0,
        notUsefulCount: 0,
        usefulRate: 0,
      });
    });

    it("缺省分页为 page=1 pageSize=20", async () => {
      const prisma = buildPrisma({});
      const service = await buildService(prisma);

      const result = await service.listParentReportFeedbacks({});

      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      const findManyArgs = prisma.parentReportFeedback.findMany.mock
        .calls[0]?.[0] as any;
      expect(findManyArgs.skip).toBe(0);
      expect(findManyArgs.take).toBe(20);
    });
  });

  describe("listUserFeedbacks", () => {
    it("映射字段；用户已注销时 user 为 null", async () => {
      const createdAt = new Date("2026-11-05T02:00:00Z");
      const prisma = buildPrisma({
        feedbacks: [
          {
            id: "fb1",
            content: "希望增加儿歌内容",
            contact: "wx-user-01",
            createdAt,
            user: { nickname: "乐乐妈", phone: null },
          },
          {
            id: "fb2",
            content: "匿名反馈",
            contact: null,
            createdAt,
            user: null,
          },
        ],
      });
      const service = await buildService(prisma);

      const result = await service.listUserFeedbacks({});

      expect(result.total).toBe(2);
      expect(result.items[0]).toEqual({
        id: "fb1",
        content: "希望增加儿歌内容",
        contact: "wx-user-01",
        createdAt,
        user: { nickname: "乐乐妈", phone: null },
      });
      expect(result.items[1].user).toBeNull();
      const findManyArgs = prisma.feedback.findMany.mock.calls[0]?.[0] as any;
      expect(findManyArgs.orderBy).toEqual({ createdAt: "desc" });
    });

    it("hasContact=true 过滤 null 和空串联系方式", async () => {
      const prisma = buildPrisma({});
      const service = await buildService(prisma);

      await service.listUserFeedbacks({ hasContact: true });

      const countArgs = prisma.feedback.count.mock.calls[0]?.[0] as any;
      expect(countArgs.where.AND).toEqual([
        { contact: { not: null } },
        { contact: { not: "" } },
      ]);
    });

    it("日期区间按 createdAt 过滤，endDate 含全天", async () => {
      const prisma = buildPrisma({});
      const service = await buildService(prisma);

      await service.listUserFeedbacks({
        startDate: "2026-10-01",
        endDate: "2026-10-31",
      });

      const countArgs = prisma.feedback.count.mock.calls[0]?.[0] as any;
      expect(countArgs.where.createdAt.gte).toEqual(
        new Date("2026-10-01T00:00:00"),
      );
      const expectedEnd = new Date("2026-10-31T00:00:00");
      expectedEnd.setDate(expectedEnd.getDate() + 1);
      expect(countArgs.where.createdAt.lt).toEqual(expectedEnd);
    });
  });

  describe("listParentReportFeedbacks deviceId 过滤", () => {
    it("业务 deviceId resolve 成内部 UUID 后过滤（含 count 与 groupBy）", async () => {
      const prisma = buildPrisma({
        device: { id: "internal-uuid-1", deviceId: "dev-1" },
      });
      const service = await buildService(prisma);

      await service.listParentReportFeedbacks({ deviceId: "dev-1" });

      expect(prisma.device.findUnique).toHaveBeenCalledWith({
        where: { deviceId: "dev-1" },
        select: { id: true },
      });
      const countArgs = prisma.parentReportFeedback.count.mock
        .calls[0]?.[0] as any;
      expect(countArgs.where.deviceId).toBe("internal-uuid-1");
      const groupByArgs = prisma.parentReportFeedback.groupBy.mock
        .calls[0]?.[0] as any;
      expect(groupByArgs.where.deviceId).toBe("internal-uuid-1");
    });

    it("设备不存在 → 空页且 summary 清零，不查反馈表", async () => {
      const prisma = buildPrisma({ device: null });
      const service = await buildService(prisma);

      const result = await service.listParentReportFeedbacks({
        deviceId: "no-such-device",
      });

      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
      expect(result.summary).toEqual({
        usefulCount: 0,
        notUsefulCount: 0,
        usefulRate: 0,
      });
      expect(prisma.parentReportFeedback.findMany).not.toHaveBeenCalled();
    });
  });

  describe("listUserFeedbacks deviceId 过滤", () => {
    it("经绑定关系反查 userIds 过滤（该设备全部绑定账号的反馈）", async () => {
      const prisma = buildPrisma({
        device: { id: "internal-uuid-1", deviceId: "dev-1" },
        boundUserIds: ["user-1", "user-2"],
      });
      const service = await buildService(prisma);

      await service.listUserFeedbacks({ deviceId: "dev-1" });

      expect(prisma.userDeviceBinding.findMany).toHaveBeenCalledWith({
        where: { deviceId: "internal-uuid-1" },
        select: { userId: true },
      });
      const countArgs = prisma.feedback.count.mock.calls[0]?.[0] as any;
      expect(countArgs.where.userId).toEqual({ in: ["user-1", "user-2"] });
    });

    it("设备无绑定用户 → 空页，不查反馈表", async () => {
      const prisma = buildPrisma({
        device: { id: "internal-uuid-1", deviceId: "dev-1" },
        boundUserIds: [],
      });
      const service = await buildService(prisma);

      const result = await service.listUserFeedbacks({ deviceId: "dev-1" });

      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
      expect(prisma.feedback.findMany).not.toHaveBeenCalled();
    });

    it("设备不存在 → 空页，不查反馈表", async () => {
      const prisma = buildPrisma({ device: null });
      const service = await buildService(prisma);

      const result = await service.listUserFeedbacks({
        deviceId: "no-such-device",
      });

      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
      expect(prisma.feedback.findMany).not.toHaveBeenCalled();
    });
  });
});
