import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { VideoStudioConfig } from "@/config/video.config";
import { AdventureVideoWorkerService } from "@/modules/adventure-video/worker/adventure-video-worker.service";

/**
 * 常驻轮询器。
 *
 * 只在 worker 进程里注册（API 进程不 import 本类），因此不会出现
 * 「API 也偷偷跑 ffmpeg」的情况。并发由 VIDEO_WORKER_CONCURRENCY 控制，
 * 空队列时退避 5 秒，避免把 DB 打满。
 */
@Injectable()
export class VideoWorkerRunner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VideoWorkerRunner.name);
  private stopped = false;
  private loops: Array<Promise<void>> = [];

  constructor(
    private readonly worker: AdventureVideoWorkerService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const config = this.configService.get<VideoStudioConfig>("video");
    if (!config?.enabled) {
      this.logger.log("ADVENTURE_VIDEO_ENABLED=false，worker 不启动轮询");
      return;
    }
    if (config.lintForbiddenWords.length === 0) {
      this.logger.warn(
        "ADVENTURE_LINT_FORBIDDEN_WORDS 未配置，分镜违禁词扫描为空转",
      );
    }
    const concurrency = Math.max(1, config.workerConcurrency);
    this.logger.log(`worker 启动，并发 ${concurrency}`);
    this.loops = Array.from({ length: concurrency }, (_, index) =>
      this.loop(index),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.loops);
  }

  private async loop(index: number): Promise<void> {
    while (!this.stopped) {
      try {
        const worked = await this.worker.runOnce();
        if (!worked) {
          await this.sleep(5_000);
        }
      } catch (error) {
        this.logger.error(
          `worker#${index} 循环异常：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.sleep(5_000);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
