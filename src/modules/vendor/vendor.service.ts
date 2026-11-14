import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import { PromptRegistryService } from "@/modules/prompt-registry/prompt-registry.service";
import { ChildMemoriesService } from "@/modules/child-memories/child-memories.service";
import { VendorTextInDto } from "./dto/vendor-text-in.dto";
import { VendorTextOutDto } from "./dto/vendor-text-out.dto";
import { VendorStatusDto } from "./dto/vendor-status.dto";
import { VendorBindDto } from "./dto/vendor-bind.dto";
import { VendorConversationDto } from "./dto/vendor-conversation.dto";
import { VendorReplyUploader } from "./vendor-reply.uploader";
import { SleepConfigsService } from "@/modules/sleep-configs/sleep-configs.service";
import { SleepVoiceConfigService } from "@/modules/sleep-configs/sleep-voice-config.service";
import { LlmMessage } from "@/modules/llm/llm.service";
import {
  AdventureReply,
  AdventureService,
} from "@/modules/adventure/adventure.service";
import {
  ConversationIntent,
  ConversationSessionService,
} from "./conversation-session.service";
import { markPreviousReplyInterrupted } from "@/common/interruption/interruption.util";
import {
  BlockedSafetyCategory,
  ChildSafetyService,
  SafetyVerdict,
} from "./child-safety.service";

/**
 * 机芯厂-facing 业务服务
 * 处理 WebSocket 文字通道、设备状态上报、绑定回调、对话落库等。
 */
