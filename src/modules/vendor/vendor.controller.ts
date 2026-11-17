import { Controller, Logger, Post, Body, Param, Headers } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { ADVENTURE_DEGRADED_REPLIES } from "@/modules/adventure/adventure.constants";
import { VendorService } from "./vendor.service";
import { VendorTextInDto } from "./dto/vendor-text-in.dto";
import { VendorStatusDto } from "./dto/vendor-status.dto";
import { VendorBindDto } from "./dto/vendor-bind.dto";
import { VendorConversationDto } from "./dto/vendor-conversation.dto";
import {
  VendorDebugLogDto,
  VendorDebugRebootDto,
  VendorDebugTestModeDto,
  VendorDebugOtaDto,
} from "./dto/vendor-debug.dto";

@ApiTags("机芯厂对接")
@Controller("vendor")
/**
 * 【当前状态：备选链路 / backup】2026-11 起语音对话主链路为百度 RTC
 * 直连（见 src/modules/llm-adapter/，POST /v1/chat/completions）。
 * 本控制器（含 POST /vendor/text）保留作为百度直连失效时的降级备份，
 * 不再新增功能。
 */
export class VendorController {
  private readonly logger = new Logger(VendorController.name);

  constructor(private readonly vendorService: VendorService) {}

  @Post("health")
  @ApiOperation({ summary: "我方服务健康检查（机芯厂判定 down/up）" })
  health() {
    // 机芯厂通过该接口或 WebSocket 心跳判定我方服务是否可用
    return this.vendorService.getHealth();
  }

  @Post("text")
  @ApiOperation({ summary: "WebSocket 备用：机芯厂提交 ASR 文字并获取回复" })
  async textExchange(@Body() dto: VendorTextInDto) {
    try {
      return await this.vendorService.handleTextIn(dto);
    } catch (error) {
      // 抛 500 对设备端等于静音：这里必须交出与正常回复同形状的信封。
      this.logger.error(
        `Vendor text exchange failed for ${dto.deviceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      try {
        return await this.vendorService.sendDegradedReply(dto.deviceId);
      } catch (degradedError) {
        // 连兜底话术都发不出去（上行 WS 与 DB 同时挂）：至少让 HTTP 响应
        // 带着话术回去，设备端还能自己 TTS 播一遍。
        this.logger.error(
          `Degraded reply failed for ${dto.deviceId}: ${
            degradedError instanceof Error
              ? degradedError.message
              : String(degradedError)
          }`,
        );
        return {
          deviceId: dto.deviceId,
          responseText: ADVENTURE_DEGRADED_REPLIES.lastResort,
          context: { degraded: true },
          ttsOptions: {},
        };
      }
    }
  }

  @Post("devices/:deviceId/status")
  @ApiOperation({ summary: "设备状态上报（在线、电量、充电、信号强度）" })
  async reportStatus(
    @Param("deviceId") deviceId: string,
    @Body() dto: VendorStatusDto,
  ) {
    return this.vendorService.handleStatusReport({ ...dto, deviceId });
  }

  @Post("devices/:deviceId/bind")
  @ApiOperation({ summary: "设备绑定/解绑回调" })
  async bindCallback(
    @Param("deviceId") deviceId: string,
    @Body() dto: VendorBindDto,
  ) {
    return this.vendorService.handleBindCallback({ ...dto, deviceId });
  }

  @Post("webhooks/conversation")
  @ApiOperation({
    summary: "对话结束 Webhook（WebSocket 文字通道的备用/补充）",
  })
  async conversationWebhook(
    @Body() dto: VendorConversationDto,
    @Headers("x-idempotency-key") idempotencyKey?: string,
  ) {
    return this.vendorService.handleConversationBackup(dto, idempotencyKey);
  }

  @Post("debug/log")
  @ApiOperation({ summary: "研发调试：接收设备日志" })
  async debugLog(@Body() dto: VendorDebugLogDto) {
    // TODO: 写入日志系统或对象存储
    return { success: true };
  }

  @Post("debug/reboot")
  @ApiOperation({ summary: "研发调试：远程重启设备" })
  async debugReboot(@Body() dto: VendorDebugRebootDto) {
    // TODO: 通过 manufacturer service 调用厂商重启接口
    return { success: true, deviceId: dto.deviceId };
  }

  @Post("debug/test-mode")
  @ApiOperation({ summary: "研发调试：进入/退出测试模式" })
  async debugTestMode(@Body() dto: VendorDebugTestModeDto) {
    return { success: true, deviceId: dto.deviceId, enabled: dto.enabled };
  }

  @Post("debug/firmware")
  @ApiOperation({ summary: "研发调试：查询当前固件版本" })
  async debugFirmware(@Body("deviceId") deviceId: string) {
    return { deviceId, firmwareVersion: "0.0.0" };
  }

  @Post("debug/ota")
  @ApiOperation({ summary: "研发调试：下发 OTA 升级" })
  async debugOta(@Body() dto: VendorDebugOtaDto) {
    // TODO: 调用厂商 OTA 接口
    return {
      success: true,
      deviceId: dto.deviceId,
      firmwareVersion: dto.firmwareVersion,
    };
  }
}
