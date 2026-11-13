import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import { SleepConfigsService } from "@/modules/sleep-configs/sleep-configs.service";
import { isInSleepWindow } from "@/modules/sleep-configs/sleep-window.util";

export type ConversationIntent =
  | "free_chat"
  | "adventure_story"
  | "english_story"
  | "idiom_story"
  | "sleep_story"
  | "free_story"
  | "sleep_config";

type PersistentConversationMode = Extract<
  ConversationIntent,
  "english_story" | "idiom_story" | "sleep_story"
>;

const SESSION_TTL_MINUTES: Record<PersistentConversationMode, number> = {
  english_story: 20,
  idiom_story: 20,
  sleep_story: 45,
};

const CONVERSATION_INTENTS: ConversationIntent[] = [
  "free_chat",
  "adventure_story",
  "english_story",
  "idiom_story",
  "sleep_config",
  "sleep_story",
  "free_story",
];

/**
 * intent 的来源。排查「孩子说要听故事却在闲聊」时必须能区分成因：
 * - model：小模型输出合法标签
 * - fallback_invalid_label：模型有响应但标签非法 → 关键词兜底（prompt 退化信号）
 * - fallback_error：模型调用异常 → 关键词兜底（与 llm_usage_logs.failureReason 按 turnId 拼接可定位原因）
 * - pre_filter_skip：**已停用，仅历史数据**。前置关键词过滤（isRoutingCandidate）
 *   会把「我困了」这类不含词表字的语义整句拦在模型之外，已随语义识别改造移除；
 *   保留取值是为了让上线前的 turn_decision_logs 仍可正确分桶。
 * - continuation / explicit_exit：会话状态机接管，未调模型
 * - session_sticky：活跃会话中调了模型，但模型判为 free_chat → 维持原模式
 * - force_sleep：家长开了强制哄睡且在哄睡时段内，未调模型直接覆写为 sleep_story
 * - sleep_window_closed：模型判为 sleep_story 但当前不在哄睡时段 → 降级 free_chat
 */
export type IntentSource =
  | "model"
  | "fallback_invalid_label"
  | "fallback_error"
  | "pre_filter_skip"
  | "continuation"
  | "session_sticky"
  | "explicit_exit"
  | "force_sleep"
  | "sleep_window_closed";

export interface IntentDecision {
  intent: ConversationIntent;
  source: IntentSource;
}

/**
 * 时段判定只需要这三个字段。刻意用结构化窄类型而非 Prisma 的 SleepConfig，
 * 让本服务不与 sleep_configs 的列增减耦合。
 */
type SleepGateConfig = {
  enabled: boolean;
  forceSleep: boolean;
  sleepTime: string;
} | null;

@Injectable()
export class ConversationSessionService {
  private readonly logger = new Logger(ConversationSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
    private readonly sleepConfigs: SleepConfigsService,
  ) {}

  /**
   * 兼容签名：只返回 intent。老 WS 链路（vendor.service.ts）继续用这个。
   * 注意：强制哄睡与时段门禁实现在 resolveWithSource 内部，因此老链路的
   * 路由行为会一并变化（这是刻意的——两条链路必须同一套哄睡口径）；
   * 变的只是行为，签名与返回类型不变，且老链路仍不埋点。
   */
  async resolve(
    deviceId: string,
    asrText: string,
    turnId?: string,
  ): Promise<ConversationIntent> {
    const { intent } = await this.resolveWithSource(deviceId, asrText, turnId);
    return intent;
  }

