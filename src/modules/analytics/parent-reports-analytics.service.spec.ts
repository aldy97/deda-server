import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { ParentReportsAnalyticsService } from "./parent-reports-analytics.service";

type Row = Record<string, any>;

function buildPrisma(data: { device?: Row | null; reports?: Row[] }) {
  return {
    device: {
      findUnique: jest.fn((_args?: any) =>
        Promise.resolve(data.device ?? null),
      ),
    },
    parentReport: {
      count: jest.fn((_args?: any) => (data.reports ?? []).length),
      findMany: jest.fn((_args?: any) => Promise.resolve(data.reports ?? [])),
    },
  };
}

async function buildService(prisma: unknown) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ParentReportsAnalyticsService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return module.get(ParentReportsAnalyticsService);
}

describe("ParentReportsAnalyticsService", () => {
  it("设备不存在 → 404", async () => {
    const prisma = buildPrisma({ device: null });
    const service = await buildService(prisma);

    await expect(
      service.listByDevice({ deviceId: "no-such-device" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.parentReport.findMany).not.toHaveBeenCalled();
  });

  it("业务 deviceId resolve 成内部 UUID；返回设备信息 + 按 reportDate 倒序的日报", async () => {
    const generatedAt = new Date("2026-11-01T00:30:00Z");
    const prisma = buildPrisma({
      device: {
        id: "internal-uuid-1",
        deviceId: "dev-1",
        deviceCode: "DEDA-001",
        characterKey: "elly",
      },
      reports: [
        {
          reportDate: "2026-10-31",
          generationStatus: "completed",
          expressionObservation: "主动用了三个新单词",
          emotionObservation: null,
          thinkingObservation: null,
          suggestion: "多鼓励开口",
          generatorModel: "deepseek-chat",
          generatedAt,
          feedbacks: [],
        },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.listByDevice({ deviceId: "dev-1" });

    expect(prisma.device.findUnique).toHaveBeenCalledWith({
      where: { deviceId: "dev-1" },
      select: {
        id: true,
        deviceId: true,
        deviceCode: true,
        characterKey: true,
      },
    });
    expect(result.device).toEqual({
      deviceId: "dev-1",
      deviceCode: "DEDA-001",
      characterKey: "elly",
    });
    expect(result.total).toBe(1);
    expect(result.items[0]).toEqual({
      reportDate: "2026-10-31",
      generationStatus: "completed",
      expressionObservation: "主动用了三个新单词",
      emotionObservation: null,
      thinkingObservation: null,
      suggestion: "多鼓励开口",
      generatorModel: "deepseek-chat",
      generatedAt,
      feedbacks: [],
    });
    const findManyArgs = prisma.parentReport.findMany.mock.calls[0]?.[0] as any;
    expect(findManyArgs.where).toEqual({ deviceId: "internal-uuid-1" });
    expect(findManyArgs.orderBy).toEqual({ reportDate: "desc" });
  });

  it("业务 deviceId resolve 成内部 UUID；返回设备信息 + 按 reportDate 倒序的日报", async () => {
    const generatedAt = new Date("2026-11-01T00:30:00Z");
    const feedbackAt = new Date("2026-11-01T08:00:00Z");
    const prisma = buildPrisma({
      device: {
        id: "internal-uuid-1",
        deviceId: "dev-1",
        deviceCode: "DEDA-001",
        characterKey: "elly",
      },
      reports: [
        {
          reportDate: "2026-10-31",
          generationStatus: "completed",
          expressionObservation: "主动用了三个新单词",
          emotionObservation: null,
          thinkingObservation: null,
          suggestion: "多鼓励开口",
          generatorModel: "deepseek-chat",
          generatedAt,
          // 一条日报可被多个绑定家长分别评价 → feedbacks 为数组
          feedbacks: [
            {
              isUseful: true,
              updatedAt: feedbackAt,
              user: { nickname: "熊妈", phone: "138****0000" },
            },
            {
              isUseful: false,
              updatedAt: feedbackAt,
              user: { nickname: null, phone: null },
            },
          ],
        },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.listByDevice({ deviceId: "dev-1" });

    expect(result.items[0].feedbacks).toEqual([
      {
        isUseful: true,
        feedbackAt,
        user: { nickname: "熊妈", phone: "138****0000" },
      },
      {
        isUseful: false,
        feedbackAt,
        user: { nickname: null, phone: null },
      },
    ]);
  });

  it("日报无反馈 → feedbacks 为空数组（前端渲染 —）", async () => {
    const prisma = buildPrisma({
      device: { id: "internal-uuid-1", deviceId: "dev-1" },
      reports: [
        {
          reportDate: "2026-10-31",
          generationStatus: "completed",
          expressionObservation: null,
          emotionObservation: null,
          thinkingObservation: null,
          suggestion: null,
          generatorModel: null,
          generatedAt: null,
          feedbacks: [],
        },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.listByDevice({ deviceId: "dev-1" });

    expect(result.items[0].feedbacks).toEqual([]);
  });

  it("分页参数传递（缺省 page=1 pageSize=20）", async () => {
    const prisma = buildPrisma({
      device: { id: "internal-uuid-1", deviceId: "dev-1" },
    });
    const service = await buildService(prisma);

    const result = await service.listByDevice({
      deviceId: "dev-1",
      page: 2,
      pageSize: 10,
    });

    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(10);
    const findManyArgs = prisma.parentReport.findMany.mock.calls[0]?.[0] as any;
    expect(findManyArgs.skip).toBe(10);
    expect(findManyArgs.take).toBe(10);
  });
});
