import { Module } from "@nestjs/common";
import { TurnDecisionRecorder } from "./turn-decision-recorder.service";

/**
 * 判定质量审计模块（写侧）。
 *
 * 只导出 recorder，供 LlmAdapterModule 在编排出口埋点；
 * 读侧（看板接口）在 AnalyticsModule，直接查 turn_decision_logs，不经本模块。
 * PrismaService 由全局 PrismaModule 提供。
 */
@Module({
  providers: [TurnDecisionRecorder],
  exports: [TurnDecisionRecorder],
})
export class TurnDecisionModule {}