  /**
   * 意图路由 + 决策来源。source 让「为什么是这个意图」可查。
   *
   * 决策顺序（前者命中即返回，后者不再评估）：
   * 1. 强制哄睡覆写：家长开了 enabled + forceSleep 且在哄睡时段内，
   *    孩子一开口即进 sleep_story。刻意排在最前，连显式退出与语音改设置
   *    都不放行——否则孩子一句「哄睡改成 23:50」就能把强制窗口压缩掉
   *    （applyVoiceUpdate 的类型白名单挡得住 forceSleep，挡不住 sleepTime）。
   *    「不说话就不主动发起」由链路本身保证：本服务只在收到话时被动触发。
   * 2. 活跃会话：续听 → 显式退出 → 其余一律交给模型做语义判定。
   * 3. 无活跃会话：每轮都调模型。前置关键词过滤已移除，它会把
   *    「我困了」「眼皮打架了」这类不含词表字的语义整句拦在模型之外。
   * 4. 哄睡时段门禁：模型判出 sleep_story 但当前不在时段内 → 降级 free_chat。
   *
   * 安全优先级不受影响：L1/L2 拦截在编排层（llm-adapter）先于本方法返回。
   */
  async resolveWithSource(
    deviceId: string,
    asrText: string,
    turnId?: string,
  ): Promise<IntentDecision> {
    const sleepConfig = await this.readSleepConfig(deviceId);

    if (this.isForceSleepActive(sleepConfig)) {
      await this.activate(deviceId, "sleep_story");
      return { intent: "sleep_story", source: "force_sleep" };
    }

    const sleepTime = sleepConfig?.sleepTime ?? null;
    const session = await this.prisma.conversationSession.findUnique({
      where: { deviceId },
    });
    const activeMode = this.persistentMode(session?.currentMode);

    if (session && activeMode) {
      if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) {
        await this.reset(deviceId);
      } else {
        if (this.isContinuation(asrText)) {
          await this.activate(deviceId, activeMode);
          return { intent: activeMode, source: "continuation" };
        }
        if (this.isExplicitExit(asrText)) {
          await this.reset(deviceId);
          return { intent: "free_chat", source: "explicit_exit" };
        }
        return this.classifySticky(
          deviceId,
          asrText,
          activeMode,
          sleepTime,
          turnId,
        );
      }
    }

