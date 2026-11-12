import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID, timingSafeEqual } from "crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { markPreviousReplyInterrupted } from "@/common/interruption/interruption.util";
import {
  LlmService,
  LlmMessage,
  LlmUpstreamError,
} from "@/modules/llm/llm.service";
import { ChildMemoriesService } from "@/modules/child-memories/child-memories.service";
import {
  ConversationIntent,
  ConversationSessionService,
} from "@/modules/vendor/conversation-session.service";
import { SleepConfigsService } from "@/modules/sleep-configs/sleep-configs.service";
import { SleepVoiceConfigService } from "@/modules/sleep-configs/sleep-voice-config.service";
import {
  AdventureReply,
  AdventureService,
} from "@/modules/adventure/adventure.service";
import {
  BlockedSafetyCategory,
  ChildSafetyService,
} from "@/modules/vendor/child-safety.service";
import { TurnDecisionRecorder } from "@/modules/turn-decision/turn-decision-recorder.service";
import { TurnIntentDecision } from "@/modules/turn-decision/turn-decision.types";
import { ChatCompletionRequest } from "./dto/chat-completion.dto";

/** 上游故障时的兜底话术：保证设备端有声音，不让孩子面对沉默。
 *  按设备角色 keyed，为 Polly 等后续批次预留判断余地；
 *  角色文案未上线前一律回落 elly 文案 */
const UPSTREAM_FALLBACK_TEXTS: Record<string, string> = {
  elly: "小象 Elly 刚刚走神啦，再说一次好不好呀？",
};
const DEFAULT_UPSTREAM_FALLBACK_TEXT = UPSTREAM_FALLBACK_TEXTS.elly;

function resolveUpstreamFallbackText(characterKey?: string | null): string {
  return (
    (characterKey != null && UPSTREAM_FALLBACK_TEXTS[characterKey]) ||
    DEFAULT_UPSTREAM_FALLBACK_TEXT
  );
}

/** 历史轮数上限：防爆上下文（最近 10 轮一问一答） */
const MAX_HISTORY_TURNS = 10;

/** 落库历史条数上限：与老链路 getRecentHistory 口径一致（12 条 ≈ 6 轮） */
const DB_HISTORY_LIMIT = 12;

const BLOCKED_CATEGORIES: BlockedSafetyCategory[] = [
  "sexual",
  "violence",
  "self_harm",
];

const MAC_PATTERN =
  /^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$|^[0-9a-fA-F]{12}$/;

/** 故事类意图 → 顶层模式快照（对齐老链路 handleTextIn 的 mode 决策） */
const STORY_INTENTS: ConversationIntent[] = [
  "english_story",
  "idiom_story",
  "sleep_story",
];

/**
 * LLM 适配服务：承接百度 RTC 的 OpenAI 兼容回调。
 *
 * 编排（对齐 vendor 老链路 handleTextIn，老 WS 链路保持冻结作备份）：
 * Bearer 鉴权 → 设备解析（header 优先，其次 deviceid，fallback user 字段）
 * → L1 安全闸 → 冒险等待态接管 → L2 分类 + 意图路由并行
 * → sleep_config 确定性短链路 → 冒险每日门禁/开集
 * → mode 决策 → DB 历史 → user 落库 → 异步记忆提取 → 记忆注入
 * → 流式 filler（小模型打哈哈，头部校验后即播）→ 主模型流 → assistant 落库。
 *
 * 与老链路的原理性降级（已确认接受）：
 * - 冒险 10s 沉默超时推送：新链路无服务器推送通道，交互点无限期等孩子
 *   下一句话。适配层绝不调用 markPromptPlaybackComplete /
 *   registerTimeoutListener（waitingSince 不落，超时扫描自动跳过）。
 * - 21:30 定时哄睡进入同理不可用。
 *
 * 无设备标识时降级为匿名链路：不落库、无记忆、无意图路由、无冒险、
 * 固定 free_chat、用客户端历史。
 */
