import { AdventureVideoQueueService } from "./adventure-video-queue.service";

function makeQueue() {
  const prisma = {
    adventureVideoJob: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
  };
  return {
    queue: new AdventureVideoQueueService(prisma as never),
    prisma,
  };
}

describe("AdventureVideoQueueService", () => {
  it("没有排队作业时返回 null", async () => {
    const { queue, prisma } = makeQueue();
    prisma.adventureVideoJob.findFirst.mockResolvedValue(null);
    await expect(queue.claimNext()).resolves.toBeNull();
  });

  it("抢占成功返回候选，状态条件更新防止重复领取", async () => {
    const { queue, prisma } = makeQueue();
    prisma.adventureVideoJob.findFirst.mockResolvedValue({
      id: "job1",
      attempts: 0,
    });
    prisma.adventureVideoJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(queue.claimNext()).resolves.toEqual({
      id: "job1",
      attempts: 0,
    });
    expect(prisma.adventureVideoJob.updateMany).toHaveBeenCalledWith({
      where: { id: "job1", status: "queued" },
      data: expect.objectContaining({
        status: "running",
        stage: "storyboard",
        errorCode: null,
      }),
    });
  });

  it("被别的 worker 抢先（count=0）时继续找下一条", async () => {
    const { queue, prisma } = makeQueue();
    prisma.adventureVideoJob.findFirst
      .mockResolvedValueOnce({ id: "job1", attempts: 0 })
      .mockResolvedValueOnce({ id: "job2", attempts: 0 })
      .mockResolvedValue(null);
    prisma.adventureVideoJob.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(queue.claimNext()).resolves.toEqual({
      id: "job2",
      attempts: 0,
    });
  });

  it("心跳与阶段只作用于 running 作业", async () => {
    const { queue, prisma } = makeQueue();
    prisma.adventureVideoJob.updateMany.mockResolvedValue({ count: 1 });
    await queue.heartbeat("job1");
    await queue.markStage("job1", "visual");
    expect(prisma.adventureVideoJob.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "job1", status: "running" },
      data: { heartbeatAt: expect.any(Date) },
    });
    expect(prisma.adventureVideoJob.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "job1", status: "running" },
      data: { stage: "visual", heartbeatAt: expect.any(Date) },
    });
  });

  it("TTS 完成后进入待审核：只认 running，写实测时长与文案指纹", async () => {
    const { queue, prisma } = makeQueue();
    prisma.adventureVideoJob.updateMany.mockResolvedValue({ count: 1 });

    await queue.awaitReview("job1", {
      voiceTextHash: "hash-1",
      voiceTotalSec: 57.2,
    });

    expect(prisma.adventureVideoJob.updateMany).toHaveBeenCalledWith({
      where: { id: "job1", status: "running" },
      data: expect.objectContaining({
        status: "awaiting_review",
        stage: "review",
        voiceTextHash: "hash-1",
        voiceTotalSec: 57.2,
        storyboardApprovedAt: null,
        heartbeatAt: null,
      }),
    });
  });

  it("超时回收：未达上限回 queued 并 attempts+1，达上限判失败", async () => {
    const { queue, prisma } = makeQueue();
    prisma.adventureVideoJob.findMany.mockResolvedValue([
      { id: "a", attempts: 0 },
      { id: "b", attempts: 2 },
    ]);
    prisma.adventureVideoJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(queue.recoverStale()).resolves.toBe(2);
    expect(prisma.adventureVideoJob.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "a", status: "running" },
      data: expect.objectContaining({
        status: "queued",
        heartbeatAt: null,
        attempts: { increment: 1 },
      }),
    });
    expect(prisma.adventureVideoJob.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "b", status: "running" },
      data: expect.objectContaining({
        status: "failed",
        errorCode: "STALE_TIMEOUT",
      }),
    });
  });

  it("成功收尾写实际成本并清心跳", async () => {
    const { queue, prisma } = makeQueue();
    prisma.adventureVideoJob.update.mockResolvedValue({});
    await queue.succeed("job1", { actualCostCents: 2700 });
    expect(prisma.adventureVideoJob.update).toHaveBeenCalledWith({
      where: { id: "job1" },
      data: expect.objectContaining({
        status: "succeeded",
        stage: "done",
        actualCostCents: 2700,
        heartbeatAt: null,
      }),
    });
  });

  it("失败收尾截断错误文案，避免超长堆进列", async () => {
    const { queue, prisma } = makeQueue();
    prisma.adventureVideoJob.update.mockResolvedValue({});
    await queue.fail("job1", "PROVIDER_ERROR", "x".repeat(800));
    const data = prisma.adventureVideoJob.update.mock.calls[0][0].data;
    expect(data.status).toBe("failed");
    expect(data.errorMessage).toHaveLength(500);
  });
});
