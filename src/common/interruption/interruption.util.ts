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

/** 落库时判定入参：兼容 PrismaService 与测试 mock */
export interface NewerTurnQueryPrisma {
  message: {
    findFirst(args: {
      where: { deviceId: string; role: string; spokeAt: { gt: Date } };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

/**
 * 落库时打断判定（方案 A 补覆盖）：assistant 回复生成完毕准备落库时，
 * 若该设备已存在更新的 user 消息（本轮 LLM 生成期间孩子又开口），
 * 说明回复未及完整播报即被打断，调用方应落库为 interrupted 而非 completed。
 *
 * 与 markPreviousReplyInterrupted 互补，两者共同覆盖完整时间线：
 * - 本函数覆盖「LLM 生成期间被打断」：新一轮到达时 assistant 行尚不存在，
 *   markPreviousReplyInterrupted 查不到它，标记落空；
 * - markPreviousReplyInterrupted 覆盖「已落库 completed、TTS 播放中被打断」。
 *
 * 单调收敛约定：所有路径只把 status 推向 interrupted / failed，
 * 任何路径都不会把 interrupted 改回 completed。
 */
export async function wasSupersededByNewerTurn(
  prisma: NewerTurnQueryPrisma,
  deviceInternalId: string,
  turnUserSpokeAt: Date,
): Promise<boolean> {
  const newer = await prisma.message.findFirst({
    where: {
      deviceId: deviceInternalId,
      role: "user",
      // 严格大于：排除本轮自身（同刻时钟下自身 spokeAt 不命中 gt）
      spokeAt: { gt: turnUserSpokeAt },
    },
    select: { id: true },
  });
  return newer !== null;
}
