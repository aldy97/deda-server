import { Module } from "@nestjs/common";
import { AdventureModule } from "@/modules/adventure/adventure.module";
import { AdventureAdminController } from "./adventure-admin.controller";
import { AdventureAuditService } from "./adventure-audit.service";
import { AdventureContentQueryService } from "./adventure-content-query.service";
import { AdventureContentService } from "./adventure-content.service";
import { AdventureTransferService } from "./adventure-transfer.service";
import { ContentAdminGuard } from "./guards/content-admin.guard";

/**
 * 冒险内容管理台模块。
 *
 * 与 AdventureModule 的关系是**单向依赖**：那边是孩子侧播放引擎（vendor 协议、
 * MQTT、LLM 桥接），这边是管理员内容生产线（草稿、版本、发布、审计、搬运）。
 * 内容本身只通过数据库里的版本快照与 segments 表交接，管理台不导出任何 provider，
 * 所以引擎既拿不到、也看不见这些写服务——播放链路不该因为管理台报错而挂掉。
 *
 * 唯一的例外是导入 AdventureModule 拿 AdventureRecoveryService：管理台需要读自愈
 * 健康快照、并在人授权下手动触发巡检 / 重置熔断器。这条依赖方向刻意是
 * 管理台 → 引擎，反向导入被 adventure-admin.module.spec.ts 钉死。
 *
 * 依赖说明：ContentAdminGuard 继承 AnalyticsAuthGuard，走名为 "analytics-jwt" 的
 * passport 策略，该策略由 AnalyticsModule 注册（AppModule 一直加载它）。
 * PrismaModule / RedisModule / ConfigModule 都是 @Global，无需在此重复导入。
 */
@Module({
  imports: [AdventureModule],
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
