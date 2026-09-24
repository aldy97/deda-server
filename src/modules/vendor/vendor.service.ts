import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RagService } from '@/modules/rag/rag.service';
import { LlmService } from '@/modules/llm/llm.service';
import { VendorTextInDto } from './dto/vendor-text-in.dto';
import { VendorTextOutDto } from './dto/vendor-text-out.dto';
import { VendorStatusDto } from './dto/vendor-status.dto';
import { VendorBindDto } from './dto/vendor-bind.dto';
import { VendorConversationDto } from './dto/vendor-conversation.dto';

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
  ) {
    this.defaultTextbookId =
      this.configService.get<string>('DEFAULT_TEXTBOOK_ID') || 'sample-textbook';
    this.defaultUnitId =
      this.configService.get<string>('DEFAULT_UNIT_ID') || 'unit-1';
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
      textbookId: dto.textbookId || activeConfig?.textbookId || this.defaultTextbookId,
      unitId: dto.unitId || activeConfig?.unitId || this.defaultUnitId,
    };
  }

  /**
   * 查询设备当前生效配置
   */
  private async resolveActiveConfig(deviceInternalId: string) {
    return this.prisma.deviceConfig.findFirst({
      where: { deviceId: deviceInternalId, isActive: true },
      orderBy: { createdAt: 'desc' },
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
    if (mode === 'free_chat' && conversationModeKey) {
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
   * 获取同一设备、同一教材、同一单元的最近对话历史
   * 用于 prompt 拼接，保证多轮对话上下文连续且单元边界隔离
   */
  private async getRecentHistory(
    deviceInternalId: string,
    textbookId: string,
    unitId: string,
    limit = 6,
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const rows = await this.prisma.conversation.findMany({
      where: {
        deviceId: deviceInternalId,
        textbookId,
        unitId,
        deletedAt: null,
      },
      orderBy: { spokeAt: 'desc' },
      take: limit,
      select: { asrText: true, aiReply: true },
    });

    // 按时间正序排列，旧 → 新
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const row of rows.reverse()) {
      if (row.asrText) {
        history.push({ role: 'user', content: row.asrText });
      }
      if (row.aiReply) {
        history.push({ role: 'assistant', content: row.aiReply });
      }
    }
    return history;
  }

  async handleTextIn(dto: VendorTextInDto): Promise<VendorTextOutDto> {
    // 4G 状态下设备可能尚未被家长绑定，先确保 Device 记录存在
    const device = await this.ensureDeviceExists(dto.deviceId);

    const activeConfig = await this.resolveActiveConfig(device.id);
    const { textbookId, unitId } = await this.resolveTextbookAndUnit(
      dto,
      device.id,
    );

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

    // 获取同单元最近对话历史，用于 prompt 拼接
    const history = await this.getRecentHistory(device.id, textbookId, unitId);

    let responseText: string;
    try {
      const context = retrieveResult.found
        ? this.ragService.truncateContent(retrieveResult.content, 1500)
        : '';
      const messages = this.llmService.buildEnglishTutorPrompt(
        dto.asrText,
        context,
        retrieveResult.unitName,
        history,
        {
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
        },
      );
      const llmResult = await this.llmService.complete({ messages });
      responseText = llmResult.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `LLM failed for deviceId=${dto.deviceId}: ${message}`,
      );
      responseText = "Sorry, I didn't catch that. Could you say it again?";
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

    this.logger.debug(
      `handleTextIn deviceId=${dto.deviceId}, asrText=${dto.asrText}, textbookId=${textbookId}, unitId=${unitId}`,
    );

    // 持久化本轮对话，使 4G 状态下产生的记录在绑定后可恢复
    await this.prisma.conversation.create({
      data: {
        deviceId: device.id,
        asrText: dto.asrText,
        aiReply: reply.responseText,
        textbookId,
        unitId,
        mode: 'locked_unit',
        rawPayload: dto as any,
        spokeAt: new Date(),
      },
    });

    return reply;
  }

  async handleStatusReport(dto: VendorStatusDto) {
    // TODO: 缓存设备状态到 Redis，供小程序查询
    this.logger.debug(`handleStatusReport deviceId=${dto.deviceId}, online=${dto.online}`);
    return { success: true, deviceId: dto.deviceId };
  }

  async handleBindCallback(dto: VendorBindDto) {
    // TODO: 更新设备绑定关系
    this.logger.debug(`handleBindCallback deviceId=${dto.deviceId}, bound=${dto.bound ?? true}`);
    return { success: true, deviceId: dto.deviceId, bound: dto.bound ?? true };
  }

  async handleConversationBackup(dto: VendorConversationDto, idempotencyKey?: string) {
    // TODO: 幂等写入对话记录，idempotencyKey 去重
    this.logger.debug(`handleConversationBackup deviceId=${dto.deviceId}, idempotencyKey=${idempotencyKey ?? 'none'}`);
    return { success: true, idempotencyKey: idempotencyKey || null };
  }

  getHealth() {
    // TODO: 可扩展为检查数据库、Redis、LLM 可用性
    return {
      status: 'up',
      timestamp: Date.now(),
      expectedRecovery: null,
    };
  }
}
