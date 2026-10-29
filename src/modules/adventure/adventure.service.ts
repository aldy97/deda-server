import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import {
  AdventureDailyRecord,
  AdventureProgress,
  AdventureSegment,
} from "@prisma/client";

export interface AdventureReply {
  /** 依序播报文本（接话/兜底/原文段） */
  texts: string[];
  action: "narrate" | "await_reply" | "completed" | "exit";
  /** 本轮交互处置结果；开集/续播等非交互回复为 undefined。 */
  result?: "answered" | "off_topic" | "fallback" | "exit" | "timeout";
}

interface InteractionChoice {
  key: string;
  text: string;
  reply: string;
}

/** 沉默超时：引导词最后一个 chunk ack 后 10s 无上行则兜底续播 */
const REPLY_TIMEOUT_MS = 10000;

/** 明确拒绝关键词（命中即温柔退出，进度保留当天可续玩） */
const REFUSAL_KEYWORDS = ["不要听", "不想听", "不想玩", "不玩了", "不要玩了"];

/** 设备角色决定选集与互动接话人设；未知旧数据回落 Elly。 */
const CHARACTER_PERSONAS: Record<string, string> = {
  elly: "小象 Elly：听风原野的居民，性格温暖好奇，说话轻声细语，喜欢用「呀」「呢」结尾，爱鼓励孩子。",
  polly:
    "小马 Polly：听风原野的居民，性格开朗勇敢，说话活泼简洁，喜欢邀请孩子一起尝试，也爱鼓励孩子。",
};

/**
 * 冒险引擎：故事是数据不是 prompt。
 * 状态机推进、旁白原文直出；小模型仅在开放交互点/首次跑题引回时接话。
 * 主线推进权永远在引擎，孩子的回答只影响接话句，不改变故事走向。
 */
