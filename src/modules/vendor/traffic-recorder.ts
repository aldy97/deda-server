import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { appendFile, mkdir, readdir, rm } from "fs/promises";
import { join } from "path";

export type TrafficDirection = "in" | "out";

export interface TrafficRecordMeta {
  /** 通道事件名，如 vendor:text:in / vendor:text:chunk */
  event?: string;
  deviceId?: string;
  traceId?: string;
  latencyMs?: number;
}

const FILE_PATTERN = /^vendor-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * 乙方云（机芯厂）流量录制器
 *
 * 把 vendor 通道的每条上行/下行原文带时间戳落盘为 JSONL（按天轮转），
 * 作为联调追责的证据链：复现"孩子说完话 → 乙方 text:in 到达我方"的完整时间线。
 *
 * 默认关闭（VENDOR_TRAFFIC_RECORD 非 'on' 时 record() 直接返回，零开销）；
 * 开启后写盘失败只打 warn，绝不影响真实对话链路。
 */
@Injectable()
export class VendorTrafficRecorder implements OnModuleInit {
  private readonly logger = new Logger(VendorTrafficRecorder.name);
  private readonly enabled: boolean;
  private readonly dir: string;
  private readonly retentionDays: number;

  constructor(configService: ConfigService) {
    this.enabled = configService.get<string>("VENDOR_TRAFFIC_RECORD") === "on";
    this.dir =
      configService.get<string>("VENDOR_TRAFFIC_RECORD_DIR") || "records";
    this.retentionDays = Math.max(
      1,
      Number(
        configService.get<string>("VENDOR_TRAFFIC_RECORD_RETENTION_DAYS"),
      ) || 7,
    );
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 启动时清理超出保留期的历史录制文件。
   */
  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    try {
      const files = await readdir(this.dir);
      const cutoff = Date.now() - this.retentionDays * 86_400_000;
      for (const file of files) {
        const match = FILE_PATTERN.exec(file);
        if (!match) continue;
        const dayStart = new Date(`${match[1]}T00:00:00`).getTime();
        if (dayStart < cutoff) {
          await rm(join(this.dir, file), { force: true });
          this.logger.log(`Expired traffic record removed: ${file}`);
        }
      }
    } catch {
      // 目录尚不存在等情况忽略，首次写入时会自动创建
    }
  }

  /**
   * 记录一条流量。direction=in 表示乙方下行到我方，out 表示我方上行到乙方。
   * 失败只 warn 不抛异常——录制永远不能阻塞对话链路。
   */
  async record(
    direction: TrafficDirection,
    payload: unknown,
    meta: TrafficRecordMeta = {},
  ): Promise<void> {
    if (!this.enabled) return;
    try {
      const line =
        JSON.stringify({
          ts: new Date().toISOString(),
          direction,
          ...meta,
          payload,
        }) + "\n";
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.filePath(), line, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Traffic record failed: ${message}`);
    }
  }

  private filePath(): string {
    return join(this.dir, `vendor-${this.dateStamp()}.jsonl`);
  }

  private dateStamp(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
}
