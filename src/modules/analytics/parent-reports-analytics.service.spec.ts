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
    });
    const findManyArgs = prisma.parentReport.findMany.mock.calls[0]?.[0] as any;
    expect(findManyArgs.where).toEqual({ deviceId: "internal-uuid-1" });
    expect(findManyArgs.orderBy).toEqual({ reportDate: "desc" });
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
