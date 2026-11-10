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
 * → filler（小模型打哈哈）+ 主模型流（后台泵并发）→ assistant 落库。
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
        yield* this.emitAdventureReply(device, adventureReply, asrText);
        return;
      }
    }

    // L2 语义安全分类与意图路由并行（同老链路 Promise.all）：
    // L2 补 L1 字面盲区，分类异常 fail-open 由 L3 兜底；
    // 意图路由依赖按设备的会话状态，匿名链路跳过、固定 free_chat。
    const [l2, intent] = await Promise.all([
      this.safeClassifyL2(asrText, device?.id, turnId),
      device
        ? this.safeResolveIntent(device.id, asrText, turnId)
        : Promise.resolve<ConversationIntent>("free_chat"),
    ]);

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

    // 记忆注入：free_chat 走相关性召回；其余意图（故事/英语角等）注入
    // 轻量偏好块，保证「Elly 懂我」跨模式连续；favorite_story_type 透出
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
            asrText,
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

    // 串行 filler：小模型非流式先行生成一句承接（实测约 0.4s，被 filler
    // 语音播报时长完全吸收），原文注入主模型 prompt，从结构上杜绝
    // 「主模型重复 filler 已说的内容」。身份/偏好问句走确定性模板；
    // 与近 5 轮重复时重试一次，仍重复回落模板池。失败/关闭静默无 filler。
    const fillerEnabled =
      this.configService.get<string>("LLM_ADAPTER_FILLER") !== "false";
    let fillerText = "";
    if (fillerEnabled) {
      fillerText = await this.generateFiller({
        asrText,
        recentFillers,
        intent,
        adventureDeclined,
        device,
        childProfile,
        turnId,
      });
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
      fillerHeard: fillerText || undefined,
    });
    const messages: LlmMessage[] = [
      ...baiduSystem,
      ...(emotionalHarmGuidance ? [emotionalHarmGuidance] : []),
      ...(memoryPrompt.text
        ? [{ role: "system" as const, content: memoryPrompt.text }]
        : []),
      ...built,
    ];

    // 主模型流式：filler（如有）先作为 SSE 前导 chunk 外发，随后主模型
    // 按流直出（串行后不再需要双泵缓冲交错）。大模型失败时：
    // 零输出且错误可重试 → 重试一次（filler 播报时长天然掩盖重试延迟）；
    // answer 最终为空 → 无论 filler 是否已播都播兜底话术，不让孩子面对沉默。
    if (fillerText) {
      yield fillerText;
    }
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

  /** 意图路由包装：会话服务异常时降级 free_chat，不让孩子面对沉默 */
  private async safeResolveIntent(
    deviceInternalId: string,
    asrText: string,
    turnId?: string,
  ): Promise<ConversationIntent> {
    try {
      return await this.conversationSession.resolve(
        deviceInternalId,
        asrText,
        turnId,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Intent resolution failed, fallback free_chat: ${message}`,
      );
      return "free_chat";
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

  private static readonly IDENTITY_FILLERS_ZH = [
    "你在问我的名字呀…",
    "你想知道我是谁呀…",
  ];
  private static readonly PREFERENCE_FILLERS_ZH = [
    "你想知道我喜欢什么呀…",
    "你在问我的喜好呀…",
  ];
  private static readonly IDENTITY_FILLERS_EN = ["You're asking my name?"];
  private static readonly PREFERENCE_FILLERS_EN = [
    "You want to know what I like?",
  ];
  private static readonly GENERIC_FILLERS_ZH = [
    "嗯嗯，我在听呢～",
    "哇，你说的真有意思呀～",
    "哦？后来呢后来呢～",
    "哈哈，我喜欢听你说话呢～",
  ];
  private static readonly GENERIC_FILLERS_EN = [
    "Hmm, I'm listening...",
    "Wow, tell me more!",
    "Oh, that sounds fun!",
  ];

  /**
   * 串行 filler：非流式生成一句承接（3s 超时），作为 SSE 前导播报并注入
   * 主模型 prompt。三层防线：
   * 1. 身份/偏好问句走确定性模板（实机事故：小模型抢答名字、主客颠倒）；
   * 2. 模型生成后确定性校验：与近 5 轮归一化比对防逐字复读（实机事故：
   *    同一句 filler 三连复读）；拒绝以人设名标签开头（实机事故：连续
   *    8 轮「小象 Elly：X 真 Y 呀」同构口癖，像剧本角色标签）。
   *    不合格则带强禁令重试一次；
   * 3. 仍不合格则从兜底模板池取一条。
   * 任何失败静默返回 ""，主链路照常。
   */
  private async generateFiller(params: {
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
  }): Promise<string> {
    const { asrText, recentFillers } = params;

    const templated = this.fillerTemplateFor(asrText, recentFillers);
    if (templated) {
      return templated;
    }

    const persona = params.device
      ? (LlmService.CHARACTER_PERSONAS[params.device.characterKey ?? "elly"] ??
        LlmService.CHARACTER_PERSONAS.elly)
      : LlmService.CHARACTER_PERSONAS.elly;
    // 人设显示名（「小象 Elly」/「小马 Polly」），用于拒绝剧本式名标签开头
    const personaName = persona.split("：")[0];
    const isUnacceptable = (text: string) =>
      !text ||
      this.isFillerDuplicate(text, recentFillers) ||
      this.isPersonaLabeled(text, personaName);

    const call = (extraInstruction?: string) => {
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
      return this.llmService.complete({
        scene: "filler",
        deviceId: params.device?.id,
        turnId: params.turnId,
        messages,
        model: this.llmService.smallModelName,
        maxTokens: 60,
        timeoutMs: 3000,
      });
    };

    try {
      const first = (await call()).text.trim();
      if (!isUnacceptable(first)) {
        return first;
      }
      const retry = (
        await call(
          "Your previous attempt was rejected: it repeats a recently used opener or starts with your own name like a script label. Produce a COMPLETELY different sentence — different words, different structure, no name label.",
        )
      ).text.trim();
      if (!isUnacceptable(retry)) {
        return retry;
      }
      return this.fillerFallback(asrText, recentFillers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Filler generation failed, skipped: ${message}`);
      return "";
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

  /** 拒绝剧本式名标签开头（「小象 Elly：…」）；名字内部空白容忍零到多个 */
  private isPersonaLabeled(text: string, personaName: string): boolean {
    const escape = (segment: string) =>
      segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = personaName.split(/\s+/).map(escape).join("\\s*");
    return new RegExp(`^${pattern}[：:,，]?\\s*`, "i").test(text);
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