@Injectable()
export class VendorService {
  private readonly logger = new Logger(VendorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly llmService: LlmService,
    private readonly replyUploader: VendorReplyUploader,
    private readonly adventureService: AdventureService,
    private readonly childMemoriesService: ChildMemoriesService,
    private readonly conversationSessionService: ConversationSessionService,
    private readonly childSafetyService: ChildSafetyService,
    private readonly sleepConfigsService: SleepConfigsService,
    private readonly sleepVoiceConfigService: SleepVoiceConfigService,
    private readonly promptRegistry: PromptRegistryService,
  ) {
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
   * 哄睡语音指令持久化内容偏好（一律落库，家长端可见）：
   * 「我要听睡前儿歌」→ contentType=song；「我要听睡前故事」→ story。
   * 儿歌内容源上线前 song/mixed 降级为故事播放。
   * 持久化失败不影响本轮哄睡回复。
   */
  private async applySleepVoiceConfig(
    deviceInternalId: string,
    asrText: string,
  ): Promise<void> {
    try {
      if (/儿歌|童谣|唱歌|催眠曲/.test(asrText)) {
        await this.sleepConfigsService.applyVoiceUpdate(deviceInternalId, {
          contentType: "song",
        });
      } else if (/睡前故事|哄睡故事|晚安故事/.test(asrText)) {
        await this.sleepConfigsService.applyVoiceUpdate(deviceInternalId, {
          contentType: "story",
        });
      }
      const config =
        await this.sleepConfigsService.getByDeviceId(deviceInternalId);
      if (config && config.contentType !== "story") {
        this.logger.warn(
          `sleep contentType=${config.contentType} not supported yet, playing story (device=${deviceInternalId})`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `applySleepVoiceConfig failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 获取同一设备、同一 mode 的最近消息历史。
   *
   * 落库口径（边界方案 3）：assistant 行 content = filler+"\n"+answer 播报全文，
   * 边界结构化存 rawPayload { filler, answer }。
   * - 大模型历史只取 answer 部分，filler 话术不进上下文；
   * - 无边界信息的旧 assistant 行整条跳过；
   * - recentFillers 返回最近 5 轮 filler 原文（时间正序），供小模型禁用清单。
   */
  private async getRecentHistory(
    deviceInternalId: string,
    mode: string,
    limit = 12, // 消息条数，约 6 轮问答
  ): Promise<{
    history: Array<{ role: "user" | "assistant"; content: string }>;
    recentFillers: string[];
  }> {
    const rows = await this.prisma.message.findMany({
      where: { deviceId: deviceInternalId, mode },
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

  /** 故事意图话术：与 llm-adapter.service.ts 共用注册表实现，不再各存一份副本 */
  private storyPrompt(intent: ConversationIntent): string | undefined {
    return this.promptRegistry.getStoryPrompt(intent);
  }

  async handleTextIn(dto: VendorTextInDto): Promise<VendorTextOutDto> {
    // 4G 状态下设备可能尚未被家长绑定，先确保 Device 记录存在
    const device = await this.ensureDeviceExists(dto.deviceId);

    // 打断推断（方案 A）：新一轮开始即判定上一轮 assistant 回复是否仍在
    // 估算播放窗口内；fire-and-forget，失败只记日志，不阻塞本轮首音
    void markPreviousReplyInterrupted(this.prisma, device.id).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Interruption marking failed for deviceId=${dto.deviceId}: ${message}`,
        );
      },
    );

    // 一轮问答一个 turnId：安全/意图/filler/主回答/消息落库共用，
    // llm_usage_logs 据此把同轮多次 LLM 调用串成链路（模型监控对照视角）
    const turnId = randomUUID();

    // L1 安全闸：显式敏感词零延迟拦截，优先于冒险状态机与一切 LLM 调用
    const l1Verdict = this.childSafetyService.checkL1(dto.asrText);
    if (l1Verdict.blocked) {
      return this.sendSafetyReply(
        device,
        l1Verdict as SafetyVerdict & { category: BlockedSafetyCategory },
        dto.asrText,
        turnId,
      );
    }

    // 等待互动时优先交给冒险状态机，避免把选项回答误分类成新故事。
    const adventureReply = await this.adventureService.handleChildReply(
      device.id,
      dto.asrText,
    );
    if (adventureReply) {
      return this.sendAdventureReply(
        device,
        adventureReply,
        dto.asrText,
        turnId,
      );
    }

    // L2 安全分类与意图路由并行：小模型一次调用，补 L1 语义盲区
    const [storyIntent, l2Verdict] = await Promise.all([
      this.conversationSessionService.resolve(device.id, dto.asrText, turnId),
      this.childSafetyService.classifyL2(dto.asrText, device.id, turnId),
    ]);
    if (l2Verdict.blocked) {
      return this.sendSafetyReply(
        device,
        l2Verdict as SafetyVerdict & { category: BlockedSafetyCategory },
        dto.asrText,
        turnId,
      );
    }
    // 修改哄睡设置：独立短链路，确定性话术确认，不进冒险门禁与大模型主链路
    if (storyIntent === "sleep_config") {
      return this.sendSleepConfigReply(device, dto.asrText, turnId);
    }
    const storyMode = storyIntent !== "free_chat";
    if (storyMode && storyIntent !== "sleep_story") {
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
          await this.conversationSessionService.reset(device.id);
          return this.sendAdventureReply(
            device,
            startedAdventure,
            dto.asrText,
            turnId,
          );
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
    // 故事意图落同名 mode（含 free_story）；adventure_story 走到这里说明
    // 冒险未真正开始（被门禁拦截或无集可播），统一落 free_story；
    // 其余（free_chat 意图）按设备配置兜底 english_chat/free_chat。
    const mode =
      storyIntent === "adventure_story"
        ? "free_story"
        : storyIntent === "english_story" ||
            storyIntent === "idiom_story" ||
            storyIntent === "sleep_story" ||
            storyIntent === "free_story"
          ? storyIntent
          : activeConfig?.mode === "english_chat"
            ? "english_chat"
            : "free_chat";

    if (storyIntent === "sleep_story") {
      await this.applySleepVoiceConfig(device.id, dto.asrText);
    }

    // 必须在写入本轮 user 消息之前取，避免把当前话术重复拼进 prompt。
    const { history, recentFillers } = await this.getRecentHistory(
      device.id,
      mode,
    );

    // user 消息收到即落库，不等待 LLM（LLM 故障只影响后续 assistant 行）。
    // turnId 复用函数顶部生成的轮次 ID（安全/意图日志已带上同一 ID）。
    const sourceOccurredAt = new Date();
    await this.prisma.message.create({
      data: {
        deviceId: device.id,
        turnId,
        role: "user",
        content: dto.asrText,
        status: "completed",
        mode,
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
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Child memory extraction failed for deviceId=${dto.deviceId}: ${message}`,
        );
      });

    // 读取孩子档案与当前模式对应的 prompt 模板
    const childProfile = await this.getChildProfile(device.id);
    const promptTemplate = storyMode
      ? this.storyPrompt(storyIntent)
      : undefined;

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
    };

    // free_chat 全量注入 5 槽位记忆（含软冷却：传入近 5 条 assistant 原文）；
    // filler 和故事模式不使用此块（故事模式走 buildPreferenceBlock 轻量偏好块）。
    let memoryPrompt: { text: string; memoryIds: string[] } = {
      text: "",
      memoryIds: [],
    };
    if (storyIntent === "free_chat") {
      try {
        memoryPrompt = await this.childMemoriesService.buildPromptBlock(
          device.id,
          history
            .filter((message) => message.role === "assistant")
            .slice(-5)
            .map((message) => message.content),
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
      history,
      promptOptions,
    );
    // emotional_harm（攻击性气话）不拦截：注入共情引导 system 消息交给大模型
    const extraSystem: LlmMessage[] = [];
    if (l2Verdict.category === "emotional_harm") {
      extraSystem.push({
        role: "system",
        content: ChildSafetyService.EMOTIONAL_HARM_GUIDANCE,
      });
    }
    if (memoryPrompt.text) {
      // 记忆块贴尾注入（本轮 user 之前）：头部主 system + 历史构成稳定前缀，
      // DeepSeek 上下文缓存按前缀命中；块在尾部，注入与否/内容变化都不击穿缓存
      baseMessages.splice(baseMessages.length - 1, 0, {
        role: "system",
        content: memoryPrompt.text,
      });
    }
    const messages: LlmMessage[] = [...extraSystem, ...baseMessages];

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
        await this.generateStreamReply(
          dto,
          turnId,
          messages,
          recentFillers,
          device.id,
        ));
    } else {
      try {
        const llmResult = await this.llmService.complete({
          scene: "chat_main",
          deviceId: device.id,
          turnId,
          messages,
        });
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
      context: { mode },
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
      `handleTextIn deviceId=${dto.deviceId}, asrText=${dto.asrText}, mode=${mode}`,
    );

    // 补写 assistant 消息；LLM 失败时标 failed,与真实回答可区分
    await this.prisma.message.create({
      data: {
        deviceId: device.id,
        turnId,
        role: "assistant",
        content: reply.responseText,
        status: llmFailed ? "failed" : "completed",
        mode,
        // 边界标注（方案 3）：content 保持播报全文纯净，
        // filler/answer 边界结构化存 rawPayload，供历史剥离与多样性统计
        rawPayload: { filler, answer },
        spokeAt: new Date(),
      },
    });

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
   * 安全拦截回复：不调用任何 LLM，直接播报对应类别的兜底话术。
   * 与冒险回复同走 chunk 通道（单 answer chunk + 收尾 + 全量兜底）。
   * 落库：user 原文 + assistant 兜底话术，rawPayload 标注安全类别与命中层，
   * 供家长端后续做敏感事件时间线与告警。
   */
  private async sendSafetyReply(
    device: { id: string; deviceId: string },
    verdict: SafetyVerdict & { category: BlockedSafetyCategory },
    asrText: string,
    // 由 handleTextIn 传入轮次 ID，与 L2 安全日志同轮；缺省自动生成（超时监听器等无轮次场景）
    turnId: string = randomUUID(),
  ): Promise<VendorTextOutDto> {
    const text = this.childSafetyService.cannedReply(verdict.category);
    this.logger.warn(
      `Child safety ${verdict.layer} blocked deviceId=${device.deviceId} ` +
        `category=${verdict.category} matched=${verdict.matched ?? "-"}`,
    );

    const reply: VendorTextOutDto = {
      deviceId: device.deviceId,
      responseText: text,
      context: { safety: verdict.category },
      ttsOptions: {},
    };

    try {
      await this.replyUploader.sendChunk({
        deviceId: device.deviceId,
        turnId,
        seq: 0,
        source: "answer",
        delta: text,
        isFinal: false,
      });
      await this.replyUploader.sendChunk({
        deviceId: device.deviceId,
        turnId,
        seq: 1,
        source: "answer",
        delta: "",
        isFinal: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to upload safety chunk for deviceId=${device.deviceId}: ${message}`,
      );
    }

    await this.prisma.message.create({
      data: {
        deviceId: device.id,
        turnId,
        role: "user",
        content: asrText,
        status: "completed",
        mode: "free_chat",
        rawPayload: { asrText },
        spokeAt: new Date(),
      },
    });
    await this.prisma.message.create({
      data: {
        deviceId: device.id,
        turnId,
        role: "assistant",
        content: text,
        status: "completed",
        mode: "free_chat",
        rawPayload: {
          filler: null,
          answer: text,
          safetyCategory: verdict.category,
          safetyLayer: verdict.layer,
        },
        spokeAt: new Date(),
      },
    });

    try {
      await this.replyUploader.sendFullReply(reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to upload full safety reply for deviceId=${device.deviceId}: ${message}`,
      );
    }

    return reply;
  }

  /**
   * 哄睡配置修改回复：孩子语音改哄睡设置（sleep_config 意图）。
   * 与安全拦截同走 chunk 通道（单 answer chunk + 收尾 + 全量兜底），
   * 话术由 SleepVoiceConfigService 确定性产出（确认或兜底），不调大模型。
   * 落库：user 原文 + assistant 话术，mode 记 free_chat（配置修改不是故事/冒险），
   * rawPayload.sleepConfig 记录实际修改的字段，供家长端审计。
   */
  private async sendSleepConfigReply(
    device: { id: string; deviceId: string },
    asrText: string,
    turnId: string = randomUUID(),
  ): Promise<VendorTextOutDto> {
    const result = await this.sleepVoiceConfigService.handle(
      device.id,
      asrText,
    );
    const text = result.replyText;

    const reply: VendorTextOutDto = {
      deviceId: device.deviceId,
      responseText: text,
      context: { sleepConfig: result.applied ? (result.field ?? null) : null },
      ttsOptions: {},
    };

    try {
      await this.replyUploader.sendChunk({
        deviceId: device.deviceId,
        turnId,
        seq: 0,
        source: "answer",
        delta: text,
        isFinal: false,
      });
      await this.replyUploader.sendChunk({
        deviceId: device.deviceId,
        turnId,
        seq: 1,
        source: "answer",
        delta: "",
        isFinal: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to upload sleep config chunk for deviceId=${device.deviceId}: ${message}`,
      );
    }

    await this.prisma.message.create({
      data: {
        deviceId: device.id,
        turnId,
        role: "user",
        content: asrText,
        status: "completed",
        mode: "free_chat",
        rawPayload: { asrText },
        spokeAt: new Date(),
      },
    });
    await this.prisma.message.create({
      data: {
        deviceId: device.id,
        turnId,
        role: "assistant",
        content: text,
        status: "completed",
        mode: "free_chat",
        rawPayload: {
          filler: null,
          answer: text,
          sleepConfig: result.applied ? (result.field ?? null) : null,
        },
        spokeAt: new Date(),
      },
    });

    try {
      await this.replyUploader.sendFullReply(reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to upload full sleep config reply for deviceId=${device.deviceId}: ${message}`,
      );
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
    turnId: string = randomUUID(),
  ): Promise<VendorTextOutDto> {
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
          mode: "adventure_story",
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
        mode: "adventure_story",
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
    deviceInternalId?: string,
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
        const answerStream = this.llmService.completeStream({
          scene: "chat_main",
          deviceId: deviceInternalId,
          turnId,
          messages,
        });
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
        scene: "filler",
        deviceId: deviceInternalId,
        turnId,
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
