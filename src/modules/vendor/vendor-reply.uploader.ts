import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { io, Socket } from "socket.io-client";
import { VendorTextChunkDto } from "./dto/vendor-text-chunk.dto";
import { VendorTextOutDto } from "./dto/vendor-text-out.dto";
import { VendorTrafficRecorder } from "./traffic-recorder";

/**
 * 机芯厂回复上传通道（出站 WS 客户端）
 * 我方按 chunk 流式调用机芯厂 WS 接口上传回复文字，机芯厂做 TTS 后下发设备。
 *
 * 保序约定：sendChunk / sendFullReply 均为 async，且每次发送等待对端 ack；
 * 调用方（VendorService）逐个 await 调用即可保证 WS 接口的调用顺序严格对齐。
 *
 * 与对端云服务解耦：VENDOR_WS_UPLOAD_URL 未配置时不连真实云服务，
 * 内部双模型编排与流式逻辑照常运行，发送仅记 debug 日志（便于本地/单测）。
 * 鉴权暂忽略（见 .env.example 注释），接入时在此补充 auth。
 */
@Injectable()
export class VendorReplyUploader implements OnModuleDestroy {
  private readonly logger = new Logger(VendorReplyUploader.name);
  private readonly uploadUrl: string | undefined;
  private readonly ackTimeoutMs: number;

  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly trafficRecorder: VendorTrafficRecorder,
  ) {
    this.uploadUrl =
      this.configService.get<string>("VENDOR_WS_UPLOAD_URL") || undefined;
    this.ackTimeoutMs =
      Number(this.configService.get<string>("VENDOR_UPLOAD_ACK_TIMEOUT_MS")) ||
      5000;
  }

  /**
   * 上传一个流式 chunk（vendor:text:chunk）
   * 必须 await：返回的 Promise 在对端 ack 后才 resolve，保证顺序对齐。
   */
  async sendChunk(chunk: VendorTextChunkDto): Promise<void> {
    await this.emitWithAck("vendor:text:chunk", chunk, `seq=${chunk.seq}`);
  }

  /**
   * 上传全量回复（vendor:text:out），流式结束后兜底/存档用
   */
  async sendFullReply(reply: VendorTextOutDto): Promise<void> {
    await this.emitWithAck("vendor:text:out", reply, "full reply");
  }

  private async emitWithAck(
    event: string,
    data: unknown,
    label: string,
  ): Promise<void> {
    // 录制我方上行原文（含未配置 VENDOR_WS_UPLOAD_URL 的本地调试发送），
    // 与 gateway 的 vendor:text:out 录制互补，构成完整 in/out 对账链
    void this.trafficRecorder.record("out", data, {
      event,
      deviceId: (data as { deviceId?: string })?.deviceId,
    });

    if (!this.uploadUrl) {
      this.logger.debug(
        `Uploader disabled (no VENDOR_WS_UPLOAD_URL), skip ${event} ${label}`,
      );
      return;
    }

    const socket = await this.ensureConnected();
    await new Promise<void>((resolve, reject) => {
      socket
        .timeout(this.ackTimeoutMs)
        .emit(event, data, (err: Error | null) => {
          if (err) {
            reject(
              new Error(
                `Vendor WS ack failed for ${event} ${label}: ${err.message}`,
              ),
            );
            return;
          }
          resolve();
        });
    });
  }

  /**
   * 懒连接：首次发送时建立 WS 连接，成功后复用
   */
  private ensureConnected(): Promise<Socket> {
    if (this.socket?.connected) {
      return Promise.resolve(this.socket);
    }
    if (!this.connecting) {
      this.connecting = new Promise<Socket>((resolve, reject) => {
        // TODO(接入对端时): 按机芯厂要求补充鉴权（auth / headers）
        const socket = io(this.uploadUrl as string, {
          transports: ["websocket"],
          reconnection: true,
        });
        socket.on("connect", () => {
          this.logger.log(`Vendor upload WS connected: ${this.uploadUrl}`);
          resolve(socket);
        });
        socket.on("connect_error", (error: Error) => {
          this.logger.error(`Vendor upload WS connect error: ${error.message}`);
          reject(error);
        });
        this.socket = socket;
      }).then(
        (socket) => {
          this.connecting = null;
          return socket;
        },
        (error) => {
          this.connecting = null;
          throw error;
        },
      );
    }
    return this.connecting;
  }

  onModuleDestroy() {
    this.socket?.disconnect();
    this.socket = null;
  }
}