@Injectable()
export class AdventureService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdventureService.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private timeoutListener:
    | ((
        deviceInternalId: string,
        reply: AdventureReply,
      ) => void | Promise<void>)
    | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
  ) {}

  onModuleInit() {
    // 内存定时器之外的持久化兜底，覆盖重启与漏触发。
    this.sweepTimer = setInterval(() => {
      void this.sweepTimeouts().catch((error) => {
        this.logger.error(
          `Adventure timeout sweep failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, 2000);
    this.sweepTimer.unref();
  }

  onModuleDestroy() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const deviceId of this.timers.keys()) {
      this.clearTimer(deviceId);
    }
  }

  /** vendor 层注册：超时兜底产生回复时的回调（负责 chunk 上传与落库） */
  registerTimeoutListener(
    listener: (
      deviceInternalId: string,
      reply: AdventureReply,
    ) => void | Promise<void>,
  ) {
    this.timeoutListener = listener;
  }

  private dateKey(date = new Date()): string {
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${mm}-${dd}`;
  }

  /** 今日是否已经完成任意一集；这是所有冒险入口的确定性门禁。 */
  async isCompletedToday(deviceInternalId: string): Promise<boolean> {
    const record = await this.prisma.adventureDailyRecord.findFirst({
      where: {
        deviceId: deviceInternalId,
        status: "completed",
        completedDate: this.dateKey(),
      },
      select: { id: true },
    });
    return !!record;
  }

  private findCurrentDaily(deviceInternalId: string) {
    return this.prisma.adventureDailyRecord.findFirst({
      where: { deviceId: deviceInternalId, status: "in_progress" },
      orderBy: { assignedAt: "desc" },
    });
  }

  private async findCurrentAdventure(deviceInternalId: string): Promise<{
    daily: AdventureDailyRecord;
    progress: AdventureProgress;
  } | null> {
    const daily = await this.findCurrentDaily(deviceInternalId);
    if (!daily) {
      return null;
    }
    const progress = await this.prisma.adventureProgress.findUnique({
      where: {
        deviceId_episodeId: {
          deviceId: deviceInternalId,
          episodeId: daily.episodeId,
        },
      },
    });
    return progress ? { daily, progress } : null;
  }

  private loadSegments(episodeId: string) {
    return this.prisma.adventureSegment.findMany({
      where: { episodeId },
      orderBy: { order: "asc" },
    });
  }

  private async getCharacterKey(deviceInternalId: string): Promise<string> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceInternalId },
      select: { characterKey: true },
    });
    return device?.characterKey || "elly";
  }

  /**
   * 开集/续玩。每天只能完成一集；未完成集跨天仍保留，完集日计入当天额度。
   * 集顺序只用于个人进度，不要求剧情连续，也不因其他孩子进度而改变。
   */
  async startToday(
    deviceInternalId: string,
    explicitlyRequested = false,
  ): Promise<AdventureReply | null> {
    if (await this.isCompletedToday(deviceInternalId)) {
      return null;
    }

    const current = await this.findCurrentAdventure(deviceInternalId);
    if (current) {
      const { daily, progress } = current;
      if (progress.status === "exited" && !explicitlyRequested) {
        return null;
      }
      if (progress.status === "exited") {
        await this.prisma.adventureEvent.create({
          data: {
            eventKey: `daily:${daily.id}:resumed:${Date.now()}`,
            deviceId: deviceInternalId,
            episodeId: daily.episodeId,
            dailyRecordId: daily.id,
            eventType: "resumed",
          },
        });
      }
      // 中断续玩：只恢复已分配的同一集，不重播 recap。
      const segments = await this.loadSegments(progress.episodeId);
      return this.playFrom(progress, segments, [], daily);
    }

    const characterKey = await this.getCharacterKey(deviceInternalId);
    const [episodes, progresses] = await Promise.all([
      this.prisma.adventureEpisode.findMany({
        where: { characterKey, season: 1 },
        orderBy: { episodeNumber: "asc" },
      }),
      this.prisma.adventureProgress.findMany({
        where: {
          deviceId: deviceInternalId,
          episode: { characterKey, season: 1 },
        },
        select: { episodeId: true, status: true },
      }),
    ]);
    const completedEpisodeIds = new Set(
      progresses
        .filter((progress) => progress.status === "completed")
        .map((progress) => progress.episodeId),
    );
    const episode = episodes.find((item) => !completedEpisodeIds.has(item.id));
    // 未发布的下一集是内容边界：停止，不跳过它播后面的集。
    if (!episode || !episode.published) {
      return null;
    }

    const { daily, progress } = await this.prisma.$transaction(async (tx) => {
      const daily = await tx.adventureDailyRecord.create({
        data: {
          deviceId: deviceInternalId,
          episodeId: episode.id,
          assignedDate: this.dateKey(),
          status: "in_progress",
        },
      });
      const progress = await tx.adventureProgress.create({
        data: {
          deviceId: deviceInternalId,
          episodeId: episode.id,
          status: "in_progress",
        },
      });
      await tx.adventureEvent.create({
        data: {
          eventKey: `daily:${daily.id}:assigned`,
          deviceId: deviceInternalId,
          episodeId: episode.id,
          dailyRecordId: daily.id,
          eventType: "daily_assigned",
        },
      });
      await tx.adventureEvent.create({
        data: {
          eventKey: `daily:${daily.id}:started`,
          deviceId: deviceInternalId,
          episodeId: episode.id,
          dailyRecordId: daily.id,
          eventType: "started",
        },
      });
      return { daily, progress };
    });
    const segments = await this.loadSegments(episode.id);
    const prefix = episode.recap ? [episode.recap] : [];
    return this.playFrom(progress, segments, prefix, daily);
  }

  /**
   * 从 nextSegmentOrder 起连播旁白，直到交互点（等待）或完集。
   * reward 型交互点：播完即发星光并继续，不进入等待。
   */
  private async playFrom(
    progress: AdventureProgress,
    segments: AdventureSegment[],
    prefix: string[],
    daily: AdventureDailyRecord,
  ): Promise<AdventureReply> {
    const texts = [...prefix];
    let order = progress.nextSegmentOrder;
    let stars = progress.stars;

    for (const segment of segments) {
      if (segment.order < order) {
        continue;
      }
      texts.push(segment.text);
      order = segment.order + 1;

      if (segment.kind !== "interaction") {
        continue;
      }
      if (segment.interactionType === "reward") {
        if (segment.rewardStar) {
          stars += 1;
        }
        continue; // 奖励原语不需要孩子回答
      }

      // 先进入等待态；上传方在最后一个 chunk ack 后调用 markPromptPlaybackComplete。
      await this.prisma.adventureProgress.update({
        where: { id: progress.id },
        data: {
          nextSegmentOrder: order,
          status: "awaiting_reply",
          waitingSince: null,
          stars,
          offTopicCount: 0,
        },
      });
      return { texts, action: "await_reply" };
    }

    // 没有更多交互点：完集（或续玩时仅剩旁白）
    const isDone = order >= segments.length;
    this.clearTimer(progress.deviceId);
    if (isDone) {
      const completedAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        await tx.adventureProgress.update({
          where: { id: progress.id },
          data: {
            nextSegmentOrder: order,
            status: "completed",
            waitingSince: null,
            stars,
            completedAt,
          },
        });
        await tx.adventureDailyRecord.update({
          where: { id: daily.id },
          data: {
            status: "completed",
            completedAt,
            completedDate: this.dateKey(completedAt),
          },
        });
        await tx.adventureEvent.upsert({
          where: { eventKey: `daily:${daily.id}:completed` },
          update: {},
          create: {
            eventKey: `daily:${daily.id}:completed`,
            deviceId: progress.deviceId,
            episodeId: progress.episodeId,
            dailyRecordId: daily.id,
            eventType: "completed",
            segmentOrder: order,
            payload: { stars },
          },
        });
      });
    } else {
      await this.prisma.adventureProgress.update({
        where: { id: progress.id },
        data: {
          nextSegmentOrder: order,
          status: "in_progress",
          waitingSince: null,
          stars,
        },
      });
    }
    return { texts, action: isDone ? "completed" : "narrate" };
  }

  /** 引导词最后一个 chunk 已 ack：从此时开始计算孩子的 10s 回答窗口。 */
  async markPromptPlaybackComplete(deviceInternalId: string): Promise<void> {
    const current = await this.findCurrentAdventure(deviceInternalId);
    if (!current || current.progress.status !== "awaiting_reply") {
      return;
    }
    const { progress } = current;
    await this.prisma.adventureProgress.update({
      where: { id: progress.id },
      data: { waitingSince: new Date() },
    });
    this.scheduleTimeout(deviceInternalId);
  }

  /** 当前等待回答的交互点（已播，order = nextSegmentOrder - 1） */
  private currentInteraction(
    progress: AdventureProgress,
    segments: AdventureSegment[],
  ) {
    return segments.find((s) => s.order === progress.nextSegmentOrder - 1);
  }

  /**
   * 孩子在交互等待中的回答：五类处置。
   * 非等待态返回 null（不接管上行）。
   */
  async handleChildReply(
    deviceInternalId: string,
    asrText: string,
  ): Promise<AdventureReply | null> {
    const current = await this.findCurrentAdventure(deviceInternalId);
    if (!current || current.progress.status !== "awaiting_reply") {
      return null;
    }
    const { daily, progress } = current;
    this.clearTimer(deviceInternalId);

    const segments = await this.loadSegments(progress.episodeId);
    const interaction = this.currentInteraction(progress, segments);
    if (!interaction) {
      return null;
    }

    // 明确拒绝：温柔退出，每日档案与进度保留，之后只能续玩这一集。
    if (REFUSAL_KEYWORDS.some((kw) => asrText.includes(kw))) {
      await this.prisma.adventureProgress.update({
        where: { id: progress.id },
        data: { status: "exited", waitingSince: null },
      });
      return {
        texts: [interaction.exitText || "好呀，那我们下次接着玩。"],
        action: "exit",
        result: "exit",
      };
    }

    if (interaction.interactionType === "two_choice") {
      return this.handleTwoChoice(
        deviceInternalId,
        daily,
        progress,
        segments,
        interaction,
        asrText,
      );
    }
    if (interaction.interactionType === "repeat_after_me") {
      // ASR 粗匹配即可，以鼓励为主，不苛求发音
      const options = interaction.options as unknown as {
        praise?: string;
      } | null;
      const praise = options?.praise || "说得真好！给你鼓掌！";
      const reply = await this.playFrom(progress, segments, [praise], daily);
      return { ...reply, result: "answered" };
    }
    // open_question：小模型接话（含正常/跑题/超前发挥），失败降级兜底
    const bridge = await this.generateBridge(
      deviceInternalId,
      interaction,
      asrText,
      "open_question",
    );
    const reply = await this.playFrom(progress, segments, [bridge], daily);
    return { ...reply, result: "answered" };
  }

  private async handleTwoChoice(
    deviceInternalId: string,
    daily: AdventureDailyRecord,
    progress: AdventureProgress,
    segments: AdventureSegment[],
    interaction: AdventureSegment,
    asrText: string,
  ): Promise<AdventureReply> {
    const options = interaction.options as unknown as {
      choices?: InteractionChoice[];
    } | null;
    const choices = options?.choices || [];
    const matched = choices.find(
      (c) => asrText.includes(c.text) || asrText.includes(c.key),
    );

    if (matched) {
      if (interaction.rewardStar) {
        progress.stars += 1;
      }
      const reply = await this.playFrom(
        progress,
        segments,
        [matched.reply],
        daily,
      );
      return { ...reply, result: "answered" };
    }

    // 首次跑题：小模型接住 + 轻引回一次，仍停在该交互点，不推进主线
    if (progress.offTopicCount === 0) {
      const redirect = await this.generateBridge(
        deviceInternalId,
        interaction,
        asrText,
        "redirect",
      );
      await this.prisma.adventureProgress.update({
        where: { id: progress.id },
        data: { offTopicCount: 1, waitingSince: null },
      });
      return { texts: [redirect], action: "await_reply", result: "off_topic" };
    }

    // 第二次跑题：预生成兜底话术推进，不再引回、不调 LLM
    const reply = await this.playFrom(
      progress,
      segments,
      [interaction.fallbackText || "没关系，我们继续吧。"],
      daily,
    );
    return { ...reply, result: "fallback" };
  }

  /** 小模型接话；失败降级为兜底话术，保证绝不卡死 */
  private async generateBridge(
    deviceInternalId: string,
    interaction: AdventureSegment,
    asrText: string,
    kind: "open_question" | "redirect",
  ): Promise<string> {
    try {
      const characterKey = await this.getCharacterKey(deviceInternalId);
      const characterPersona =
        CHARACTER_PERSONAS[characterKey] || CHARACTER_PERSONAS.elly;
      const result = await this.llmService.complete({
        messages: this.llmService.buildAdventureInteractionPrompt({
          characterPersona,
          segmentText: interaction.text,
          childReply: asrText,
          kind,
        }),
        model: this.llmService.smallModelName,
        maxTokens: 80,
      });
      return result.text || interaction.fallbackText || "我们继续吧。";
    } catch (error) {
      this.logger.warn(
        `Adventure bridge LLM failed, fallback used: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return interaction.fallbackText || "没关系，我们继续吧。";
    }
  }

  /**
   * 10s 沉默超时检查：到点未收到该设备上行则兜底续播。
   * 终点判定 = 我方收到 vendor:text:in 的时间（由调用方先取消等待）。
   */
  async checkTimeout(deviceInternalId: string): Promise<AdventureReply | null> {
    const current = await this.findCurrentAdventure(deviceInternalId);
    if (
      !current ||
      current.progress.status !== "awaiting_reply" ||
      !current.progress.waitingSince
    ) {
      return null;
    }
    const { daily, progress } = current;
    if (Date.now() - progress.waitingSince.getTime() < REPLY_TIMEOUT_MS) {
      return null; // 未超时：竞态下以先到的上行为准
    }

    const segments = await this.loadSegments(progress.episodeId);
    const interaction = this.currentInteraction(progress, segments);
    const fallback = interaction?.fallbackText || "没关系，我们继续吧。";
    this.clearTimer(deviceInternalId);
    const reply = await this.playFrom(progress, segments, [fallback], daily);
    return { ...reply, result: "timeout" };
  }

  /** 播报完成后追加审计事件；ASR 与播报全文只保留在 Message。 */
  async recordPresented(
    deviceInternalId: string,
    turnId: string,
    reply: AdventureReply,
  ): Promise<void> {
    const daily = await this.prisma.adventureDailyRecord.findFirst({
      where: { deviceId: deviceInternalId },
      orderBy: { assignedAt: "desc" },
    });
    if (!daily) {
      return;
    }
    const base = {
      deviceId: deviceInternalId,
      episodeId: daily.episodeId,
      dailyRecordId: daily.id,
      turnId,
    };
    await this.prisma.adventureEvent.upsert({
      where: { eventKey: `turn:${turnId}:segments_presented` },
      update: {},
      create: {
        ...base,
        eventKey: `turn:${turnId}:segments_presented`,
        eventType: "segments_presented",
        payload: { action: reply.action, textCount: reply.texts.length },
      },
    });
    if (reply.result) {
      await this.prisma.adventureEvent.upsert({
        where: { eventKey: `turn:${turnId}:result:${reply.result}` },
        update: {},
        create: {
          ...base,
          eventKey: `turn:${turnId}:result:${reply.result}`,
          eventType: reply.result,
        },
      });
    }
  }

  /** 今日完成后，记录一次被门禁拦截的冒险入口及实际路由。 */
  async recordEntryBlocked(
    deviceInternalId: string,
    targetMode: string,
  ): Promise<void> {
    const daily = await this.prisma.adventureDailyRecord.findFirst({
      where: {
        deviceId: deviceInternalId,
        status: "completed",
        completedDate: this.dateKey(),
      },
      orderBy: { completedAt: "desc" },
    });
    if (!daily) {
      return;
    }
    const suffix = `${targetMode}:${Date.now()}`;
    const base = {
      deviceId: deviceInternalId,
      episodeId: daily.episodeId,
      dailyRecordId: daily.id,
      payload: { targetMode },
    };
    await this.prisma.adventureEvent.create({
      data: {
        ...base,
        eventKey: `daily:${daily.id}:entry_blocked:${suffix}`,
        eventType: "entry_blocked_completed",
      },
    });
    await this.prisma.adventureEvent.create({
      data: {
        ...base,
        eventKey: `daily:${daily.id}:routed_other_mode:${suffix}`,
        eventType: "routed_other_mode",
      },
    });
  }

  /** 重启恢复/漏网兜底：扫描所有超时等待记录并补触发 */
  async sweepTimeouts(): Promise<
    Array<{ deviceId: string; reply: AdventureReply }>
  > {
    const stale = await this.prisma.adventureProgress.findMany({
      where: {
        status: "awaiting_reply",
        waitingSince: {
          lte: new Date(Date.now() - REPLY_TIMEOUT_MS),
        },
      },
    });
    const recovered: Array<{ deviceId: string; reply: AdventureReply }> = [];
    for (const record of stale) {
      const reply = await this.checkTimeout(record.deviceId);
      if (reply) {
        recovered.push({ deviceId: record.deviceId, reply });
        await this.timeoutListener?.(record.deviceId, reply);
      }
    }
    return recovered;
  }

  private scheduleTimeout(deviceInternalId: string) {
    this.clearTimer(deviceInternalId);
    const timer = setTimeout(async () => {
      try {
        const reply = await this.checkTimeout(deviceInternalId);
        if (reply && this.timeoutListener) {
          await this.timeoutListener(deviceInternalId, reply);
        }
      } catch (error) {
        this.logger.error(
          `Adventure timeout fired failed for ${deviceInternalId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }, REPLY_TIMEOUT_MS);
    // 不阻塞进程退出（测试与停机友好）
    timer.unref();
    this.timers.set(deviceInternalId, timer);
  }

  private clearTimer(deviceInternalId: string) {
    const timer = this.timers.get(deviceInternalId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(deviceInternalId);
    }
  }
}
