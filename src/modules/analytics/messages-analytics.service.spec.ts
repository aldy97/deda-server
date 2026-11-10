import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import { MessagesAnalyticsService } from "./messages-analytics.service";

type Row = Record<string, any>;

function buildPrisma(data: {
  devices?: Row[];
  messages?: Row[];
  message?: Row | null;
  categories?: Row[];
  groups?: Row[];
  countImpl?: (where: any) => number;
}) {
  return {
    device: {
      findUnique: jest.fn(({ where }: any) =>
        (data.devices ?? []).find((d) => d.deviceId === where.deviceId),
      ),
    },
    message: {
      count: jest.fn(({ where }: any) =>
        Promise.resolve(
          data.countImpl ? data.countImpl(where) : (data.messages ?? []).length,
        ),
      ),
      findMany: jest.fn((_args?: any) => data.messages ?? []),
      findUnique: jest.fn((_args?: any) => data.message ?? null),
      groupBy: jest.fn((_args?: any) => Promise.resolve(data.groups ?? [])),
    },
    conversationModeCategory: {
      findMany: jest.fn((_args?: any) =>
        Promise.resolve(data.categories ?? []),
      ),
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

  describe("getModes", () => {
    const categories = [
      {
        key: "free_chat",
        name: "自由对话",
        sortOrder: 1,
        modes: [
          { key: "free_chat_casual", name: "日常闲聊", sortOrder: 1 },
          { key: "free_chat_curious", name: "好奇探索", sortOrder: 2 },
        ],
      },
      {
        key: "english_chat",
        name: "英语角",
        sortOrder: 2,
        modes: [
          { key: "english_chat_beginner", name: "启蒙对话", sortOrder: 1 },
        ],
      },
    ];

    it("返回配置表全量分类与子模式，并标注区间内消息数", async () => {
      const prisma = buildPrisma({
        categories,
        groups: [
          {
            mode: "free_chat",
            conversationModeKey: "free_chat_casual",
            _count: { _all: 10 },
          },
          {
            mode: "free_chat",
            conversationModeKey: "free_chat_curious",
            _count: { _all: 3 },
          },
          {
            mode: "english_chat",
            conversationModeKey: null,
            _count: { _all: 5 },
          },
        ],
      });
      const service = await buildService(prisma);

      const result = await service.getModes({});

      const freeChat = result.categories.find((c) => c.key === "free_chat");
      // 分类计数 = 该顶层模式下全部消息（含无子模式的）
      expect(freeChat?.messageCount).toBe(13);
      expect(freeChat?.modes).toEqual([
        { key: "free_chat_casual", name: "日常闲聊", messageCount: 10 },
        { key: "free_chat_curious", name: "好奇探索", messageCount: 3 },
      ]);
      const english = result.categories.find((c) => c.key === "english_chat");
      expect(english?.messageCount).toBe(5);
      expect(english?.modes[0].messageCount).toBe(0);

      // 只取启用项，按 sortOrder 排
      const findArgs = prisma.conversationModeCategory.findMany.mock
        .calls[0][0] as any;
      expect(findArgs.where).toEqual({ isActive: true });
      expect(findArgs.orderBy).toEqual({ sortOrder: "asc" });
      expect(findArgs.include.modes).toEqual({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
      });
    });

    it("区间过滤按 spokeAt 传给 groupBy（Asia/Shanghai 边界）", async () => {
      const prisma = buildPrisma({ categories: [], groups: [] });
      const service = await buildService(prisma);

      await service.getModes({
        startDate: "2026-11-01",
        endDate: "2026-11-07",
      });

      const where = (prisma.message.groupBy.mock.calls[0]?.[0] as any).where;
      expect(where.spokeAt.gte).toEqual(new Date("2026-11-01T00:00:00+08:00"));
      expect(where.spokeAt.lt).toEqual(new Date("2026-11-08T00:00:00+08:00"));
    });

    it("startDate 晚于 endDate 返回 400", async () => {
      const service = await buildService(buildPrisma({}));
      await expect(
        service.getModes({ startDate: "2026-11-08", endDate: "2026-11-01" }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getInterruptionRate", () => {
    it("分母为 assistant 消息总数，分子为 interrupted，附 byMode 分组", async () => {
      const prisma = buildPrisma({
        countImpl: (where) => (where.status === "interrupted" ? 3 : 40),
        groups: [
          { mode: "free_chat", status: "completed", _count: { _all: 28 } },
          { mode: "free_chat", status: "interrupted", _count: { _all: 2 } },
          { mode: "english_chat", status: "completed", _count: { _all: 9 } },
          { mode: "english_chat", status: "interrupted", _count: { _all: 1 } },
        ],
      });
      const service = await buildService(prisma);

      const result = await service.getInterruptionRate({});

      expect(result.assistantTotal).toBe(40);
      expect(result.interrupted).toBe(3);
      expect(result.interruptionRate).toBe(0.075);
      // 统计只看 assistant 消息
      const countWhere = (prisma.message.count.mock.calls[0]?.[0] as any).where;
      expect(countWhere.role).toBe("assistant");
      expect(result.byMode).toEqual([
        {
          mode: "free_chat",
          assistantTotal: 30,
          interrupted: 2,
          interruptionRate: 0.0667,
        },
        {
          mode: "english_chat",
          assistantTotal: 10,
          interrupted: 1,
          interruptionRate: 0.1,
        },
      ]);
    });

    it("区间内无 assistant 消息时比率为 null", async () => {
      const prisma = buildPrisma({ countImpl: () => 0, groups: [] });
      const service = await buildService(prisma);

      const result = await service.getInterruptionRate({});

      expect(result).toEqual({
        assistantTotal: 0,
        interrupted: 0,
        interruptionRate: null,
        byMode: [],
      });
    });

    it("区间过滤按 spokeAt 透传（Asia/Shanghai 边界）", async () => {
      const prisma = buildPrisma({ countImpl: () => 0, groups: [] });
      const service = await buildService(prisma);

      await service.getInterruptionRate({
        startDate: "2026-11-01",
        endDate: "2026-11-07",
      });

      const where = (prisma.message.count.mock.calls[0]?.[0] as any).where;
      expect(where.spokeAt.gte).toEqual(new Date("2026-11-01T00:00:00+08:00"));
      expect(where.spokeAt.lt).toEqual(new Date("2026-11-08T00:00:00+08:00"));
    });
  });
});
