import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import { MessagesAnalyticsService } from "./messages-analytics.service";

type Row = Record<string, any>;

function buildPrisma(data: {
  devices?: Row[];
  messages?: Row[];
  message?: Row | null;
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

  it("组合过滤：role/status/mode/turnId/conversationId/keyword", async () => {
    const prisma = buildPrisma({ messages: [] });
    const service = await buildService(prisma);

    await service.listMessages({
      role: "user",
      status: "completed",
      mode: "free_chat",
      turnId: "turn-1",
      conversationId: "conv-1",
      keyword: "小兔子",
    });

    const where = (prisma.message.count.mock.calls[0]?.[0] as any).where;
    expect(where).toMatchObject({
      role: "user",
      status: "completed",
      mode: "free_chat",
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
    it("should return all 7 writable modes with key/name/messageCount shape", async () => {
      const prisma = buildPrisma({
        groups: [
          { mode: "free_chat", _count: { _all: 13 } },
          { mode: "english_chat", _count: { _all: 5 } },
        ],
      });
      const service = await buildService(prisma);

      const result = await service.getModes({});

      expect(result.modes).toHaveLength(7);
      // 有数据的模式
      expect(result.modes).toContainEqual({
        key: "free_chat",
        name: "自由对话",
        messageCount: 13,
      });
      expect(result.modes).toContainEqual({
        key: "english_chat",
        name: "英语对话",
        messageCount: 5,
      });
      // 无数据但仍返回
      expect(result.modes).toContainEqual({
        key: "adventure_story",
        name: "每日冒险",
        messageCount: 0,
      });
    });

    it("区间过滤按 spokeAt 传给 groupBy（Asia/Shanghai 边界）", async () => {
      const prisma = buildPrisma({ groups: [] });
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

    it("should sort by messageCount desc then key asc for ties", async () => {
      const prisma = buildPrisma({
        groups: [
          { mode: "free_chat", _count: { _all: 5 } },
          { mode: "idiom_story", _count: { _all: 10 } },
          { mode: "english_story", _count: { _all: 5 } },
          { mode: "sleep_story", _count: { _all: 10 } },
        ],
      });
      const service = await buildService(prisma);

      const result = await service.getModes({});

      const keys = result.modes.map((m) => m.key);
      // 10 的在前，同 10 → key asc: idiom_story < sleep_story
      // 5 的在后，同 5 → key asc: english_story < free_chat
      // 0 的最后，key asc
      expect(keys.indexOf("idiom_story")).toBeLessThan(
        keys.indexOf("sleep_story"),
      );
      expect(keys.indexOf("idiom_story")).toBeLessThan(
        keys.indexOf("free_chat"),
      );
      expect(keys.indexOf("english_story")).toBeLessThan(
        keys.indexOf("free_chat"),
      );
    });

    it("区间内出现过的 legacy mode 追加返回，name 不在表里就回落 key 原文", async () => {
      const prisma = buildPrisma({
        groups: [
          { mode: "free_chat", _count: { _all: 3 } },
          { mode: "daily_adventure", _count: { _all: 8 } },
          { mode: "music", _count: { _all: 1 } },
          { mode: null, _count: { _all: 99 } },
        ],
      });
      const service = await buildService(prisma);

      const result = await service.getModes({});

      // 7 个可写入 mode + daily_adventure + music = 9；mode 为 null 的分组不进结果
      expect(result.modes).toHaveLength(9);
      expect(result.modes).toContainEqual({
        key: "daily_adventure",
        name: "daily_adventure",
        messageCount: 8,
      });
      expect(result.modes).toContainEqual({
        key: "music",
        name: "music",
        messageCount: 1,
      });
      // legacy 一样参与排序：8 条的 daily_adventure 排在 3 条的 free_chat 前面
      const keys: string[] = result.modes.map((m) => m.key);
      expect(keys.indexOf("daily_adventure")).toBeLessThan(
        keys.indexOf("free_chat"),
      );
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
