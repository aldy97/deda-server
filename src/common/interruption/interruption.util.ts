/**
 * 打断推断（方案 A：服务端推断口径，非设备真实事件）。
 *
 * 判定规则：新一轮对话开始时，若该设备上一轮 assistant 回复的
 * 估算播放窗口尚未结束，则认为孩子打断了上一轮播报。
 *
 * 估算口径（推断而非事实，dashboard 展示时须标注「疑似」）：
 * - 播放时长 ≈ content 字数 × INTERRUPT_MS_PER_CHAR（content 为播报全文
 *   filler+answer，与落库口径一致）；
 * - 窗口封顶 INTERRUPT_WINDOW_CAP_MS：长故事估算可达数分钟，
 *   孩子隔很久接话不应算打断；
 * - 只判 status=completed 的行：failed 行未完整播报，不重判；
 * - spokeAt 在未来（时钟漂移）或恰好播完（elapsed == 估算）均不算。
 */

/** 每字估算播放时长（TTS 中文语速经验值，可调） */
export const INTERRUPT_MS_PER_CHAR = 120;

/** 推断窗口封顶：超过此时长的历史一律不算打断 */
export const INTERRUPT_WINDOW_CAP_MS = 60_000;

/** 结构化入参：兼容 PrismaService 与测试 mock */
export interface InterruptionPrisma {
  message: {
    findFirst(args: {
      where: { deviceId: string; role: string; status: string };
      orderBy: { spokeAt: "desc" };
      select: { id: true; content: true; spokeAt: true };
    }): Promise<{ id: string; content: string; spokeAt: Date } | null>;
    update(args: {
      where: { id: string };
      data: { status: string };
    }): Promise<unknown>;
  };
}

/**
 * 若上一轮 assistant 回复推断仍在播放，标记为 interrupted。
 * @returns 被标记的消息 id；未标记返回 null
 */
export async function markPreviousReplyInterrupted(
  prisma: InterruptionPrisma,
  deviceInternalId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const last = await prisma.message.findFirst({
    where: {
      deviceId: deviceInternalId,
      role: "assistant",
      status: "completed",
    },
    orderBy: { spokeAt: "desc" },
    select: { id: true, content: true, spokeAt: true },
  });
  if (!last) return null;

  const elapsed = now.getTime() - last.spokeAt.getTime();
  if (elapsed < 0) return null;

  const playbackMs = Math.min(
    last.content.length * INTERRUPT_MS_PER_CHAR,
    INTERRUPT_WINDOW_CAP_MS,
  );
  if (elapsed >= playbackMs) return null;

  await prisma.message.update({
    where: { id: last.id },
    data: { status: "interrupted" },
  });
  return last.id;
}
