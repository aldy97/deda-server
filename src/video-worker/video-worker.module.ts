import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import appConfig from "@/config/app.config";
import databaseConfig from "@/config/database.config";
import redisConfig from "@/config/redis.config";
import videoConfig from "@/config/video.config";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { PromptRegistryModule } from "@/modules/prompt-registry/prompt-registry.module";
import { LlmModule } from "@/modules/llm/llm.module";
import { AdventureVideoModule } from "@/modules/adventure-video/adventure-video.module";
import { AdventureVideoWorkerService } from "@/modules/adventure-video/worker/adventure-video-worker.service";
import { FfmpegMediaAssembler } from "@/modules/adventure-video/assembly/ffmpeg-media.assembler";
import { OssAssetStore } from "@/modules/adventure-video/storage/oss-asset-store";
import {
  ASSET_STORE,
  MEDIA_ASSEMBLER,
} from "@/modules/adventure-video/ports/media.ports";
import { VideoWorkerRunner } from "./video-worker.runner";

/**
 * worker 应用的根模块。
 *
 * 刻意不 import AppModule：那个模块会拉起 MQTT / WebSocket / 静态托管，
 * worker 只需要 Prisma、配置、LLM 和视频模块。少一条副作用，就少一种
 * 「worker 重启把线上设备连接抖一下」的可能。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig, videoConfig],
      envFilePath: [".env"],
    }),
    PrismaModule,
    PromptRegistryModule,
    LlmModule,
    AdventureVideoModule,
  ],
  providers: [
    AdventureVideoWorkerService,
    FfmpegMediaAssembler,
    OssAssetStore,
    { provide: ASSET_STORE, useExisting: OssAssetStore },
    { provide: MEDIA_ASSEMBLER, useExisting: FfmpegMediaAssembler },
    VideoWorkerRunner,
  ],
})
export class VideoWorkerModule {}