    return this.classifyAndActivate(
      deviceId,
      asrText,
      false,
      sleepTime,
      turnId,
    );
  }

  async reset(deviceId: string): Promise<void> {
    await this.prisma.conversationSession.upsert({
      where: { deviceId },
      create: { deviceId, currentMode: "free_chat", expiresAt: null },
      update: { currentMode: "free_chat", expiresAt: null },
    });
  }

  /** 定时进入哄睡：无条件覆写会话为 sleep_story（45 分钟 TTL）。 */
  async activateSleepMode(deviceId: string): Promise<void> {
    await this.activate(deviceId, "sleep_story");
  }

  private async classifyAndActivate(
    deviceId: string,
    asrText: string,
    hadActiveSession: boolean,
    sleepTime: string | null,
    turnId?: string,
  ): Promise<IntentDecision> {
    const decision = await this.classify(asrText, deviceId, turnId);
    return this.applyDecision(deviceId, decision, hadActiveSession, sleepTime);
  }

  /**
   * 活跃会话内的语义判定：只有模型判为 free_chat 才维持原模式。
   * 这样「然后呢」「我喜欢恐龙」不会把故事打断，而「Elly 困了嘛」
   * 这类不含任何切换关键词的表达仍能真正切走——旧实现要求先命中
   * isExplicitModeSwitch 的动作词表才调模型，语义切换是假的。
   */
  private async classifySticky(
    deviceId: string,
    asrText: string,
    activeMode: PersistentConversationMode,
    sleepTime: string | null,
    turnId?: string,
  ): Promise<IntentDecision> {
    const decision = await this.classify(asrText, deviceId, turnId);
    if (decision.intent === "free_chat") {
      // 故事作答、二选一和普通接话默认留在当前模式，并滑动续期。
      await this.activate(deviceId, activeMode);
      return { intent: activeMode, source: "session_sticky" };
    }
    return this.applyDecision(deviceId, decision, true, sleepTime);
  }

  /** 门禁 → 会话写入 → 返回最终决策。两条分类路径共用，保证口径一致。 */
  private async applyDecision(
    deviceId: string,
    decision: IntentDecision,
    hadActiveSession: boolean,
    sleepTime: string | null,
  ): Promise<IntentDecision> {
    const gated = this.gateSleepWindow(decision, sleepTime);
    const persistentIntent = this.persistentMode(gated.intent);
    if (persistentIntent) {
      await this.activate(deviceId, persistentIntent);
    } else if (hadActiveSession) {
      await this.reset(deviceId);
    }
    return gated;
  }

  /**
   * 哄睡时段门禁：不在时段内就把 sleep_story 降级为 free_chat，
   * 由主模型自然共情回应（「有点困啦？」），而不是硬拒或强塞故事。
   * 只拦 sleep_story：sleep_config 是改设置（白天也该能改），
   * 其余故事意图与哄睡无关；free_story 白天照常讲。
   * 降级不写会话，避免白天误入后占用 45 分钟粘滞。
   */
  private gateSleepWindow(
    decision: IntentDecision,
    sleepTime: string | null,
  ): IntentDecision {
    if (decision.intent !== "sleep_story") return decision;
    if (isInSleepWindow(new Date(), sleepTime)) return decision;
    return { intent: "free_chat", source: "sleep_window_closed" };
  }

  /**
   * 读哄睡配置。失败一律按「无配置」处理：本方法在每轮对话的关键路径上，
   * 一次 DB 抖动不能让孩子听不到回复。
   */
  private async readSleepConfig(deviceId: string): Promise<SleepGateConfig> {
    try {
      return await this.sleepConfigs.getByDeviceId(deviceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Sleep config read failed, skip sleep gating: ${message}`,
      );
      return null;
    }
  }

  /**
   * 强制哄睡是否生效：enabled 与 forceSleep 双开关都开，且当前在哄睡时段内
   * （北京时间 sleepTime → 当日 24:00）。durationMinutes 是「哄睡内容播放时长」
   * 而非「时段长度」，刻意不参与边界计算——否则 21:30 + 10 分钟会让窗口只到
   * 21:40，21:45 说「我困了」反而不进哄睡。
   */
  private isForceSleepActive(
    config: SleepGateConfig,
    now: Date = new Date(),
  ): boolean {
    if (!config?.enabled || !config.forceSleep) return false;
    return isInSleepWindow(now, config.sleepTime);
  }

  private async classify(
    asrText: string,
    deviceId?: string,
    turnId?: string,
  ): Promise<IntentDecision> {
    try {
      const result = await this.llmService.complete({
        scene: "intent_classify",
        deviceId,
        turnId,
        model: this.llmService.smallModelName,
        temperature: 0,
        maxTokens: 10,
        messages: [
          {
            role: "system",
            content:
              "你是儿童语音产品的对话意图分类器。只输出一个标签，禁止解释：" +
              "free_chat（普通聊天）；adventure_story（每日互动冒险、续听或重听已播冒险）；" +
              "english_story（英语故事或英语口语陪练）；idiom_story（成语故事）；" +
              "sleep_config（修改哄睡设置，如调整哄睡时间、时长、内容偏好，" +
              "例如「以后睡前都听儿歌」「九点半哄我睡觉」「哄睡改成20分钟」）；" +
              "sleep_story（立刻进入哄睡、听睡前故事或儿歌，要求安静且不互动；" +
              "孩子表达困意或想休息也算，包括状态陈述、第三人称和撒娇式说法，" +
              "如「我困了」「Elly困了嘛」「眼皮打架了」「我好累想躺下」「进入睡眠模式」）；" +
              "free_story（泛化听故事或自由创作故事）。" +
              "修改设置与立刻进入的区别：含「以后/改成/换成/明天」等修改含义选 sleep_config；" +
              "「我要听睡前儿歌」这类立刻要听的选 sleep_story。" +
              "是否真的进入哄睡由服务端的时段门禁决定，你只负责判断孩子这句话的意图，" +
              "不要因为「现在还是白天」就把困意判成 free_chat。" +
              "孩子表达含糊时按字面选择最接近标签。",
          },
          { role: "user", content: `孩子的话：${asrText}` },
        ],
      });
      const text = result.text.trim().toLowerCase();
      const matched = CONVERSATION_INTENTS.find((intent) =>
        text.includes(intent),
      );
      if (matched) {
        return { intent: matched, source: "model" };
      }
      // 模型有响应但标签不在七标签契约内：走关键词兜底并单独标记，
      // 这样「模型判错」和「模型没响应」在看板上不会混成同一种 fallback。
      // 只记模型输出的标签片段，不记 asrText（PII 纪律）。
      this.logger.warn(
        `Conversation intent label not in contract, keyword fallback used: ${text.slice(0, 40)}`,
      );
      return {
        intent: this.fallbackIntent(asrText),
        source: "fallback_invalid_label",
      };
    } catch (error) {
      this.logger.warn(
        `Conversation intent classification failed, keyword fallback used: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        intent: this.fallbackIntent(asrText),
        source: "fallback_error",
      };
    }
  }

  private async activate(
    deviceId: string,
    currentMode: PersistentConversationMode,
  ): Promise<void> {
    const expiresAt = new Date(
      Date.now() + SESSION_TTL_MINUTES[currentMode] * 60_000,
    );
    await this.prisma.conversationSession.upsert({
      where: { deviceId },
      create: { deviceId, currentMode, expiresAt },
      update: { currentMode, expiresAt },
    });
  }

  private persistentMode(
    mode: string | null | undefined,
  ): PersistentConversationMode | null {
    return mode === "english_story" ||
      mode === "idiom_story" ||
      mode === "sleep_story"
      ? mode
      : null;
  }

  /**
   * 仅供关键词兜底使用（模型不可用时判断是否属于故事类请求）。
   * 前置准入过滤 isRoutingCandidate 已移除：它把「我困了」这类不含词表字的
   * 语义整句拦在小模型之外，是「说困了不进哄睡」的根因，扩词表治不了本。
   */
  private isStoryRequest(asrText: string): boolean {
    return /故事|冒险|风铃树|再听一遍|继续讲|接着讲|story|adventure/i.test(
      asrText,
    );
  }

  private isContinuation(asrText: string): boolean {
    return /^(继续|接着讲|继续讲|再讲一个|再来一个|接着来|continue|go on)[啊呀呢吧。！!，, ]*$/i.test(
      asrText.trim(),
    );
  }

  private isExplicitExit(asrText: string): boolean {
    return /不想听|不要听|不玩了|停止|退出|结束|别讲了|stop|quit|exit/i.test(
      asrText,
    );
  }

  private fallbackIntent(asrText: string): ConversationIntent {
    // 修改含义优先于进入含义：「哄睡改成20分钟」是 sleep_config 而非 sleep_story
    if (
      /以后|改成|换成|调成|改为/.test(asrText) &&
      /哄睡|睡前|睡觉|晚安|睡眠/.test(asrText)
    ) {
      return "sleep_config";
    }
    // 困意用「困了/好困/犯困」这类组合词而非单字「困」，否则「这道题好困难」
    // 会在模型不可用时被误判成哄睡。语义识别由小模型负责，这里只做最后兜底。
    if (
      /哄睡|睡前|儿歌|睡觉|晚安|睡眠|困了|好困|很困|太困|困死|犯困|眯|哈欠|sleep/i.test(
        asrText,
      )
    ) {
      return "sleep_story";
    }
    if (/英语|英文|english/i.test(asrText)) {
      return "english_story";
    }
    if (/成语|idiom/i.test(asrText)) {
      return "idiom_story";
    }
    if (/冒险|风铃树|再听一遍|继续.*故事|接着.*故事/i.test(asrText)) {
      return "adventure_story";
    }
    return this.isStoryRequest(asrText) ? "free_story" : "free_chat";
  }
}
