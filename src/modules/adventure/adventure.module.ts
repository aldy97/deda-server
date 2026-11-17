import { Module } from "@nestjs/common";
import { LlmModule } from "@/modules/llm/llm.module";
import { AdventureCircuitBreaker } from "./adventure-circuit-breaker.service";
import { AdventureRecoveryService } from "./adventure-recovery.service";
import { AdventureService } from "./adventure.service";

/**
 * 孩子侧播放引擎。PrismaModule / RedisModule / ConfigModule 都是 @Global，
 * 熔断器与巡检所需的 RedisService、ConfigService 无需在此重复导入。
 *
 * 导出 AdventureRecoveryService 的唯一消费者是管理台（AdventureAdminModule），
 * 方向是**管理台 → 引擎**：管理台可以读健康快照、手动触发巡检、重置熔断器，
 * 引擎永远不知道管理台存在。反过来一旦成立，内容生产线上的报错就有可能把
 * 孩子正在走的播放链路一起拖下水。
 */
@Module({
  imports: [LlmModule],
  providers: [
    AdventureService,
    AdventureCircuitBreaker,
    AdventureRecoveryService,
  ],
  exports: [AdventureService, AdventureRecoveryService],
})
export class AdventureModule {}
