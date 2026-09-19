import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/common/prisma/prisma.service';
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

  constructor(private readonly prisma: PrismaService) {}

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

  async handleTextIn(dto: VendorTextInDto): Promise<VendorTextOutDto> {
    // 4G 状态下设备可能尚未被家长绑定，先确保 Device 记录存在
    const device = await this.ensureDeviceExists(dto.deviceId);

    // TODO: 保存用户输入，调用 RAG/LLM，生成回复文字
    this.logger.debug(`handleTextIn deviceId=${dto.deviceId}, asrText=${dto.asrText}`);
    const reply: VendorTextOutDto = {
      deviceId: dto.deviceId,
      responseText: `收到：${dto.asrText}`,
      context: {},
      ttsOptions: {},
    };

    // 持久化本轮对话，使 4G 状态下产生的记录在绑定后可恢复
    await this.prisma.conversation.create({
      data: {
        deviceId: device.id,
        asrText: dto.asrText,
        aiReply: reply.responseText,
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
