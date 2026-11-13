import { Module } from "@nestjs/common";
import { AdventureAdminController } from "./adventure-admin.controller";
import { AdventureAuditService } from "./adventure-audit.service";
import { AdventureContentQueryService } from "./adventure-content-query.service";
import { AdventureContentService } from "./adventure-content.service";
import { AdventureTransferService } from "./adventure-transfer.service";
import { ContentAdminGuard } from "./guards/content-admin.guard";

/**
 * 冒险内容管理台模块。
 *
 * 刻意独立于 AdventureModule：那边是**孩子侧播放引擎**（vendor 协议、MQTT、LLM 桥接），
 * 这边是**管理员内容生产线**（草稿、版本、发布、审计、搬运）。两者只通过数据库里的
 * 版本快照与 segments 表交接，互不注入对方的服务——播放链路不该因为管理台报错而挂掉，
 * 管理台也不该有机会直接调用播放链路的方法。
 *
 * 依赖说明：ContentAdminGuard 继承 AnalyticsAuthGuard，走名为 "analytics-jwt" 的
 * passport 策略，该策略由 AnalyticsModule 注册（AppModule 一直加载它）。
 * PrismaModule / RedisModule / ConfigModule 都是 @Global，无需在此重复导入。
 */
@Module({
  controllers: [AdventureAdminController],
  providers: [
    ContentAdminGuard,
    AdventureAuditService,
    AdventureContentQueryService,
    AdventureContentService,
    AdventureTransferService,
  ],
})
export class AdventureAdminModule {}
