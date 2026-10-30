import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RagService } from "@/modules/rag/rag.service";
import { LlmService } from "@/modules/llm/llm.service";
import { ChildMemoriesService } from "@/modules/child-memories/child-memories.service";
import { VendorTextInDto } from "./dto/vendor-text-in.dto";
import { VendorTextOutDto } from "./dto/vendor-text-out.dto";
import { VendorStatusDto } from "./dto/vendor-status.dto";
import { VendorBindDto } from "./dto/vendor-bind.dto";
import { VendorConversationDto } from "./dto/vendor-conversation.dto";
import { VendorReplyUploader } from "./vendor-reply.uploader";
import { LlmMessage } from "@/modules/llm/llm.service";
import {
  AdventureReply,
  AdventureService,
} from "@/modules/adventure/adventure.service";

type StoryIntent =
  | "adventure_story"
  | "english_story"
  | "idiom_story"
  | "free_story"
  | "not_story";

/**
 * 机芯厂-facing 业务服务
 * 处理 WebSocket 文字通道、设备状态上报、绑定回调、对话落库等。
 */
@Injectable()
export class VendorService {
  private readonly logger = new Logger(VendorService.name);
  private readonly defaultTextbookId: string;
  private readonly defaultUnitId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly ragService: RagService,
    private readonly llmService: LlmService,
    private readonly replyUploader: VendorReplyUploader,
    private readonly adventureService: AdventureService,
    private readonly childMemoriesService: ChildMemoriesService,
  ) {
    this.defaultTextbookId =
      this.configService.get<string>("DEFAULT_TEXTBOOK_ID") ||
      "sample-textbook";
    this.defaultUnitId =
      this.configService.get<string>("DEFAULT_UNIT_ID") || "unit-1";

    this.adventureService.registerTimeoutListener(
      async (deviceInternalId, adventureReply) => {
        const device = await this.prisma.device.findUnique({
          where: { id: deviceInternalId },
        });
        if (!device) {
          this.logger.warn(
            `Adventure timeout skipped, device not found: ${deviceInternalId}`,
          );
          return;
        }
        await this.sendAdventureReply(device, adventureReply);
      },
    );
  }

  async ensureDeviceExists(deviceId: string) {
    const existing = await this.prisma.device.findUnique({
      where: { deviceId },
    });
    if (existing) {
      return existing;
    }
    return this.prisma.device.create({
      data: { deviceId },
    });
  }

  /**
   * 解析本次对话使用的教材与单元
   * 优先级：payload > 设备当前生效配置 > .env 默认值
   */
  private async resolveTextbookAndUnit(
    dto: VendorTextInDto,
    deviceInternalId: string,
  ): Promise<{ textbookId: string; unitId: string }> {
    if (dto.textbookId && dto.unitId) {
      return { textbookId: dto.textbookId, unitId: dto.unitId };
    }

    const activeConfig = await this.resolveActiveConfig(deviceInternalId);

    return {
      textbookId:
        dto.textbookId || activeConfig?.textbookId || this.defaultTextbookId,
      unitId: dto.unitId || activeConfig?.unitId || this.defaultUnitId,
    };
  }

  /**
   * 查询设备当前生效配置
   */
  private async resolveActiveConfig(deviceInternalId: string) {
    return this.prisma.deviceConfig.findFirst({
      where: { deviceId: deviceInternalId, isActive: true },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * 查询设备对应的孩子档案
   */
  private async getChildProfile(deviceInternalId: string) {
    return this.prisma.childProfile.findUnique({
      where: { deviceId: deviceInternalId },
    });
  }

  /**
   * 根据当前模式解析对应的 prompt 模板
   * - free_chat 模式：从 ConversationMode.promptTemplate 读取
   * - 教材相关模式：从 Textbook.promptTemplate 读取
   */
  private async resolvePromptTemplate(
    mode: string | null | undefined,
    textbookId: string | null | undefined,
    conversationModeKey: string | null | undefined,
  ): Promise<string | undefined> {
    if (mode === "free_chat" && conversationModeKey) {
      const conversationMode = await this.prisma.conversationMode.findFirst({
        where: { key: conversationModeKey },
        select: { promptTemplate: true },
      });
      return conversationMode?.promptTemplate ?? undefined;
    }

    if (textbookId) {
      const textbook = await this.prisma.textbook.findUnique({
        where: { textbookId },
        select: { promptTemplate: true },
      });
      return textbook?.promptTemplate ?? undefined;
    }

    return undefined;
  }

  /**
   * 校验对话上下文是否有效
   * - free_chat 模式不强制校验 textbook/unit
   * - locked_unit / textbook_learning 模式要求 textbookId 与 unitId 真实存在
   */
  private async validateConversationContext(
    mode: string | null | undefined,
    textbookId: string,
    unitId: string,
  ): Promise<boolean> {
    if (mode === "free_chat") {
      return true;
    }

    const textbook = await this.prisma.textbook.findUnique({
      where: { textbookId },
    });

    if (!textbook) {
      return false;
    }

    const unit = await this.prisma.unit.findUnique({
      where: {
        textbookId_unitId: {
          textbookId: textbook.id,
          unitId,
        },
      },
    });

    return !!unit;
  }

  /**
   * 获取同一设备、同一教材、同一单元的最近消息历史
   * 用于 prompt 拼接，保证多轮对话上下文连续且单元边界隔离
   *
   * 落库口径（边界方案 3）：assistant 行 content = filler+"\n"+answer 播报全文，
   * 边界结构化存 rawPayload { filler, answer }。
   * - 大模型历史只取 answer 部分，filler 话术不进上下文
   *   （避免大模型学着重复寒暄，与 prompt 规则 12 对齐）；
   * - 无边界信息的旧 assistant 行整条跳过（用户决策：不做 backfill、不回落全文）；
   * - recentFillers 返回最近 5 轮 filler 原文（时间正序），供小模型禁用清单。
   */
  private async getRecentHistory(
    deviceInternalId: string,
    textbookId: string,
    unitId: string,
    limit = 12, // 消息条数，约 6 轮问答
  ): Promise<{
    history: Array<{ role: "user" | "assistant"; content: string }>;
    recentFillers: string[];
  }> {
    const rows = await this.prisma.message.findMany({
      where: {
        deviceId: deviceInternalId,
        textbookId,
        unitId,
      },
      orderBy: { spokeAt: "desc" },
      take: limit,
      select: { role: true, content: true, rawPayload: true },
    });

    // 按时间正序排列，旧 → 新
    const chronological = rows.reverse();

    const history: Array<{ role: "user" | "assistant"; content: string }> = [];
    const fillers: string[] = [];
    for (const row of chronological) {
      if (row.role === "user") {
        history.push({ role: "user", content: row.content });
        continue;
      }
      // assistant 行：无边界信息的旧行跳过
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

  private isStoryCandidate(asrText: string): boolean {
    return /故事|冒险|风铃树|再听一遍|继续讲|接着讲|story|adventure/i.test(
      asrText,
    );
  }

  private fallbackStoryIntent(asrText: string): StoryIntent {
    if (/英语|英文|english/i.test(asrText)) {
      return "english_story";
    }
    if (/成语|idiom/i.test(asrText)) {
      return "idiom_story";
    }
    if (/冒险|风铃树|再听一遍|继续.*故事|接着.*故事/i.test(asrText)) {
      return "adventure_story";
    }
    return this.isStoryCandidate(asrText) ? "free_story" : "not_story";
  }

  /** 小模型只做语义分类；每日状态与路由权限始终由后端决定。 */
  private async classifyStoryIntent(asrText: string): Promise<StoryIntent> {
    // TODO(可用性)：灰度补充分类模型超时、限流与非法输出的真实指标。
    try {
      const result = await this.llmService.complete({
        model: this.llmService.smallModelName,
        temperature: 0,
        maxTokens: 10,
        messages: [
          {
            role: "system",
            content:
              "你是儿童语音产品的故事意图分类器。只输出一个标签，禁止解释：" +
              "adventure_story（每日互动冒险、续听或重听已播冒险）；" +
              "english_story（英语故事或英语口语陪练）；" +
              "idiom_story（成语故事）；free_story（泛化的听故事或自由创作故事）；" +
              "not_story（不是故事请求）。孩子表达含糊时按字面选择最接近标签。",
          },
          { role: "user", content: `孩子的话：${asrText}` },
        ],
      });
      const text = result.text.trim().toLowerCase();
      const intents: StoryIntent[] = [
        "adventure_story",
        "english_story",
        "idiom_story",
        "free_story",
        "not_story",
      ];
      return (
        intents.find((intent) => text.includes(intent)) ||
        this.fallbackStoryIntent(asrText)
      );
    } catch (error) {
      this.logger.warn(
        `Story intent classification failed, keyword fallback used: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.fallbackStoryIntent(asrText);
    }
  }

  private storyPrompt(intent: StoryIntent): string | undefined {
    switch (intent) {
      case "english_story":
        return "Tell a short, warm English story for a young child, then invite one simple spoken response.";
      case "idiom_story":
        return "讲一个适合孩子的成语故事，用口语解释成语含义，但不要冒险入每日互动冒险剧情。";
      case "adventure_story":
      case "free_story":
        return "请自由创作一个适合孩子的短故事，温暖、有画面感，不进入或复述每日互动冒险的固定剧情。";
      default:
        return undefined;
    }
  }

  async handleTextIn(dto: VendorTextInDto): Promise<VendorTextOutDto> {
    // 4G 状态下设备可能尚未被家长绑定，先确保 Device 记录存在
    const device = await this.ensureDeviceExists(dto.deviceId);

    // 等待互动时优先交给冒险状态机，避免把选项回答误分类成新故事。
    const adventureReply = await this.adventureService.handleChildReply(
      device.id,
      dto.asrText,
    );
    if (adventureReply) {
      return this.sendAdventureReply(device, adventureReply, dto.asrText);
    }

    let storyIntent: StoryIntent | null = null;
    if (this.isStoryCandidate(dto.asrText)) {
      storyIntent = await this.classifyStoryIntent(dto.asrText);
      const completedToday = await this.adventureService.isCompletedToday(
        device.id,
      );
      if (
        !completedToday &&
        (storyIntent === "adventure_story" || storyIntent === "free_story")
      ) {
        // 泛化“我想听故事”在今日冒险未完成时优先进入冒险。
        const startedAdventure = await this.adventureService.startToday(
          device.id,
          true,
        );
        if (startedAdventure) {
          return this.sendAdventureReply(device, startedAdventure, dto.asrText);
        }
      }
      if (completedToday) {
        await this.adventureService.recordEntryBlocked(
          device.id,
          storyIntent === "adventure_story" ? "free_story" : storyIntent,
        );
      }
    }

    const activeConfig = await this.resolveActiveConfig(device.id);
    const { textbookId, unitId } = await this.resolveTextbookAndUnit(
      dto,
      device.id,
    );

    const storyMode = storyIntent && storyIntent !== "not_story";
    const mode = storyMode
      ? "free_chat"
      : (activeConfig?.mode ?? "locked_unit");

    // free_chat 不涉及教材：快照置空,避免 .env 默认教材/单元污染统计口径
    const stampTextbookId = mode === "free_chat" ? null : textbookId;
    const stampUnitId = mode === "free_chat" ? null : unitId;

    // 校验对话上下文是否有效，无效则整轮不落库，避免脏数据
    const contextValid = await this.validateConversationContext(
      mode,
      textbookId,
      unitId,
    );

    // 获取同单元最近消息历史，用于 prompt 拼接
    // 必须在写入本轮 user 消息之前取，避免把当前话术重复拼进 prompt
    const { history, recentFillers } = await this.getRecentHistory(
      device.id,
      textbookId,
      unitId,
    );

    // user 消息收到即落库，不等待 LLM（LLM 故障只影响后续 assistant 行）
    const turnId = randomUUID();
    const sourceOccurredAt = new Date();
    if (contextValid) {
      await this.prisma.message.create({
        data: {
          deviceId: device.id,
          turnId,
          role: "user",
          content: dto.asrText,
          status: "completed",
          textbookId: stampTextbookId,
          unitId: stampUnitId,
          mode,
          conversationModeKey: activeConfig?.conversationModeKey ?? null,
          rawPayload: dto as any,
          spokeAt: sourceOccurredAt,
        },
      });

      // 长期记忆异步提取，不阻塞 filler 首音；失败只影响记忆写入。
      const previousAssistant = [...history]
        .reverse()
        .find((message) => message.role === "assistant")?.content;
      void this.childMemoriesService
        .extractAndStore({
          deviceId: device.id,
          turnId,
          asrText: dto.asrText,
          previousAssistant,
          sourceOccurredAt,
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Child memory extraction failed for deviceId=${dto.deviceId}: ${message}`,
          );
        });
    }

    // 读取孩子档案与当前模式对应的 prompt 模板
    const childProfile = await this.getChildProfile(device.id);
    const promptTemplate = storyMode
      ? this.storyPrompt(storyIntent)
      : await this.resolvePromptTemplate(
          mode,
          textbookId,
          activeConfig?.conversationModeKey,
        );

    // RAG 检索教材内容
    const retrieveResult = await this.ragService.retrieve(
      textbookId,
      unitId,
      dto.asrText,
    );

    const context = retrieveResult.found
      ? this.ragService.truncateContent(retrieveResult.content, 1500)
      : "";
    const promptOptions = {
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
    };

    // 只在自由对话主回答中注入相关记忆；filler 和其他对话模式不使用。
    let memoryPrompt: { text: string; memoryIds: string[] } = {
      text: "",
      memoryIds: [],
    };
    if (mode === "free_chat") {
      try {
        memoryPrompt = await this.childMemoriesService.buildPromptBlock(
          device.id,
          dto.asrText,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Child memory recall failed for deviceId=${dto.deviceId}: ${message}`,
        );
      }
    }

    const baseMessages = this.llmService.buildEnglishTutorPrompt(
      dto.asrText,
      context,
      retrieveResult.unitName,
      history,
      promptOptions,
    );
    const messages: LlmMessage[] = memoryPrompt.text
      ? [{ role: "system", content: memoryPrompt.text }, ...baseMessages]
      : baseMessages;

    // 流式开关：LLM_STREAM_ENABLED=false 时整体回落到非流式单模型路径
    const streamEnabled =
      this.configService.get<string>("LLM_STREAM_ENABLED") !== "false";

    let responseText: string;
    let llmFailed = false;
    // 落库边界（方案 3）：rawPayload { filler, answer }；非流式路径 filler=null
    let filler: string | null = null;
    let answer = "";
    if (streamEnabled) {
      ({ responseText, llmFailed, filler, answer } =
        await this.generateStreamReply(dto, turnId, messages, recentFillers));
    } else {
      try {
        const llmResult = await this.llmService.complete({ messages });
        responseText = llmResult.text;
      } catch (error) {
        llmFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `LLM failed for deviceId=${dto.deviceId}: ${message}`,
        );
        responseText = "Sorry, I didn't catch that. Could you say it again?";
      }
      answer = responseText;
    }

    const reply: VendorTextOutDto = {
      deviceId: dto.deviceId,
      responseText,
      context: {
        textbookId,
        unitId,
        unitName: retrieveResult.unitName,
        ragFound: retrieveResult.found,
      },
      ttsOptions: {},
    };

    // 流式路径：全量回复同样经出站 WS 上传，作为 chunk 流之后的兜底/存档
    if (streamEnabled) {
      try {
        await this.replyUploader.sendFullReply(reply);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to upload full reply for deviceId=${dto.deviceId}: ${message}`,
        );
      }
    }

    this.logger.debug(
      `handleTextIn deviceId=${dto.deviceId}, asrText=${dto.asrText}, mode=${mode}, textbookId=${textbookId}, unitId=${unitId}`,
    );

    // 补写 assistant 消息；LLM 失败时标 failed,与真实回答可区分
    if (contextValid) {
      await this.prisma.message.create({
        data: {
          deviceId: device.id,
          turnId,
          role: "assistant",
          content: reply.responseText,
          status: llmFailed ? "failed" : "completed",
          textbookId: stampTextbookId,
          unitId: stampUnitId,
          mode,
          conversationModeKey: activeConfig?.conversationModeKey ?? null,
          // 边界标注（方案 3）：content 保持播报全文纯净，
          // filler/answer 边界结构化存 rawPayload，供历史剥离与多样性统计
          rawPayload: { filler, answer },
          spokeAt: new Date(),
        },
      });
    } else {
      this.logger.warn(
        `Invalid conversation context skipped: mode=${mode}, textbookId=${textbookId}, unitId=${unitId}`,
      );
    }

    if (!llmFailed && memoryPrompt.memoryIds.length > 0) {
      try {
        await this.childMemoriesService.markInjected(memoryPrompt.memoryIds);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Failed to mark child memories injected for deviceId=${dto.deviceId}: ${message}`,
        );
      }
    }

    return reply;
  }

  /**
   * 冒险回复复用既有 chunk 通道：每个定稿段落一个 answer chunk，
   * 逐次 await 对端 ack，最后显式收尾并发送全量兜底。
   */
  private async sendAdventureReply(
    device: { id: string; deviceId: string },
    adventureReply: AdventureReply,
    asrText?: string,
  ): Promise<VendorTextOutDto> {
    const turnId = randomUUID();
    const responseText = adventureReply.texts.join("\n");
    const reply: VendorTextOutDto = {
      deviceId: device.deviceId,
      responseText,
      context: { adventure: true },
      ttsOptions: {},
    };

    if (asrText) {
      await this.prisma.message.create({
        data: {
          deviceId: device.id,
          turnId,
          role: "user",
          content: asrText,
          status: "completed",
          textbookId: null,
          unitId: null,
          mode: "adventure_story",
          conversationModeKey: null,
          rawPayload: { asrText },
          spokeAt: new Date(),
        },
      });
    }

    let seq = 0;
    const emit = async (delta: string, isFinal: boolean) => {
      try {
        await this.replyUploader.sendChunk({
          deviceId: device.deviceId,
          turnId,
          seq: seq++,
          source: "answer",
          delta,
          isFinal,
        });
      } catch (error) {
        this.logger.error(
          `Failed to upload adventure chunk for deviceId=${device.deviceId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };

    for (const text of adventureReply.texts) {
      await emit(text, false);
    }
    await emit("", true);

    // 计时从引导词最后一个 chunk 的上传 ack 后开始，而非 LLM 生成时开始。
    if (adventureReply.action === "await_reply") {
      await this.adventureService.markPromptPlaybackComplete(device.id);
    }

    try {
      await this.replyUploader.sendFullReply(reply);
    } catch (error) {
      this.logger.error(
        `Failed to upload full adventure reply for deviceId=${device.deviceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    await this.prisma.message.create({
      data: {
        deviceId: device.id,
        turnId,
        role: "assistant",
        content: responseText,
        status: "completed",
        textbookId: null,
        unitId: null,
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
    await this.adventureService.recordPresented(
      device.id,
      turnId,
      adventureReply,
    );

    return reply;
  }

  /**
   * 双模型流式回复（首响加速）
   * 1) 大模型流由后台泵并发消费、先进缓冲，不直接外发；
   * 2) 小模型 filler chunk（打哈哈首响）到达即按 seq 外发；
   * 3) filler 收尾后按到达顺序 drain 大模型缓冲，再继续转发后续 chunk；
   * 每次发送 await 机芯厂 WS ack，保证 WS 接口调用顺序严格对齐：
   * filler 全部先于 answer，seq 全局递增。
   * 小模型失败仅跳过 filler；大模型失败回落兜底文案（与旧路径一致）；
   * 单个 chunk 上传失败只记日志并继续，不阻断本轮剩余回复。
   * 返回的 responseText 为用户实际播报全文：filler + "\n" + answer
   * （filler 缺失/失败时仅 answer），落库与全量上传均使用该全文。
   *
   * 防死空气设计：filler 音频（prompt 约束 ≥10 字/≥6 词，约 1.5~2 秒）是
   * 等待大模型首 chunk 的天然缓冲；drain 循环无限等 answer，无硬失败。
   * filler→answer 首 chunk 的 gap 每轮打日志，灰度期用 P95 校验覆盖率。
   *
   * 备用方案 C（暂不实施，仅当灰度 gap P95 超 filler 音频时长时启动）：
   * filler 收尾后设 ~800ms 宽限窗口，answer 首 chunk 未到则发 1~2 句
   * 预置静态桥接句（如「让我想一想哦……」，走 filler 通道、seq 连续、
   * 不调 LLM），把覆盖能力推到 answer TTFT 4~5 秒；仍不到走既有降级。
   */
  private async generateStreamReply(
    dto: VendorTextInDto,
    turnId: string,
    messages: LlmMessage[],
    recentFillers: string[] = [],
  ): Promise<{
    responseText: string;
    llmFailed: boolean;
    filler: string | null;
    answer: string;
  }> {
    let seq = 0;
    const emit = async (
      source: "filler" | "answer",
      delta: string,
      isFinal: boolean,
    ) => {
      await this.replyUploader.sendChunk({
        deviceId: dto.deviceId,
        turnId,
        seq: seq++,
        source,
        delta,
        isFinal,
      });
    };

    // 大模型流：后台泵入缓冲，等待 filler 阶段结束后统一 drain
    const buffered: string[] = [];
    let pumpDone = false;
    let pumpFailure: unknown = null;
    let notify: (() => void) | null = null;
    const wake = () => {
      const fn = notify;
      notify = null;
      if (fn) fn();
    };

    const pump = (async () => {
      try {
        const answerStream = this.llmService.completeStream({ messages });
        for await (const delta of answerStream) {
          buffered.push(delta);
          wake();
        }
      } catch (error) {
        pumpFailure = error;
      } finally {
        pumpDone = true;
        wake();
      }
    })();

    // 小模型 filler 阶段：失败（含上传失败）只记日志并跳过，不影响正式回答
    let fillerEmitted = 0;
    let fillerText = "";
    try {
      const fillerStream = this.llmService.completeStream({
        messages: this.llmService.buildFillerPrompt(dto.asrText, recentFillers),
        model: this.llmService.smallModelName,
        maxTokens: 60,
      });
      for await (const delta of fillerStream) {
        await emit("filler", delta, false);
        fillerText += delta;
        fillerEmitted += 1;
      }
      if (fillerEmitted > 0) {
        // filler 阶段显式收尾，机芯厂据此切换到 answer 流
        await emit("filler", "", true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Filler stream failed for deviceId=${dto.deviceId}: ${message}`,
      );
    }

    // drain：先吐缓冲，再边到边发；单 chunk 上传失败不阻断后续
    const fillerDoneAt = Date.now();
    let firstAnswerLogged = false;
    const emitAnswer = async (delta: string, isFinal: boolean) => {
      try {
        await emit("answer", delta, isFinal);
        // 防死空气观测（方案 B）：记录 filler 完毕 → answer 首 chunk 的 gap，
        // 灰度期看 P95 是否小于 filler 音频时长（约 1.5s），超则启用备用方案 C
        if (!firstAnswerLogged && delta.length > 0 && fillerEmitted > 0) {
          firstAnswerLogged = true;
          this.logger.log(
            `stream gap filler→answer: ${Date.now() - fillerDoneAt}ms ` +
              `(deviceId=${dto.deviceId}, turnId=${turnId})`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to upload answer chunk for deviceId=${dto.deviceId}: ${message}`,
        );
      }
    };

    let answerText = "";
    for (;;) {
      const delta = buffered.shift();
      if (delta !== undefined) {
        answerText += delta;
        await emitAnswer(delta, false);
        continue;
      }
      if (pumpDone) break;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
    await pump;

    let llmFailed = false;
    if (pumpFailure) {
      llmFailed = true;
      const message =
        pumpFailure instanceof Error
          ? pumpFailure.message
          : String(pumpFailure);
      this.logger.error(`LLM failed for deviceId=${dto.deviceId}: ${message}`);
      answerText = "Sorry, I didn't catch that. Could you say it again?";
      await emitAnswer(answerText, false);
    }
    await emitAnswer("", true);

    // 用户实际播报全文：filler（如有）+ 大模型答案，作为最终回答落库
    const responseText = fillerText
      ? `${fillerText}\n${answerText}`
      : answerText;

    return {
      responseText,
      llmFailed,
      filler: fillerText || null,
      answer: answerText,
    };
  }

  async handleStatusReport(dto: VendorStatusDto) {
    // TODO: 缓存设备状态到 Redis，供小程序查询
    this.logger.debug(
      `handleStatusReport deviceId=${dto.deviceId}, online=${dto.online}`,
    );
    return { success: true, deviceId: dto.deviceId };
  }

  async handleBindCallback(dto: VendorBindDto) {
    // TODO: 更新设备绑定关系
    this.logger.debug(
      `handleBindCallback deviceId=${dto.deviceId}, bound=${dto.bound ?? true}`,
    );
    return { success: true, deviceId: dto.deviceId, bound: dto.bound ?? true };
  }

  async handleConversationBackup(
    dto: VendorConversationDto,
    idempotencyKey?: string,
  ) {
    // TODO: 幂等写入对话记录，idempotencyKey 去重
    this.logger.debug(
      `handleConversationBackup deviceId=${dto.deviceId}, idempotencyKey=${idempotencyKey ?? "none"}`,
    );
    return { success: true, idempotencyKey: idempotencyKey || null };
  }

  getHealth() {
    // TODO: 可扩展为检查数据库、Redis、LLM 可用性
    return {
      status: "up",
      timestamp: Date.now(),
      expectedRecovery: null,
    };
  }
}
