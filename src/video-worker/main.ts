import { NestFactory } from "@nestjs/core";
import { VideoWorkerModule } from "./video-worker.module";

/**
 * 独立入口：node dist/src/video-worker/main
 *
 * 与 API 共用镜像产物，但独立容器/独立 command；不监听端口。
 * application context 而不是 http server——worker 不该暴露任何路由。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(VideoWorkerModule, {
    logger: ["error", "warn", "log"],
  });
  app.enableShutdownHooks();
}

void bootstrap();
