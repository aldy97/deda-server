import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  ASR_TEXT_MAX_LENGTH,
  DEFAULT_TURN_CHANNEL,
  type TurnDecisionRecord,
} from "./turn-decision.types";

/**
 * 对话轮次「判定质量」审计落库器。
 *
 * 与 llm.service 的 LlmUsageLog 埋点分工：那张表回答「模型调用健康吗」，
 * 本表回答「模型的判定可信吗」。安全场景下这两件事必须分开——
 * 小模型超时 fail-open 在用量表里是一次 success=false，但在判定表里是一次
 * 「本轮实际没做语义安全审查」，两者混在一张表里算不出漏放率。
 *
 * 三条硬约束：
 * 1. fire-and-forget：不 await、异常只 warn。判定审计永远不能阻塞或打断对话，
 *    口径与 llm.service 的用量落库一致。
 * 2. PII 纪律：asrText 是儿童语音转写，只在「拦了」或「判成非 safe 类别」时落库，
 *    供人工复核；任何日志（含落库失败的 warn）都不得携带。
 * 3. upsert on turnId 幂等：主模型重试同一轮时覆写为最后一次结论，不产生第二行，
 *    否则拦截率与 fallback 率的分母会被重试灌水。
 */
@Injectable()
export class TurnDecisionRecorder {
  private readonly logger = new Logger(TurnDecisionRecorder.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 记录一轮判定。同步返回 void，调用方无需（也不应）await。
   * turnId 缺失时静默丢弃：没有幂等键就无法保证不写重复行。
   */
  record(entry: TurnDecisionRecord): void {
    if (!entry.turnId) return;

    const safety = entry.safety ?? null;
    const safetyBlocked = safety?.blocked ?? false;
    const safetyCategory = safety?.category ?? null;
    const row = {
      deviceId: entry.deviceId ?? null,
      channel: entry.channel ?? DEFAULT_TURN_CHANNEL,
      safetyLayer: safety?.layer ?? null,
      safetyCategory,
      safetyBlocked,
      safetySource: safety?.source ?? entry.safetySource ?? "not_evaluated",
      safetyMatched: safety?.matched ?? null,
      intent: entry.intent ?? null,
      intentSource: entry.intentSource ?? null,
      asrText: this.storableAsrText(entry, safetyBlocked, safetyCategory),
    };

    this.prisma.turnDecisionLog
      .upsert({
        where: { turnId: entry.turnId },
        // turnId 是唯一键，create 带上、update 刻意不带：改幂等键会让重试变成插新行
        create: { turnId: entry.turnId, ...row },
        update: row,
      })
      .then(
        () => undefined,
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(`Turn decision log write failed: ${message}`);
        },
      );
  }

  /**
   * 只有需要人工复核的轮次才留原文：被拦截，或被判成 safe 以外的类别
   * （含 emotional_harm——它不拦截但会注入共情引导，属行为改变点，要看模型判得准不准）。
   * 判 safe、标签非法、模型异常、未评估这几类放行轮次不留原文，正常流量不积累儿童语料。
   */
  private storableAsrText(
    entry: TurnDecisionRecord,
    safetyBlocked: boolean,
    safetyCategory: string | null,
  ): string | null {
    const reviewable =
      safetyBlocked || (safetyCategory !== null && safetyCategory !== "safe");
    if (!reviewable || !entry.asrText) return null;
    return entry.asrText.slice(0, ASR_TEXT_MAX_LENGTH);
  }
}
