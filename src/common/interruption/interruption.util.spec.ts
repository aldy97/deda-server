import {
  INTERRUPT_MS_PER_CHAR,
  INTERRUPT_WINDOW_CAP_MS,
  markPreviousReplyInterrupted,
} from "./interruption.util";

interface MockMessage {
  id: string;
  content: string;
  spokeAt: Date;
  status: string;
}

function buildPrisma(lastMessage: MockMessage | null) {
  return {
    message: {
      findFirst: jest.fn(() => Promise.resolve(lastMessage)),
      update: jest.fn(() => Promise.resolve({})),
    },
  };
}

const NOW = new Date("2026-11-10T12:00:00.000Z");

describe("markPreviousReplyInterrupted（方案 A：服务端推断）", () => {
  it("上一轮 assistant 仍在估算播放窗口内 → 标记 interrupted 并返回 id", async () => {
    // 100 字 ≈ 12s 播放；2s 前发出 → 被打断
    const prisma = buildPrisma({
      id: "m1",
      content: "啊".repeat(100),
      spokeAt: new Date(NOW.getTime() - 2000),
      status: "completed",
    });

    const marked = await markPreviousReplyInterrupted(
      prisma,
      "device-uuid-1",
      NOW,
    );

    expect(marked).toBe("m1");
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { status: "interrupted" },
    });
  });

  it("只查 completed 的 assistant 行（failed 不重判）", async () => {
    const prisma = buildPrisma(null);

    await markPreviousReplyInterrupted(prisma, "device-uuid-1", NOW);

    expect(prisma.message.findFirst).toHaveBeenCalledWith({
      where: {
        deviceId: "device-uuid-1",
        role: "assistant",
        status: "completed",
      },
      orderBy: { spokeAt: "desc" },
      select: { id: true, content: true, spokeAt: true },
    });
  });

  it("没有历史 assistant 消息 → 不动", async () => {
    const prisma = buildPrisma(null);

    const marked = await markPreviousReplyInterrupted(
      prisma,
      "device-uuid-1",
      NOW,
    );

    expect(marked).toBeNull();
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it("播放估算时长已过 → 不算打断", async () => {
    // 10 字 ≈ 1.2s 播放；5s 前发出 → 已播完
    const prisma = buildPrisma({
      id: "m1",
      content: "啊".repeat(10),
      spokeAt: new Date(NOW.getTime() - 5000),
      status: "completed",
    });

    const marked = await markPreviousReplyInterrupted(
      prisma,
      "device-uuid-1",
      NOW,
    );

    expect(marked).toBeNull();
    expect(prisma.message.update).not.toHaveBeenCalled();
  });

  it("超出窗口上限（长文本）→ 不算打断", async () => {
    // 2000 字估算 240s，但窗口封顶 60s；70s 前发出 → 不算打断
    const prisma = buildPrisma({
      id: "m1",
      content: "啊".repeat(2000),
      spokeAt: new Date(NOW.getTime() - 70_000),
      status: "completed",
    });

    const marked = await markPreviousReplyInterrupted(
      prisma,
      "device-uuid-1",
      NOW,
    );

    expect(marked).toBeNull();
  });

  it("恰好播完（elapsed == 估算时长）→ 不算打断", async () => {
    const chars = 50;
    const prisma = buildPrisma({
      id: "m1",
      content: "啊".repeat(chars),
      spokeAt: new Date(NOW.getTime() - chars * INTERRUPT_MS_PER_CHAR),
      status: "completed",
    });

    const marked = await markPreviousReplyInterrupted(
      prisma,
      "device-uuid-1",
      NOW,
    );

    expect(marked).toBeNull();
  });

  it("spokeAt 在未来（时钟漂移）→ 不算打断", async () => {
    const prisma = buildPrisma({
      id: "m1",
      content: "啊".repeat(100),
      spokeAt: new Date(NOW.getTime() + 1000),
      status: "completed",
    });

    const marked = await markPreviousReplyInterrupted(
      prisma,
      "device-uuid-1",
      NOW,
    );

    expect(marked).toBeNull();
  });

  it("窗口上限常量小于长故事估算时长", () => {
    // 守护口径：600 字故事估算 72s > 60s 封顶，超长文本不会无限扩大窗口
    expect(600 * INTERRUPT_MS_PER_CHAR).toBeGreaterThan(
      INTERRUPT_WINDOW_CAP_MS,
    );
  });
});
