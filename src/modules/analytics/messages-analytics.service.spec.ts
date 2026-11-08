import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import { MessagesAnalyticsService } from "./messages-analytics.service";

type Row = Record<string, any>;

function buildPrisma(data: {
  devices?: Row[];
  messages?: Row[];
  message?: Row | null;
}) {
  return {
    device: {
      findUnique: jest.fn(({ where }: any) =>
        (data.devices ?? []).find((d) => d.deviceId === where.deviceId),
      ),
    },
    message: {
      count: jest.fn((_args?: any) => (data.messages ?? []).length),
      findMany: jest.fn((_args?: any) => data.messages ?? []),
      findUnique: jest.fn((_args?: any) => data.message ?? null),
    },
  };
}

async function buildService(prisma: unknown) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      MessagesAnalyticsService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return module.get(MessagesAnalyticsService);
}

describe("MessagesAnalyticsService", () => {
  it("deviceId 为业务 ID：resolve 成内部 UUID 再查 messages", async () => {
    const prisma = buildPrisma({
      devices: [{ id: "uuid-1", deviceId: "dev-biz-1" }],
      messages: [],
    });
    const service = await buildService(prisma);

    await service.listMessages({ deviceId: "dev-biz-1" });

    expect(prisma.device.findUnique).toHaveBeenCalledWith({
      where: { deviceId: "dev-biz-1" },
      select: { id: true },
    });
    const findManyArgs = prisma.message.findMany.mock.calls[0]?.[0] as any;
    expect(findManyArgs.where.deviceId).toBe("uuid-1");
  });

  it("业务 deviceId 不存在时返回空页", async () => {
    const prisma = buildPrisma({ devices: [], messages: [] });
    const service = await buildService(prisma);

    const result = await service.listMessages({ deviceId: "ghost" });

    expect(result).toEqual({ total: 0, page: 1, pageSize: 20, items: [] });
    expect(prisma.message.findMany).not.toHaveBeenCalled();
  });

  it("日期区间按 spokeAt 过滤，Asia/Shanghai 当日边界（+08:00）", async () => {
    const prisma = buildPrisma({ messages: [] });
    const service = await buildService(prisma);

    await service.listMessages({
      startDate: "2026-11-01",
      endDate: "2026-11-07",
    });

    const where = (prisma.message.count.mock.calls[0]?.[0] as any).where;
    expect(where.spokeAt.gte).toEqual(new Date("2026-11-01T00:00:00+08:00"));
    expect(where.spokeAt.lt).toEqual(new Date("2026-11-08T00:00:00+08:00"));
  });

  it("startDate 晚于 endDate 返回 400", async () => {
    const service = await buildService(buildPrisma({}));
    await expect(
      service.listMessages({
        startDate: "2026-11-08",
        endDate: "2026-11-01",
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("组合过滤：role/status/mode/conversationModeKey/turnId/conversationId/keyword", async () => {
    const prisma = buildPrisma({ messages: [] });
    const service = await buildService(prisma);

    await service.listMessages({
      role: "user",
      status: "completed",
      mode: "free_chat",
      conversationModeKey: "daily_life",
      turnId: "turn-1",
      conversationId: "conv-1",
      keyword: "小兔子",
    });

    const where = (prisma.message.count.mock.calls[0]?.[0] as any).where;
    expect(where).toMatchObject({
      role: "user",
      status: "completed",
      mode: "free_chat",
      conversationModeKey: "daily_life",
      turnId: "turn-1",
      conversationId: "conv-1",
      content: { contains: "小兔子", mode: "insensitive" },
    });
  });

  it("排序白名单：spokeAt_asc → asc，缺省 desc", async () => {
    const prisma = buildPrisma({ messages: [] });
    const service = await buildService(prisma);

    await service.listMessages({ sort: "spokeAt_asc" });
    await service.listMessages({});

    const calls = prisma.message.findMany.mock.calls;
    expect((calls[0]?.[0] as any).orderBy).toEqual({ spokeAt: "asc" });
    expect((calls[1]?.[0] as any).orderBy).toEqual({ spokeAt: "desc" });
  });

  it("列表项不含 rawPayload，device 只带展示字段；分页 skip/take 正确", async () => {
    const prisma = buildPrisma({
      messages: [
        {
          id: "m1",
          turnId: "t1",
          conversationId: null,
          role: "user",
          content: "你好",
          status: "completed",
          mode: "free_chat",
          conversationModeKey: "daily_life",
          cefrLevel: "A1",
          spokeAt: new Date("2026-11-07T12:34:56Z"),
          createdAt: new Date("2026-11-07T12:34:57Z"),
          device: {
            deviceId: "dev-biz-1",
            deviceCode: "DEDA-0001",
            characterKey: "elly",
          },
        },
      ],
    });
    const service = await buildService(prisma);

    const result = await service.listMessages({ page: 3, pageSize: 10 });

    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(10);
    const findManyArgs = prisma.message.findMany.mock.calls[0]?.[0] as any;
    expect(findManyArgs.skip).toBe(20);
    expect(findManyArgs.take).toBe(10);
    expect(findManyArgs.select.rawPayload).toBeUndefined();
    expect(result.items[0]).not.toHaveProperty("rawPayload");
    expect(result.items[0].device).toEqual({
      deviceId: "dev-biz-1",
      deviceCode: "DEDA-0001",
      characterKey: "elly",
    });
  });

  it("详情返回整行含 rawPayload", async () => {
    const prisma = buildPrisma({
      message: {
        id: "m1",
        rawPayload: { filler: "嗯", answer: "你好" },
        device: { deviceId: "dev-biz-1" },
      },
    });
    const service = await buildService(prisma);

    const row = await service.getMessage("m1");

    expect(row.rawPayload).toEqual({ filler: "嗯", answer: "你好" });
  });

  it("详情 id 不存在返回 404", async () => {
    const service = await buildService(buildPrisma({ message: null }));
    await expect(service.getMessage("ghost")).rejects.toThrow(
      NotFoundException,
    );
  });
});
