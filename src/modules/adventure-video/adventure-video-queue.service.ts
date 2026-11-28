import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";

const STALE_HEARTBEAT_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;

/**
 * 数据库队列。
 *
 * 不引入 BullMQ/Redis 作为真相：作业必须能在 Redis 全挂、进程重启后继续。
 * 抢占用「先查后带状态条件更新」——多 worker 同时抢只有 count=1 的那个赢，
 * 输了就继续找下一个，不需要 SELECT ... FOR UPDATE。
 */
@Injectable()
export class AdventureVideoQueueService {
  constructor(private readonly prisma: PrismaService) {}

  /** 领取一条排队作业；没有则返回 null。 */
  async claimNext(): Promise<{ id: string; attempts: number } | null> {
    for (let round = 0; round < 3; round += 1) {
      const candidate = await this.prisma.adventureVideoJob.findFirst({
        where: { status: "queued" },
        orderBy: { createdAt: "asc" },
        select: { id: true, attempts: true },
      });
      if (!candidate) return null;
      const now = new Date();
      const claimed = await this.prisma.adventureVideoJob.updateMany({
        where: { id: candidate.id, status: "queued" },
        data: {
          status: "running",
          stage: "storyboard",
          startedAt: now,
          heartbeatAt: now,
          errorCode: null,
          errorMessage: null,
        },
      });
      if (claimed.count === 1) return candidate;
    }
    return null;
  }

  async heartbeat(jobId: string): Promise<void> {
    await this.prisma.adventureVideoJob.updateMany({
      where: { id: jobId, status: "running" },
      data: { heartbeatAt: new Date() },
    });
  }

  async markStage(jobId: string, stage: string): Promise<void> {
    await this.prisma.adventureVideoJob.updateMany({
      where: { id: jobId, status: "running" },
      data: { stage, heartbeatAt: new Date() },
    });
  }

  /**
   * TTS 完成后暂停，等 superadmin 审核分镜与实测时长。
   * 只认 running：worker 被回收/取消后不再把作业拉回审核态。
   */
  async awaitReview(
    jobId: string,
    input: { voiceTextHash: string; voiceTotalSec: number },
  ): Promise<void> {
    await this.prisma.adventureVideoJob.updateMany({
      where: { id: jobId, status: "running" },
      data: {
        status: "awaiting_review",
        stage: "review",
        voiceTextHash: input.voiceTextHash,
        voiceTotalSec: input.voiceTotalSec,
        storyboardApprovedAt: null,
        storyboardApprovedBy: null,
        heartbeatAt: null,
      },
    });
  }

  async succeed(
    jobId: string,
    input: { actualCostCents: number },
  ): Promise<void> {
    await this.prisma.adventureVideoJob.update({
      where: { id: jobId },
      data: {
        status: "succeeded",
        stage: "done",
        actualCostCents: input.actualCostCents,
        finishedAt: new Date(),
        heartbeatAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
  }

  async fail(
    jobId: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    await this.prisma.adventureVideoJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        errorCode,
        errorMessage: errorMessage.slice(0, 500),
        finishedAt: new Date(),
        heartbeatAt: null,
      },
    });
  }

  /**
   * 回收心跳超时的作业。attempts 达上限直接判失败，避免「永远卡在 running」
   * 把整个队列堵死。
   */
  async recoverStale(olderThanMs = STALE_HEARTBEAT_MS): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stale = await this.prisma.adventureVideoJob.findMany({
      where: {
        status: "running",
        OR: [{ heartbeatAt: { lt: cutoff } }, { heartbeatAt: null }],
      },
      select: { id: true, attempts: true },
    });
    for (const job of stale) {
      const exhausted = job.attempts >= MAX_ATTEMPTS - 1;
      await this.prisma.adventureVideoJob.updateMany({
        where: { id: job.id, status: "running" },
        data: exhausted
          ? {
              status: "failed",
              errorCode: "STALE_TIMEOUT",
              errorMessage: "worker 心跳超时，已达最大重试次数",
              finishedAt: new Date(),
              heartbeatAt: null,
            }
          : {
              status: "queued",
              stage: "queued",
              heartbeatAt: null,
              startedAt: null,
              attempts: { increment: 1 },
              errorCode: null,
              errorMessage: null,
            },
      });
    }
    return stale.length;
  }
}
