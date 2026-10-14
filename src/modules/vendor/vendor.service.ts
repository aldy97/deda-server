import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RagService } from "@/modules/rag/rag.service";
import { LlmService } from "@/modules/llm/llm.service";
import { VendorTextInDto } from "./dto/vendor-text-in.dto";
import { VendorTextOutDto } from "./dto/vendor-text-out.dto";
import { VendorTextChunkDto } from "./dto/vendor-text-chunk.dto";
import { VendorStatusDto } from "./dto/vendor-status.dto";
import { VendorBindDto } from "./dto/vendor-bind.dto";
import { VendorConversationDto } from "./dto/vendor-conversation.dto";
import { VendorReplyUploader } from "./vendor-reply.uploader";
import { LlmMessage } from "@/modules/llm/llm.service";

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
  ) {
    this.defaultTextbookId =
      this.configService.get<string>("DEFAULT_TEXTBOOK_ID") ||
      "sample-textbook";
    this.defaultUnitId =
      this.configService.get<string>("DEFAULT_UNIT_ID") || "unit-1";
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

  async handleTextIn(dto: VendorTextInDto): Promise<VendorTextOutDto> {
    // 4G 状态下设备可能尚未被家长绑定，先确保 Device 记录存在
    const device = await this.ensureDeviceExists(dto.deviceId);

    const activeConfig = await this.resolveActiveConfig(device.id);
    const { textbookId, unitId } = await this.resolveTextbookAndUnit(
      dto,
      device.id,
    );

    const mode = activeConfig?.mode ?? "locked_unit";

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
          spokeAt: new Date(),
        },
      });
    }

    // 读取孩子档案与当前模式对应的 prompt 模板
    const childProfile = await this.getChildProfile(device.id);
    const promptTemplate = await this.resolvePromptTemplate(
      activeConfig?.mode,
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
      mode: activeConfig?.mode ?? undefined,
      conversationModeKey: activeConfig?.conversationModeKey ?? undefined,
    };

    // 流式开关：LLM_STREAM_ENABLED=false 时整体回落到非流式单模型路径
    const streamEnabled =
      this.configService.get<string>("LLM_STREAM_ENABLED") !== "false";

    let responseText: string;
    let llmFailed = false;
    // 落库边界（方案 3）：rawPayload { filler, answer }；非流式路径 filler=null
    let filler: string | null = null;
    let answer = "";
    if (streamEnabled) {
      const messages = this.llmService.buildEnglishTutorPrompt(
        dto.asrText,
        context,
        retrieveResult.unitName,
        history,
        promptOptions,
      );
      ({ responseText, llmFailed, filler, answer } =
        await this.generateStreamReply(dto, turnId, messages, recentFillers));
    } else {
      try {
        const messages = this.llmService.buildEnglishTutorPrompt(
          dto.asrText,
          context,
          retrieveResult.unitName,
          history,
          promptOptions,
        );
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
