import { Injectable } from '@nestjs/common';
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
  async handleTextIn(dto: VendorTextInDto): Promise<VendorTextOutDto> {
    // TODO: 保存用户输入，调用 RAG/LLM，生成回复文字
    return {
      deviceId: dto.deviceId,
      responseText: `收到：${dto.asrText}`,
      context: {},
      ttsOptions: {},
    };
  }

  async handleStatusReport(dto: VendorStatusDto) {
    // TODO: 缓存设备状态到 Redis，供小程序查询
    return { success: true, deviceId: dto.deviceId };
  }

  async handleBindCallback(dto: VendorBindDto) {
    // TODO: 更新设备绑定关系
    return { success: true, deviceId: dto.deviceId, bound: dto.bound ?? true };
  }

  async handleConversationBackup(dto: VendorConversationDto, idempotencyKey?: string) {
    // TODO: 幂等写入对话记录，idempotencyKey 去重
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
