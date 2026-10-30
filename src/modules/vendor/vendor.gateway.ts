import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { Logger } from "@nestjs/common";
import { VendorService } from "./vendor.service";
import { VendorTextInDto } from "./dto/vendor-text-in.dto";
import { VendorTrafficRecorder } from "./traffic-recorder";

/**
 * 机芯厂 ↔ 我方服务器 WebSocket 文字通道
 * 事件：
 *   vendor:text:in  - 机芯厂发送 ASR 文字
 *   vendor:text:out - 我方返回 TTS 文字
 *   vendor:ping     - 心跳
 *   vendor:pong     - 心跳响应
 *   vendor:error    - 服务端错误通知
 */
@WebSocketGateway({ namespace: "vendor", cors: { origin: "*" } })
export class VendorGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(VendorGateway.name);

  /**
   * 内存映射：deviceId -> socket.id
   * 用于后续按设备推送消息（如云端主动下发 TTS）。
   */
  private readonly deviceSocketMap = new Map<string, string>();

  constructor(
    private readonly vendorService: VendorService,
    private readonly trafficRecorder: VendorTrafficRecorder,
  ) {}

  handleConnection(client: Socket) {
    this.logger.log(`Vendor connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Vendor disconnected: ${client.id}`);
    // 清理该 socket 关联的设备映射
    for (const [deviceId, socketId] of this.deviceSocketMap.entries()) {
      if (socketId === client.id) {
        this.deviceSocketMap.delete(deviceId);
      }
    }
  }

  @SubscribeMessage("vendor:ping")
  handlePing(client: Socket) {
    client.emit("vendor:pong", { timestamp: Date.now() });
  }

  @SubscribeMessage("vendor:text:in")
  async handleTextIn(client: Socket, payload: VendorTextInDto) {
    // 原始报文先行录制（含校验失败的情况），联调追责时证明乙方到底发了什么
    void this.trafficRecorder.record("in", payload, {
      event: "vendor:text:in",
      deviceId: payload?.deviceId,
    });

    const validationError = this.validateTextIn(payload);
    if (validationError) {
      this.emitError(client, "vendor:text:in", validationError);
      return null;
    }

    this.deviceSocketMap.set(payload.deviceId, client.id);
    this.logger.debug(`Text in from ${payload.deviceId}: ${payload.asrText}`);

    try {
      const reply = await this.vendorService.handleTextIn(payload);
      client.emit("vendor:text:out", reply);
      void this.trafficRecorder.record("out", reply, {
        event: "vendor:text:out",
        deviceId: payload.deviceId,
      });
      return reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to handle text in from ${payload.deviceId}: ${message}`,
      );
      void this.trafficRecorder.record(
        "in",
        { error: message },
        {
          event: "vendor:text:in:error",
          deviceId: payload.deviceId,
        },
      );
      this.emitError(client, "vendor:text:in", message);
      return null;
    }
  }

  private validateTextIn(payload: VendorTextInDto): string | null {
    if (!payload || typeof payload !== "object") {
      return "payload must be an object";
    }
    if (!payload.deviceId || typeof payload.deviceId !== "string") {
      return "deviceId is required and must be a string";
    }
    if (!payload.asrText || typeof payload.asrText !== "string") {
      return "asrText is required and must be a string";
    }
    if (payload.textbookId && typeof payload.textbookId !== "string") {
      return "textbookId must be a string";
    }
    if (payload.unitId && typeof payload.unitId !== "string") {
      return "unitId must be a string";
    }
    return null;
  }

  private emitError(client: Socket, event: string, message: string) {
    client.emit("vendor:error", { event, message, timestamp: Date.now() });
  }
}
