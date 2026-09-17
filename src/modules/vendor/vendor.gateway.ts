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

/**
 * 机芯厂 ↔ 我方服务器 WebSocket 文字通道
 * 事件：
 *   vendor:text:in  - 机芯厂发送 ASR 文字
 *   vendor:text:out - 我方返回 TTS 文字
 *   vendor:ping     - 心跳
 */
@WebSocketGateway({ namespace: "vendor", cors: { origin: "*" } })
export class VendorGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(VendorGateway.name);

  constructor(private readonly vendorService: VendorService) {}

  handleConnection(client: Socket) {
    this.logger.log(`Vendor connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Vendor disconnected: ${client.id}`);
  }

  @SubscribeMessage("vendor:ping")
  handlePing(client: Socket) {
    client.emit("vendor:pong", { timestamp: Date.now() });
  }

  @SubscribeMessage("vendor:text:in")
  async handleTextIn(client: Socket, payload: VendorTextInDto) {
    this.logger.debug(`Text in from ${payload.deviceId}: ${payload.asrText}`);
    const reply = await this.vendorService.handleTextIn(payload);
    client.emit("vendor:text:out", reply);
    return reply;
  }
}