@Injectable()
export class LlmAdapterService {
  private readonly logger = new Logger(LlmAdapterService.name);
  private readonly apiKey?: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly llmService: LlmService,
    private readonly childSafety: ChildSafetyService,
    private readonly childMemories: ChildMemoriesService,
    private readonly conversationSession: ConversationSessionService,
    private readonly sleepVoiceConfig: SleepVoiceConfigService,
    private readonly sleepConfigs: SleepConfigsService,
    private readonly adventure: AdventureService,
    private readonly prisma: PrismaService,
    private readonly turnDecisions: TurnDecisionRecorder,
  ) {
    this.apiKey = this.configService.get<string>("LLM_ADAPTER_API_KEY");
    if (!this.apiKey) {
      this.logger.warn(
        "LLM_ADAPTER_API_KEY is not configured; all adapter requests will be rejected",
      );
    }
  }

  /**
   * 校验 Authorization: Bearer <token>，时序安全比较，token 不落日志。
   */
  validateToken(authorization?: string): boolean {
    if (!this.apiKey) return false;
    const match = /^Bearer\s+(.+)$/.exec(authorization ?? "");
    if (!match) return false;
    const given = Buffer.from(match[1]);
    const expected = Buffer.from(this.apiKey);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  assertToken(authorization?: string): void {
    if (!this.validateToken(authorization)) {
      throw new UnauthorizedException("invalid api key");
    }
  }

  /**
   * 生成回复文本流。L1/L2 命中与上游首 chunk 前故障都会转为兜底文本流，
   * 保证对百度侧永远是"成功的流式响应"。
   *
   * @param deviceHint 显式设备标识（X-Deda-Device-Id header），
   *                   优先于请求体 user 字段；两者皆无则匿名。
   */
  async *streamReply(
    req: ChatCompletionRequest,
    deviceHint?: string,
  ): AsyncGenerator<string> {
    const asrText = this.lastUserMessage(req);
    const baiduSystem = req.messages.filter((m) => m.role === "system");

    const device = await this.resolveDevice(req, deviceHint);

    // turnId 在一切 LLM 调用之前生成：safety_l2 / intent_classify /
    // chat_main / filler / memory_extract 全程贯穿，dashboard 按轮次串联
    // 调用链路（实机事故：turnId 生成过晚且未传入主流，链路只剩 1 条）
    const turnId = randomUUID();

    // 打断推断（方案 A）：新一轮开始即判定上一轮 assistant 回复是否仍在
    // 估算播放窗口内；fire-and-forget，失败只记日志，不阻塞本轮首音
    if (device) {
      void markPreviousReplyInterrupted(this.prisma, device.id).catch(
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Interruption marking failed for device=${device.deviceId}: ${message}`,
          );
        },
      );
    }

    // L1 安全闸：显式敏感词零延迟拦截，优先于冒险状态机与一切 LLM 调用
    const verdict = this.childSafety.checkL1(asrText);
    if (
      verdict.blocked &&
      verdict.category &&
      BLOCKED_CATEGORIES.includes(verdict.category as BlockedSafetyCategory)
    ) {
      this.logger.warn(
        `L1 blocked category=${verdict.category} matched=${verdict.matched ?? ""}`,
      );
      const canned = this.childSafety.cannedReply(
        verdict.category as BlockedSafetyCategory,
      );
      if (device) {
        await this.persistTurn(
          device.id,
          asrText,
          canned,
          "completed",
          {
            filler: null,
            answer: canned,
            safetyCategory: verdict.category,
            safetyLayer: "L1",
          },
          turnId,
        );
      }
      // 判定审计：L1 拦截轮不走意图路由，intent 记 null + not_routed，
      // 不能落成 free_chat——那会把拦截轮混进闲聊分母，意图分布就成了假数据
      this.turnDecisions.record({
        turnId,
        deviceId: device?.id ?? null,
        safety: verdict,
        intent: null,
        intentSource: "not_routed",
        asrText,
      });
      yield canned;
      return;
    }

    // 等待互动时优先交给冒险状态机，避免把选项回答误分类成新故事
    if (device) {
      const adventureReply = await this.adventure.handleChildReply(
        device.id,
        asrText,
      );
      if (adventureReply) {
        // 编排顺序上冒险状态机早于 L2：本轮既没做语义安全审查、也没做意图分类，
        // 只有上面的 L1 正则兜着（L1 刻意不收「杀/打/去死」这类气话）。
        // 如实记 not_evaluated / adventure_takeover 让看板暴露这块盲区，
        // 而不是伪装成「L2 判 safe」。
        this.turnDecisions.record({
          turnId,
          deviceId: device.id,
          safety: null,
          safetySource: "not_evaluated",
          intent: null,
          intentSource: "adventure_takeover",
          asrText,
        });
        yield* this.emitAdventureReply(device, adventureReply, asrText);
        return;
      }
    }

    // L2 语义安全分类与意图路由并行（同老链路 Promise.all）：
    // L2 补 L1 字面盲区，分类异常 fail-open 由 L3 兜底；
    // 意图路由依赖按设备的会话状态，匿名链路跳过、固定 free_chat。
    const [l2, intentDecision] = await Promise.all([
      this.safeClassifyL2(asrText, device?.id, turnId),
      device
        ? this.safeResolveIntent(device.id, asrText, turnId)
        : // 匿名链路没有会话状态可依赖，恒定 free_chat；来源单独标记，
          // 不能与「小模型判出的 free_chat」混成一桶
          Promise.resolve<TurnIntentDecision>({
            intent: "free_chat",
            source: "no_device",
          }),
    ]);
    const intent = intentDecision.intent;
    // safeClassifyL2 的外层 catch 连 verdict 都拿不到，此时记 l2_fail_open，
    // 与「本轮根本没做 L2」的 not_evaluated 严格区分
    const l2SourceOverride = l2 ? undefined : ("l2_fail_open" as const);

    if (
      l2?.blocked &&
      l2.category &&
      BLOCKED_CATEGORIES.includes(l2.category as BlockedSafetyCategory)
    ) {
      this.logger.warn(`L2 blocked category=${l2.category}`);
      const canned = this.childSafety.cannedReply(
        l2.category as BlockedSafetyCategory,
      );
      if (device) {
        await this.persistTurn(
          device.id,
          asrText,
          canned,
          "completed",
          {
            filler: null,
            answer: canned,
            safetyCategory: l2.category,
            safetyLayer: "L2",
          },
          turnId,
        );
      }
      // 判定审计：L2 拦截轮同样没走到意图路由
      this.turnDecisions.record({
        turnId,
        deviceId: device?.id ?? null,
        safety: l2,
        intent: null,
        intentSource: "not_routed",
        asrText,
      });
      yield canned;
      return;
    }
    // emotional_harm（攻击性气话）不拦截：注入共情引导 system 消息
    const emotionalHarmGuidance: LlmMessage | null =
      l2?.category === "emotional_harm"
        ? {
            role: "system",
            content: ChildSafetyService.EMOTIONAL_HARM_GUIDANCE,
          }
        : null;

    // 修改哄睡设置：独立短链路，确定性话术确认，不进冒险门禁与大模型主链路
    if (device && intent === "sleep_config") {
      const result = await this.sleepVoiceConfig.handle(device.id, asrText);
      await this.persistTurn(
        device.id,
        asrText,
        result.replyText,
        "completed",
        {
          filler: null,
          answer: result.replyText,
          sleepConfig: result.applied ? (result.field ?? null) : null,
        },
      );
      yield result.replyText;
      // 判定审计：短链路也是一轮完整判定，intentSource 透传会话服务的成因
      this.turnDecisions.record({
        turnId,
        deviceId: device.id,
        safety: l2,
        safetySource: l2SourceOverride,
        intent,
        intentSource: intentDecision.source,
        asrText,
      });
      return;
    }

    // 冒险每日门禁（对齐老链路）：故事类意图（除哄睡）在今日已完成时记
    // entry_blocked；未完成时 adventure_story/free_story 优先进入冒险。
    // adventureDeclined 供 filler 情境段使用，避免拖延话术与婉拒播报矛盾。
    let adventureDeclined = false;
    if (device && intent !== "free_chat" && intent !== "sleep_story") {
      const completedToday = await this.adventure.isCompletedToday(device.id);
      if (
        !completedToday &&
        (intent === "adventure_story" || intent === "free_story")
      ) {
        const startedAdventure = await this.adventure.startToday(
          device.id,
          true,
        );
        if (startedAdventure) {
          await this.conversationSession.reset(device.id);
          // 判定审计：本轮 L2 已评估（与冒险接管不同），intent 来自路由结果
          this.turnDecisions.record({
            turnId,
            deviceId: device.id,
            safety: l2,
            safetySource: l2SourceOverride,
            intent,
            intentSource: intentDecision.source,
            asrText,
          });
          yield* this.emitAdventureReply(device, startedAdventure, asrText);
          return;
        }
      }
      if (completedToday) {
        adventureDeclined = true;
        await this.adventure.recordEntryBlocked(
          device.id,
          intent === "adventure_story" ? "free_story" : intent,
        );
      }
    }

    // mode 决策对齐老链路：故事类意图戳对应模式；adventure_story/free_story
    // 走到这里说明冒险未真正开始（被门禁拦截或无集可播），按设备配置戳
    // english_chat/free_chat，避免污染学习统计的冒险计数。
    const activeConfig = device
      ? await this.resolveActiveConfig(device.id)
      : null;
    const mode = STORY_INTENTS.includes(intent)
      ? intent
      : activeConfig?.mode === "english_chat"
        ? "english_chat"
        : "free_chat";

    // 故事类回合判定（含被门禁拦截后走自由创作的 adventure/free_story）：
    // 主模型 maxTokens 分档与 filler 情境共用
    const isStoryTurn =
      STORY_INTENTS.includes(intent) ||
      intent === "adventure_story" ||
      intent === "free_story";

    // 哄睡语音指令持久化内容偏好（一律落库，家长端可见；失败不阻塞本轮）
    if (device && intent === "sleep_story") {
      await this.applySleepVoiceConfig(device.id, asrText);
    }

    // 有设备时历史以 DB 为准（防客户端伪造上下文）；匿名保持客户端历史。
    // 必须在写入本轮 user 消息之前取，避免把当前话术重复拼进 prompt。
    // recentFillers 为最近 5 轮 filler 原文，供小模型禁用清单（防复读）。
    let history: Array<{ role: "user" | "assistant"; content: string }>;
    let recentFillers: string[] = [];
    if (device) {
      ({ history, recentFillers } = await this.getDbHistory(device.id, mode));
    } else {
      history = this.extractHistory(req);
    }

    // user 消息收到即落库，不等待 LLM（LLM 故障只影响后续 assistant 行）
    const sourceOccurredAt = new Date();
    if (device) {
      await this.prisma.message.create({
        data: {
          deviceId: device.id,
          turnId,
          role: "user",
          content: asrText,
          status: "completed",
          mode,
          conversationModeKey: activeConfig?.conversationModeKey ?? null,
          rawPayload: { channel: "baidu-rtc" },
          spokeAt: sourceOccurredAt,
        },
      });

      // 长期记忆异步提取，不阻塞首音；失败只影响记忆写入
      const previousAssistant = [...history]
        .reverse()
        .find((message) => message.role === "assistant")?.content;
      void this.childMemories
        .extractAndStore({
          deviceId: device.id,
          turnId,
          asrText,
          previousAssistant,
          sourceOccurredAt,
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Child memory extraction failed for device=${device.deviceId}: ${message}`,
          );
        });
    }

    // 记忆注入：free_chat 全量注入 5 槽位（含软冷却）；其余意图（故事/英语角等）
    // 注入轻量偏好块，保证「Elly 懂我」跨模式连续；favorite_story_type 透出
    // 给故事话术主动选题（均对齐「不增加 LLM 调用」的确定性口径）
    let memoryPrompt: { text: string; memoryIds: string[] } = {
      text: "",
      memoryIds: [],
    };
    let favoriteStoryType: string | null = null;
    if (device) {
      try {
        if (intent === "free_chat") {
          memoryPrompt = await this.childMemories.buildPromptBlock(
            device.id,
            history
              .filter((message) => message.role === "assistant")
              .slice(-5)
              .map((message) => message.content),
          );
        } else {
          const preference = await this.childMemories.buildPreferenceBlock(
            device.id,
          );
          memoryPrompt = {
            text: preference.text,
            memoryIds: preference.memoryIds,
          };
          favoriteStoryType = preference.favoriteStoryType;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Child memory recall failed for device=${device.deviceId}: ${message}`,
        );
      }
    }

    // 孩子档案：主模型 prompt 与 filler 情境共用，提前于串行 filler 取
    const childProfile = device ? await this.getChildProfile(device.id) : null;

    // 流式 filler：小模型流式生成，头部缓冲校验通过立即外发（首音提前到
    // TTFT，不再等整句生成完），原文注入主模型 handoff，从结构上杜绝
    // 「主模型重复 filler 已说的内容」。身份/偏好问句走确定性模板；
    // 头部违规（孩子名开头/人设名出现）重试一次，仍违规或失败回落模板池
    // （不再静默无 filler——缺失轮完全没有防死空气缓冲）。
    const fillerEnabled =
      this.configService.get<string>("LLM_ADAPTER_FILLER") !== "false";
    let fillerText = "";
    if (fillerEnabled) {
      for await (const chunk of this.streamFiller({
        asrText,
        recentFillers,
        intent,
        adventureDeclined,
        device,
        childProfile,
        turnId,
      })) {
        fillerText += chunk;
        yield chunk;
      }
    }

    // prompt 组装：故事意图用故事话术，自由对话按子模式模板，
    // 孩子档案注入称呼/年龄上下文（均对齐老链路）
    const promptTemplate = STORY_INTENTS.includes(intent)
      ? this.storyPrompt(intent, favoriteStoryType)
      : intent === "adventure_story" || intent === "free_story"
        ? this.storyPrompt(intent, favoriteStoryType)
        : await this.resolvePromptTemplate(
            mode,
            activeConfig?.conversationModeKey,
          );

    const built = this.llmService.buildEnglishTutorPrompt(asrText, history, {
      childProfile: childProfile
        ? {
            name: childProfile.name,
            birthday: childProfile.birthday,
            englishName: childProfile.englishName,
            gender: childProfile.gender,
          }
        : undefined,
      promptTemplate,
      mode,
      conversationModeKey: activeConfig?.conversationModeKey ?? undefined,
      characterKey: device?.characterKey,
    });
    const messages: LlmMessage[] = [
      ...baiduSystem,
      ...(emotionalHarmGuidance ? [emotionalHarmGuidance] : []),
      ...built,
    ];
    if (memoryPrompt.text) {
      // 记忆块贴尾注入（本轮 user 之前）：头部保持 DeepSeek 前缀缓存命中
      messages.splice(messages.length - 1, 0, {
        role: "system" as const,
        content: memoryPrompt.text,
      });
    }
    if (fillerText) {
      // handoff（方案 B）：filler 原文作为独立 system 消息贴在记忆块之后、
      // 本轮 user 之前——离生成点最近，recency 最强；且移出头部后主 prompt
      // 跨轮稳定，DeepSeek 前缀缓存命中率反而提升
      messages.splice(
        messages.length - 1,
        0,
        this.llmService.buildFillerHandoffMessage(fillerText),
      );
    }

    // 主模型流式：filler（如有）已在上游逐 chunk 外发，主模型随后按流
    // 直出。大模型失败时：零输出且错误可重试 → 重试一次（filler 播报
    // 时长天然掩盖重试延迟）；answer 最终为空 → 无论 filler 是否已播都
    // 播兜底话术，不让孩子面对沉默。
    let answerText = "";
    let llmFailed = false;
    const maxAttempts = 2; // 初次 + 一次重试，有上限不死循环
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const stream = this.llmService.completeStream({
          scene: "chat_main",
          deviceId: device?.id,
          turnId,
          messages,
          // 故事类回合内容长（讲故事+释义），200 会截断残句（实机案例：
          // 成语故事结尾「别做井」）；自由对话规则约束 1-3 句，200 足够。
          maxTokens: isStoryTurn ? 800 : 200,
          thinking: { type: "disabled" },
        });
        for await (const chunk of stream) {
          answerText += chunk;
          yield chunk;
        }
        llmFailed = false;
        break;
      } catch (error) {
        llmFailed = true;
        const retriable = error instanceof LlmUpstreamError && error.retriable;
        const detail =
          error instanceof LlmUpstreamError
            ? error.detail
            : error instanceof Error
              ? error.message
              : String(error);
        this.logger.error(
          `LLM upstream failed (attempt ${attempt}/${maxAttempts}): ${detail}`,
        );
        // mid-stream 断流（残句已播）或不可重试错误（4xx 等）：不重试，
        // 避免孩子听到「前半句 + 重新生成的一整段」的冲突内容
        if (answerText || !retriable || attempt === maxAttempts) {
          break;
        }
        this.logger.warn("LLM chat_main retrying once after retriable failure");
      }
    }
    // answer 为空即兜底（断流失败 / empty_response 都算），无论 filler 是否已播
    if (!answerText) {
      llmFailed = true;
      answerText = resolveUpstreamFallbackText(device?.characterKey);
      yield answerText;
    }

    // 用户实际播报全文：filler（如有）+ 大模型答案，作为最终回答落库
    const responseText = fillerText
      ? `${fillerText}\n${answerText}`
      : answerText;

    // 补写 assistant 消息；LLM 失败时标 failed，与真实回答可区分
    if (device) {
      await this.prisma.message.create({
        data: {
          deviceId: device.id,
          turnId,
          role: "assistant",
          content: responseText,
          status: llmFailed ? "failed" : "completed",
          mode,
          conversationModeKey: activeConfig?.conversationModeKey ?? null,
          // 边界标注同老链路：content 保持播报全文纯净，
          // filler/answer 边界结构化存 rawPayload
          rawPayload: { filler: fillerText || null, answer: answerText },
          spokeAt: new Date(),
        },
      });
      if (!llmFailed && memoryPrompt.memoryIds.length > 0) {
        try {
          await this.childMemories.markInjected(memoryPrompt.memoryIds);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Failed to mark memories injected for device=${device.deviceId}: ${message}`,
          );
        }
      }
    }

    // 判定审计：主链路唯一正常出口（含 llmFailed 兜底）。成功与失败都要记——
    // 判定质量与主模型成败是两件事，不能因为主模型挂了就把这轮判定丢掉。
    // 放在这里而不是 finally：streamReply 是 async generator，消费方直接丢弃
    // 迭代器时 finally 不保证执行；代价是未捕获异常中断的轮次没有判定记录，
    // 所以看板文案必须写明「判定记录数 ≤ 对话轮次数」。
    this.turnDecisions.record({
      turnId,
      deviceId: device?.id ?? null,
      safety: l2,
      safetySource: l2SourceOverride,
      intent,
      intentSource: intentDecision.source,
      asrText,
    });
  }

  /** 非流式：聚合全部 chunk 为整段文本 */
  async completeReply(
    req: ChatCompletionRequest,
    deviceHint?: string,
  ): Promise<string> {
    let text = "";
    for await (const chunk of this.streamReply(req, deviceHint)) {
      text += chunk;
    }
    return text;
  }

  /**
   * 冒险回复播出：段落按序作为 SSE chunk 流出（TTS 天然按序播报），
   * user/assistant 成对落库（mode=adventure_story，全文 \n 连接，
   * interactionResult 存 rawPayload），最后 recordPresented 审计。
   *
   * 刻意不调 markPromptPlaybackComplete：新链路无推送通道，10s 沉默超时
   * 兜底不可用；交互点无限期等孩子下一句话（waitingSince 保持 null，
   * 超时扫描自动跳过这些记录）。
   */
  private async *emitAdventureReply(
    device: { id: string; deviceId: string },
    adventureReply: AdventureReply,
    asrText: string,
  ): AsyncGenerator<string> {
    const turnId = randomUUID();
    const responseText = adventureReply.texts.join("\n");

    await this.prisma.message.create({
      data: {
        deviceId: device.id,
        turnId,
        role: "user",
        content: asrText,
        status: "completed",
        mode: "adventure_story",
        conversationModeKey: null,
        rawPayload: { channel: "baidu-rtc" },
        spokeAt: new Date(),
      },
    });

    for (const text of adventureReply.texts) {
      yield text;
    }

    await this.prisma.message.create({
      data: {
        deviceId: device.id,
        turnId,
        role: "assistant",
        content: responseText,
        status: "completed",
        mode: "adventure_story",
        conversationModeKey: null,
        rawPayload: {
          filler: null,
          answer: responseText,
          interactionResult: adventureReply.result ?? null,
        },
        spokeAt: new Date(),
      },
    });
    await this.adventure.recordPresented(device.id, turnId, adventureReply);
  }

  /**
   * 解析设备身份：显式 header 优先，其次请求体 deviceid（机芯厂正式约定，
   * 与小程序家长绑定编号一致），最后 fallback user 字段（旧约定兼容）。
   * MAC 归一化（去分隔符、小写）后
   * 同时按 deviceId / macAddress 两列匹配，查不到则建档
   * （同老链路 ensureDeviceExists 的 4G 未绑定场景语义）；
   * raw 为 MAC 形态时以归一化小写值建档，与 client-api loginMac
   * 的建档口径一致，避免大小写差异产生重复 Device。
   */
  private async resolveDevice(
    req: ChatCompletionRequest,
    deviceHint?: string,
  ): Promise<{ id: string; deviceId: string; characterKey: string } | null> {
    const raw = (deviceHint ?? req.deviceid ?? req.user)?.trim();
    if (!raw) return null;

    const candidates = Array.from(new Set([raw, this.normalizeMac(raw)]));
    const existing = await this.prisma.device.findFirst({
      where: {
        OR: [
          { deviceId: { in: candidates } },
          { macAddress: { in: candidates } },
        ],
      },
    });
    if (existing) {
      return {
        id: existing.id,
        deviceId: existing.deviceId,
        characterKey: existing.characterKey,
      };
    }
    const isMac = MAC_PATTERN.test(raw);
    const normalized = isMac ? this.normalizeMac(raw) : null;
    const created = await this.prisma.device.create({
      data: {
        deviceId: normalized ?? raw,
        macAddress: normalized,
      },
    });
    return {
      id: created.id,
      deviceId: created.deviceId,
      characterKey: created.characterKey,
    };
  }

  /** MAC 归一化：AA:BB:CC:DD:EE:FF / AA-BB-.. / aabb.. → aabbccddeeff */
  private normalizeMac(value: string): string {
    if (!MAC_PATTERN.test(value)) return value;
    return value.replace(/[:-]/g, "").toLowerCase();
  }

  /** L2 语义分类包装：任何异常 fail-open 返回 null，由 L3 兜底 */
  private async safeClassifyL2(
    asrText: string,
    deviceId?: string,
    turnId?: string,
  ) {
    try {
      return await this.childSafety.classifyL2(asrText, deviceId, turnId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`L2 classification failed, fail-open: ${message}`);
      return null;
    }
  }

  /** 意图路由包装：会话服务异常时降级 free_chat，不让孩子面对沉默。
   *  取 resolveWithSource 而非 resolve，好把「模型判的」和「兜底兜出来的」分开落库。 */
  private async safeResolveIntent(
    deviceInternalId: string,
    asrText: string,
    turnId?: string,
  ): Promise<TurnIntentDecision> {
    try {
      return await this.conversationSession.resolveWithSource(
        deviceInternalId,
        asrText,
        turnId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Intent resolution failed, fallback free_chat: ${message}`,
      );
      return { intent: "free_chat", source: "fallback_error" };
    }
  }

  /** 查询设备当前生效配置（对齐老链路 resolveActiveConfig） */
  private async resolveActiveConfig(deviceInternalId: string) {
    return this.prisma.deviceConfig.findFirst({
      where: { deviceId: deviceInternalId, isActive: true },
      orderBy: { createdAt: "desc" },
    });
  }

  /** 查询设备对应的孩子档案（对齐老链路 getChildProfile） */
  private async getChildProfile(deviceInternalId: string) {
    return this.prisma.childProfile.findUnique({
      where: { deviceId: deviceInternalId },
    });
  }

  /**
   * 故事意图的话术（复制自 vendor.service.ts storyPrompt，两处需同步修改）。
   * adventure_story/free_story 走到这里说明冒险未真正开始（门禁拦截或
   * 无集可播），统一走「自由创作、不承诺冒险」的降级话术。
   */
  private storyPrompt(
    intent: ConversationIntent,
    favoriteStoryType?: string | null,
  ): string | undefined {
    let base: string | undefined;
    switch (intent) {
      case "english_story":
        base =
          "Tell a short, warm English story for a young child, then invite one simple spoken response. Begin directly with the story's opening line — no preamble, no 'Here is...', no title, no meta-narration.";
        break;
      case "idiom_story":
        base =
          "讲一个适合孩子的成语故事，用口语解释成语含义，但不要冒险入每日互动冒险剧情。直接开始讲故事正文，不要「下面我来讲」之类的开场叙述，不要标题。";
        break;
      case "sleep_story":
        base =
          "用平静、缓慢、适合哄睡的语气讲一个温柔短故事；不要提问、不要邀请互动、不要让孩子做决定，逐渐安静收尾。直接开始讲故事正文，不要任何开场叙述或标题。";
        break;
      case "adventure_story":
      case "free_story":
        base =
          "请自由创作一个适合孩子的短故事，温暖、有画面感，不进入或复述每日互动冒险的固定剧情。每日冒险当前不可进入，不要承诺开始、重播或继续冒险，也不要虚构冒险进度。直接开始讲故事正文，不要任何开场叙述或标题。";
        break;
      default:
        return undefined;
    }
    // 主动选题：孩子没指定题材时，优先讲 TA 最喜欢的故事类型（长期记忆）
    if (favoriteStoryType) {
      base += `\n孩子最喜欢的故事类型是「${favoriteStoryType}」：如果孩子这轮没有指定别的题材，优先讲这个类型。`;
    }
    return base;
  }

  /**
   * 哄睡语音指令持久化内容偏好（复制自 vendor.service.ts
   * applySleepVoiceConfig，两处需同步修改）：
   * 「我要听睡前儿歌」→ contentType=song；「我要听睡前故事」→ story。
   * 持久化失败不影响本轮哄睡回复。
   */
  private async applySleepVoiceConfig(
    deviceInternalId: string,
    asrText: string,
  ): Promise<void> {
    try {
      if (/儿歌|童谣|唱歌|催眠曲/.test(asrText)) {
        await this.sleepConfigs.applyVoiceUpdate(deviceInternalId, {
          contentType: "song",
        });
      } else if (/睡前故事|哄睡故事|晚安故事/.test(asrText)) {
        await this.sleepConfigs.applyVoiceUpdate(deviceInternalId, {
          contentType: "story",
        });
      }
    } catch (error) {
      this.logger.warn(
        `applySleepVoiceConfig failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** 自由对话按 conversationModeKey 读取子模式 prompt 模板 */
  private async resolvePromptTemplate(
    mode: string,
    conversationModeKey: string | null | undefined,
  ): Promise<string | undefined> {
    if (mode !== "free_chat" || !conversationModeKey) {
      return undefined;
    }
    const conversationMode = await this.prisma.conversationMode.findFirst({
      where: { key: conversationModeKey },
      select: { promptTemplate: true },
    });
    return conversationMode?.promptTemplate ?? undefined;
  }

  /**
   * 取设备最近消息历史（时间正序，按模式过滤），剥离 filler 只留
   * answer；无边界信息的旧 assistant 行跳过。口径同老链路
   * getRecentHistory；recentFillers 返回最近 5 轮 filler 原文
   * （时间正序），供小模型禁用清单。
   */
  private async getDbHistory(
    deviceInternalId: string,
    mode: string,
  ): Promise<{
    history: Array<{ role: "user" | "assistant"; content: string }>;
    recentFillers: string[];
  }> {
    const rows = await this.prisma.message.findMany({
      where: { deviceId: deviceInternalId, mode },
      orderBy: { spokeAt: "desc" },
      take: DB_HISTORY_LIMIT,
      select: { role: true, content: true, rawPayload: true },
    });

    const history: Array<{ role: "user" | "assistant"; content: string }> = [];
    const fillers: string[] = [];
    for (const row of rows.reverse()) {
      if (row.role === "user") {
        history.push({ role: "user", content: row.content });
        continue;
      }
      const answer = LlmService.extractAnswer(row.content, row.rawPayload);
      if (answer === null) {
        continue;
      }
      history.push({ role: "assistant", content: answer });
      const filler = (row.rawPayload as { filler?: unknown } | null)?.filler;
      if (typeof filler === "string" && filler.length > 0) {
        fillers.push(filler);
      }
    }
    return { history, recentFillers: fillers.slice(-5) };
  }

  /** 问 Elly 身份（名字/是谁）的窄类问句：filler 走模板，不交给小模型 */
  private static readonly SELF_IDENTITY_QUESTION =
    /你(叫什么|是谁|是干什么的)|你的名字|who are you|your name/i;
  /** 问 Elly 偏好的窄类问句：同上走模板（实机事故：filler 主客颠倒） */
  private static readonly SELF_PREFERENCE_QUESTION =
    /你(最?(喜欢|爱)|喜欢什么|爱吃什么|平时喜欢)/i;

  // 模板池统一 ≥15 字 / ≥8 词：模板也是过渡音覆盖，同样要盖住主模型首包
  private static readonly IDENTITY_FILLERS_ZH = [
    "你在问我的名字呀，让我想一想怎么介绍自己呢……",
    "你想知道我是谁呀，这个问题还挺有意思的呢……",
  ];
  private static readonly PREFERENCE_FILLERS_ZH = [
    "你想知道我喜欢什么呀，让我认真想一想呢……",
    "你在问我的喜好呀，我还真想跟你好好聊聊呢……",
  ];
  private static readonly IDENTITY_FILLERS_EN = [
    "Oh, you are asking about my name? Let me think!",
  ];
  private static readonly PREFERENCE_FILLERS_EN = [
    "You want to know what I like? Let me think about it!",
  ];
  private static readonly GENERIC_FILLERS_ZH = [
    "嗯嗯，我在认真听呢，你接着往下说呀……",
    "哇，你说的话真有意思呀，我还想再听呢……",
    "哦？这件事听起来好有趣呀，后来呢后来呢……",
    "哈哈，我最喜欢听你说话啦，再多讲一点嘛……",
  ];
  private static readonly GENERIC_FILLERS_EN = [
    "Hmm, I am listening carefully, keep going!",
    "Wow, that sounds so fun, tell me more!",
    "Oh really? I want to hear more about it!",
  ];

  /** 流式 filler 头部缓冲长度（字符）：足以定论「孩子名开头 / 人设名出现」 */
  private static readonly FILLER_HEAD_BUFFER_CHARS = 8;

  /** filler 开头语气词/标点剥离集：判「孩子名开头」前先剥掉填充开场 */
  private static readonly FILLER_LEADING_FILLER_CHARS =
    /^[\s\p{P}\p{S}呀嗯啊哦哈哇噢唉嘿]+/u;

  /**
   * 流式 filler（3s 超时）：小模型流式生成，头部缓冲 8 字做确定性校验
   * （孩子名开头 / 人设名出现——两类实机事故均为头部现象），通过后立即
   * 外发、后续 chunk 直通，首音从「整句生成完」提前到「头部定论」。
   * 头部违规则中止本条流（未外发任何内容），带强禁令重试一次；重试仍
   * 违规或生成失败 → 回落兜底模板池，保证过渡音覆盖不缺席（不再静默
   * 无 filler——dashboard 实测 filler 缺失轮完全没有防死空气缓冲）。
   * 权衡声明：全文复读/长度下限退化为事后告警（已播不可撤回），
   * prompt 禁用清单与示例是主防线。
   */
  private async *streamFiller(params: {
    asrText: string;
    recentFillers: string[];
    intent: ConversationIntent;
    adventureDeclined: boolean;
    device: { id: string; characterKey?: string | null } | null;
    childProfile: {
      name?: string | null;
      birthday?: string | null;
      englishName?: string | null;
      gender?: string | null;
    } | null;
    turnId: string;
  }): AsyncGenerator<string> {
    const { asrText, recentFillers } = params;

    const templated = this.fillerTemplateFor(asrText, recentFillers);
    if (templated) {
      yield templated;
      return;
    }

    const persona = params.device
      ? (LlmService.CHARACTER_PERSONAS[params.device.characterKey ?? "elly"] ??
        LlmService.CHARACTER_PERSONAS.elly)
      : LlmService.CHARACTER_PERSONAS.elly;
    // 人设显示名（「小象 Elly」/「小马 Polly」），用于拒绝人设名出现
    const personaName = persona.split("：")[0];
    // 孩子名硬禁（优先英文名，与 buildChildBrief 的称呼口径一致）；
    // 无档案时跳过该校验
    const childName =
      params.childProfile?.englishName ??
      params.childProfile?.name ??
      undefined;

    const openStream = (extraInstruction?: string) => {
      const messages = this.llmService.buildFillerPrompt(
        asrText,
        recentFillers,
        {
          intent: params.intent,
          adventureDeclined: params.adventureDeclined,
          persona: params.device ? persona : undefined,
          childBrief: params.childProfile
            ? LlmService.buildChildBrief(params.childProfile)
            : undefined,
        },
      );
      if (extraInstruction) {
        messages.push({ role: "user", content: extraInstruction });
      }
      return this.llmService.completeStream({
        scene: "filler",
        deviceId: params.device?.id,
        turnId: params.turnId,
        messages,
        model: this.llmService.smallModelName,
        maxTokens: 60,
        timeoutMs: 3000,
      });
    };

    let fullText = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      let buffer = "";
      let flushed = false;
      let rejected = false;
      try {
        const stream = openStream(
          attempt === 2
            ? "你上一句被拒绝了：它以孩子的名字开头，或出现了你自己的人设名。请生成一句完全不同的话——不同的措辞、不同的结构、不带任何名字。"
            : undefined,
        );
        for await (const chunk of stream) {
          buffer += chunk;
          if (flushed) {
            // 头部已定论放行，后续 chunk 直通（首音之后零缓冲）
            fullText += chunk;
            yield chunk;
            continue;
          }
          const verdict = this.checkFillerHead(buffer, childName, personaName);
          if (verdict === "reject") {
            rejected = true;
            break; // 头部违规：中止本条流，未外发任何内容
          }
          if (verdict === "pass") {
            flushed = true;
            fullText += buffer;
            yield buffer;
            buffer = "";
          }
        }
        if (!rejected && !flushed) {
          // 全文不足头部缓冲长度（短句/空响应）：在完整文本上定论
          if (
            buffer &&
            this.checkFillerHead(buffer, childName, personaName, true) !==
              "reject"
          ) {
            flushed = true;
            fullText += buffer;
            yield buffer;
          } else {
            rejected = true; // 空响应或违规短句：走重试/兜底
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Filler stream attempt ${attempt} failed: ${message}`);
        if (flushed) {
          // 半截 filler 已播给孩子：不可撤回、不重试（避免孩子听到
          // 「前半句 + 另一句」的冲突内容），保留已播部分直接结束
          this.logFillerPostChecks(fullText, recentFillers, personaName);
          return;
        }
        rejected = true; // 未外发 → 重试或兜底
      }
      if (!rejected) {
        this.logFillerPostChecks(fullText, recentFillers, personaName);
        return;
      }
    }

    // 两次均违规/失败：兜底模板池（dedup-aware），保证过渡音覆盖不缺席
    const fallback = this.fillerFallback(asrText, recentFillers);
    this.logger.warn("Filler fell back to template pool");
    yield fallback;
  }

  /**
   * 流式 filler 头部校验：拒绝两类实机事故的头部现象
   * （剥离语气词后以孩子名开头 / 任意位置出现人设名）。
   * 缓冲不足 8 字且非终态时返回 undecided（继续等后续 chunk）。
   */
  private checkFillerHead(
    buffer: string,
    childName: string | undefined,
    personaName: string,
    final = false,
  ): "pass" | "reject" | "undecided" {
    const compact = buffer.replace(/\s+/g, "");
    const compactPersona = personaName.replace(/\s+/g, "");
    if (compactPersona && compact.includes(compactPersona)) {
      return "reject";
    }
    if (childName) {
      const stripped = buffer.replace(
        LlmAdapterService.FILLER_LEADING_FILLER_CHARS,
        "",
      );
      if (stripped.startsWith(childName)) {
        return "reject";
      }
    }
    return final ||
      [...buffer].length >= LlmAdapterService.FILLER_HEAD_BUFFER_CHARS
      ? "pass"
      : "undecided";
  }

  /**
   * 流式 filler 事后校验：已播不可撤回，违规只告警供日志/dashboard 观测。
   * （复读与长度下限的硬门让位给首音延迟，prompt 禁用清单是主防线）
   */
  private logFillerPostChecks(
    fullText: string,
    recentFillers: string[],
    personaName: string,
  ): void {
    if (!fullText) {
      return;
    }
    if (this.isFillerDuplicate(fullText, recentFillers)) {
      this.logger.warn(`Filler repeated despite banned list: ${fullText}`);
    }
    const isZh = /[\u4e00-\u9fff]/.test(fullText);
    const tooShort = isZh
      ? [...fullText.replace(/[\s\p{P}\p{S}]/gu, "")].length < 15
      : fullText.trim().split(/\s+/).length < 8;
    if (tooShort) {
      this.logger.warn(
        `Filler shorter than the 15-char/8-word floor: ${fullText}`,
      );
    }
    const compactPersona = personaName.replace(/\s+/g, "");
    if (
      compactPersona &&
      fullText.replace(/\s+/g, "").includes(compactPersona)
    ) {
      this.logger.warn(
        `Filler contains persona name beyond head check: ${fullText}`,
      );
    }
  }

  /** 身份/偏好问句的确定性模板；非此类问句返回 null 走小模型 */
  private fillerTemplateFor(
    asrText: string,
    recentFillers: string[],
  ): string | null {
    const isZh = /[\u4e00-\u9fff]/.test(asrText);
    let pool: string[] | null = null;
    if (LlmAdapterService.SELF_IDENTITY_QUESTION.test(asrText)) {
      pool = isZh
        ? LlmAdapterService.IDENTITY_FILLERS_ZH
        : LlmAdapterService.IDENTITY_FILLERS_EN;
    } else if (LlmAdapterService.SELF_PREFERENCE_QUESTION.test(asrText)) {
      pool = isZh
        ? LlmAdapterService.PREFERENCE_FILLERS_ZH
        : LlmAdapterService.PREFERENCE_FILLERS_EN;
    }
    if (!pool) {
      return null;
    }
    return (
      pool.find((f) => !this.isFillerDuplicate(f, recentFillers)) ?? pool[0]
    );
  }

  /** 重试仍重复时的兜底：通用模板池里挑一条最近没用过的 */
  private fillerFallback(asrText: string, recentFillers: string[]): string {
    const pool = /[\u4e00-\u9fff]/.test(asrText)
      ? LlmAdapterService.GENERIC_FILLERS_ZH
      : LlmAdapterService.GENERIC_FILLERS_EN;
    return (
      pool.find((f) => !this.isFillerDuplicate(f, recentFillers)) ?? pool[0]
    );
  }

  /** 归一化比对（去大小写/空白/标点/符号）：挡逐字复读与近重复 */
  private isFillerDuplicate(text: string, recentFillers: string[]): boolean {
    const normalized = LlmAdapterService.normalizeFiller(text);
    return recentFillers.some(
      (recent) => LlmAdapterService.normalizeFiller(recent) === normalized,
    );
  }

  private static normalizeFiller(text: string): string {
    return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  }

  /** 安全/短链路回复的成对落库（user 原文 + assistant 兜底话术） */
  private async persistTurn(
    deviceInternalId: string,
    asrText: string,
    replyText: string,
    status: "completed" | "failed",
    assistantPayload: Prisma.InputJsonValue,
    turnId: string = randomUUID(),
  ): Promise<void> {
    await this.prisma.message.create({
      data: {
        deviceId: deviceInternalId,
        turnId,
        role: "user",
        content: asrText,
        status: "completed",
        mode: "free_chat",
        conversationModeKey: null,
        rawPayload: { channel: "baidu-rtc" },
        spokeAt: new Date(),
      },
    });
    await this.prisma.message.create({
      data: {
        deviceId: deviceInternalId,
        turnId,
        role: "assistant",
        content: replyText,
        status,
        mode: "free_chat",
        conversationModeKey: null,
        rawPayload: assistantPayload,
        spokeAt: new Date(),
      },
    });
  }

  private lastUserMessage(req: ChatCompletionRequest): string {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      if (req.messages[i].role === "user") return req.messages[i].content;
    }
    throw new BadRequestException("messages must contain a user message");
  }

  /** 取最后一条 user 消息之前的 user/assistant 对作为历史，截最近 N 轮 */
  private extractHistory(
    req: ChatCompletionRequest,
  ): Array<{ role: "user" | "assistant"; content: string }> {
    const turns = req.messages.filter((m) => m.role !== "system");
    // 最后一条即当前 asrText，不进历史
    const prior = turns.slice(0, -1);
    const history = prior.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
    return history.slice(-MAX_HISTORY_TURNS * 2);
  }
}
