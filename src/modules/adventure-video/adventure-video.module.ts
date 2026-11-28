import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { ContentAdminGuard } from "@/modules/adventure-admin/guards/content-admin.guard";
import { SuperAdminGuard } from "@/modules/analytics/guards/super-admin.guard";
import { AdventureVideoController } from "./adventure-video.controller";
import { AdventureVideoService } from "./adventure-video.service";
import { AdventureVideoQueueService } from "./adventure-video-queue.service";
import { AxiosTransport } from "./providers/axios-transport";
import { BailianSpeechClient } from "./providers/bailian-speech.client";
import { BailianVideoClient } from "./providers/bailian-video.client";
import { HTTP_TRANSPORT } from "./providers/provider.types";

/**
 * 冒险短视频模块（S1/S3：作业生命周期 + 供应商客户端 + 队列）。
 *
 * 依赖只有全局的 PrismaModule / ConfigModule 和 analytics 注册的 JWT 策略；
 * 不导入 AdventureAdminModule / AdventureModule，避免把内容生产线和播放引擎
 * 拖进同一条依赖链——视频工作台挂了，内容台和孩子端都不该受影响。
 *
 * worker 编排与 OSS/ffmpeg 适配在 S4 追加；本阶段队列与客户端已经可单测。
 */
@Module({
  imports: [PassportModule],
  controllers: [AdventureVideoController],
  providers: [
    AdventureVideoService,
    AdventureVideoQueueService,
    BailianVideoClient,
    BailianSpeechClient,
    { provide: HTTP_TRANSPORT, useClass: AxiosTransport },
    SuperAdminGuard,
    ContentAdminGuard,
  ],
  exports: [
    AdventureVideoService,
    AdventureVideoQueueService,
    BailianVideoClient,
    BailianSpeechClient,
  ],
})
export class AdventureVideoModule {}
