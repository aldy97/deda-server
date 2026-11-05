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
import { LlmService, LlmMessage } from "@/modules/llm/llm.service";
import { ChildMemoriesService } from "@/modules/child-memories/child-memories.service";
import {
  ConversationIntent,
  ConversationSessionService,
} from "@/modules/vendor/conversation-session.service";
import { SleepConfigsService } from "@/modules/sleep-configs/sleep-configs.service";
import { SleepVoiceConfigService } from "@/modules/sleep-configs/sleep-voice-config.service";
import {
  BlockedSafetyCategory,
  ChildSafetyService,
} from "@/modules/vendor/child-safety.service";
import { ChatCompletionRequest } from "./dto/chat-completion.dto";

/** 上游故障时的兜底话术：保证设备端有声音，不让孩子面对沉默 */
const UPSTREAM_FALLBACK_TEXT =
  "Sorry, I didn't catch that. Can you say it again?";

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
 * Bearer 鉴权 → 设备解析（header 优先，fallback user 字段=设备 MAC）
 * → L1 安全闸 → L2 分类 + 意图路由并行 → sleep_config 确定性短链路
 * → mode 决策 → DB 历史 → user 落库 → 异步记忆提取 → 记忆注入
 * → LlmService.completeStream → assistant 落库 → markInjected。
 *
 * 无设备标识时降级为匿名链路：不落库、无记忆、无意图路由、固定
 * free_chat、用客户端历史。
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

    // L1 安全闸：显式敏感词零延迟拦截，优先于一切 LLM 调用
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
        await this.persistTurn(device.id, asrText, canned, "completed", {
          filler: null,
          answer: canned,
          safetyCategory: verdict.category,
          safetyLayer: "L1",
        });
      }
      yield canned;
      return;
    }

    // L2 语义安全分类与意图路由并行（同老链路 Promise.all）：
    // L2 补 L1 字面盲区，分类异常 fail-open 由 L3 兜底；
    // 意图路由依赖按设备的会话状态，匿名链路跳过、固定 free_chat。
    const [l2, intent] = await Promise.all([
      this.safeClassifyL2(asrText),
      device
        ? this.safeResolveIntent(device.id, asrText)
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
        await this.persistTurn(device.id, asrText, canned, "completed", {
          filler: null,
          answer: canned,
          safetyCategory: l2.category,
          safetyLayer: "L2",
        });
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

    // 修改哄睡设置：独立短链路，确定性话术确认，不进大模型主链路
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

    // mode 决策对齐老链路：故事类意图戳对应模式；adventure_story/free_story
    // 在 2B 阶段冒险未接入，按老链路"冒险未开始"的降级处理戳设备配置；
    // 其余按设备配置 english_chat/free_chat。
    const activeConfig = device
      ? await this.resolveActiveConfig(device.id)
      : null;
    const mode = STORY_INTENTS.includes(intent)
      ? intent
      : activeConfig?.mode === "english_chat"
        ? "english_chat"
        : "free_chat";

    // 哄睡语音指令持久化内容偏好（一律落库，家长端可见；失败不阻塞本轮）
    if (device && intent === "sleep_story") {
      await this.applySleepVoiceConfig(device.id, asrText);
    }

    // 有设备时历史以 DB 为准（防客户端伪造上下文）；匿名保持客户端历史。
    // 必须在写入本轮 user 消息之前取，避免把当前话术重复拼进 prompt。
    const history = device
      ? await this.getDbHistory(device.id, mode)
      : this.extractHistory(req);

    // user 消息收到即落库，不等待 LLM（LLM 故障只影响后续 assistant 行）
    const turnId = randomUUID();
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

    // 只在非故事主回答中注入相关记忆（同老链路口径）
    let memoryPrompt: { text: string; memoryIds: string[] } = {
      text: "",
      memoryIds: [],
    };
    if (device && intent === "free_chat") {
      try {
        memoryPrompt = await this.childMemories.buildPromptBlock(
          device.id,
          asrText,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Child memory recall failed for device=${device.deviceId}: ${message}`,
        );
      }
    }

    // prompt 组装：故事意图用故事话术，自由对话按子模式模板，
    // 孩子档案注入称呼/年龄上下文（均对齐老链路）
    const childProfile = device ? await this.getChildProfile(device.id) : null;
    const promptTemplate = STORY_INTENTS.includes(intent)
      ? this.storyPrompt(intent)
      : intent === "adventure_story" || intent === "free_story"
        ? this.storyPrompt(intent)
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
          }
        : undefined,
      promptTemplate,
      mode,
      conversationModeKey: activeConfig?.conversationModeKey ?? undefined,
    });
    const messages: LlmMessage[] = [
      ...baiduSystem,
      ...(emotionalHarmGuidance ? [emotionalHarmGuidance] : []),
      ...(memoryPrompt.text
        ? [{ role: "system" as const, content: memoryPrompt.text }]
        : []),
      ...built,
    ];

    let yielded = false;
    let answerText = "";
    let llmFailed = false;
    try {
      const stream = this.llmService.completeStream({
        messages,
        maxTokens: 200,
        thinking: { type: "disabled" },
      });
      for await (const chunk of stream) {
        yielded = true;
        answerText += chunk;
        yield chunk;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`LLM upstream failed: ${message}`);
      llmFailed = true;
      if (!yielded) {
        answerText = UPSTREAM_FALLBACK_TEXT;
        yield UPSTREAM_FALLBACK_TEXT;
      }
    }

    // 补写 assistant 消息；LLM 失败时标 failed，与真实回答可区分
    if (device) {
      await this.prisma.message.create({
        data: {
          deviceId: device.id,
          turnId,
          role: "assistant",
          content: answerText,
          status: llmFailed ? "failed" : "completed",
          mode,
          conversationModeKey: activeConfig?.conversationModeKey ?? null,
          rawPayload: { filler: null, answer: answerText },
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
   * 解析设备身份：显式 header 优先，fallback 请求体 user 字段。
   * 机芯厂约定 user = 设备 MAC；MAC 归一化（去分隔符、小写）后
   * 同时按 deviceId / macAddress 两列匹配，查不到则以原值建档
   * （同老链路 ensureDeviceExists 的 4G 未绑定场景语义）。
   */
  private async resolveDevice(
    req: ChatCompletionRequest,
    deviceHint?: string,
  ): Promise<{ id: string; deviceId: string } | null> {
    const raw = (deviceHint ?? req.user)?.trim();
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
      return { id: existing.id, deviceId: existing.deviceId };
    }
    const created = await this.prisma.device.create({
      data: {
        deviceId: raw,
        macAddress: MAC_PATTERN.test(raw) ? this.normalizeMac(raw) : null,
      },
    });
    return { id: created.id, deviceId: created.deviceId };
  }

  /** MAC 归一化：AA:BB:CC:DD:EE:FF / AA-BB-.. / aabb.. → aabbccddeeff */
  private normalizeMac(value: string): string {
    if (!MAC_PATTERN.test(value)) return value;
    return value.replace(/[:-]/g, "").toLowerCase();
  }

  /** L2 语义分类包装：任何异常 fail-open 返回 null，由 L3 兜底 */
  private async safeClassifyL2(asrText: string) {
    try {
      return await this.childSafety.classifyL2(asrText);
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
  ): Promise<ConversationIntent> {
    try {
      return await this.conversationSession.resolve(deviceInternalId, asrText);
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
   * 2C 接入冒险状态机前，adventure_story/free_story 统一走
   * 「自由创作、不承诺冒险」的降级话术（对齐老链路冒险未开始分支）。
   */
  private storyPrompt(intent: ConversationIntent): string | undefined {
    switch (intent) {
      case "english_story":
        return "Tell a short, warm English story for a young child, then invite one simple spoken response.";
      case "idiom_story":
        return "讲一个适合孩子的成语故事，用口语解释成语含义，但不要冒险入每日互动冒险剧情。";
      case "sleep_story":
        return "用平静、缓慢、适合哄睡的语气讲一个温柔短故事；不要提问、不要邀请互动、不要让孩子做决定，逐渐安静收尾。";
      case "adventure_story":
      case "free_story":
        return "请自由创作一个适合孩子的短故事，温暖、有画面感，不进入或复述每日互动冒险的固定剧情。每日冒险当前不可进入，不要承诺开始、重播或继续冒险，也不要虚构冒险进度。";
      default:
        return undefined;
    }
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
   * answer；无边界信息的旧 assistant 行跳过。口径同老链路 getRecentHistory。
   */
  private async getDbHistory(
    deviceInternalId: string,
    mode: string,
  ): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const rows = await this.prisma.message.findMany({
      where: { deviceId: deviceInternalId, mode },
      orderBy: { spokeAt: "desc" },
      take: DB_HISTORY_LIMIT,
      select: { role: true, content: true, rawPayload: true },
    });

    const history: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const row of rows.reverse()) {
      if (row.role === "user") {
        history.push({ role: "user", content: row.content });
        continue;
      }
      const answer = LlmService.extractAnswer(row.content, row.rawPayload);
      if (answer !== null) {
        history.push({ role: "assistant", content: answer });
      }
    }
    return history;
  }

  /** 安全/短链路回复的成对落库（user 原文 + assistant 兜底话术） */
  private async persistTurn(
    deviceInternalId: string,
    asrText: string,
    replyText: string,
    status: "completed" | "failed",
    assistantPayload: Prisma.InputJsonValue,
  ): Promise<void> {
    const turnId = randomUUID();
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
