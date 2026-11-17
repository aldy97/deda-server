import { Module } from "@nestjs/common";
import { BaiduAgentClient } from "./baidu-agent-client.service";
import { VoiceCatalogService } from "./voice-catalog.service";
import { VoiceReconcileService } from "./voice-reconcile.service";
import {
  BAIDU_AGENT_CLIENT_PORT,
  VOICE_CATALOG_PORT,
  VOICE_RECONCILE_PORT,
} from "./baidu-agent.types";

/**
 * 百度云「大模型实时互动」控制面模块。
 *
 * 对外只导出三个端口 token，消费方（device-configs / client-api）不依赖具体实现类。
 * ConfigModule / PrismaModule / RedisModule 均为全局模块，无需显式 imports。
 */
@Module({
  providers: [
    BaiduAgentClient,
    VoiceCatalogService,
    VoiceReconcileService,
    { provide: BAIDU_AGENT_CLIENT_PORT, useExisting: BaiduAgentClient },
    { provide: VOICE_CATALOG_PORT, useExisting: VoiceCatalogService },
    { provide: VOICE_RECONCILE_PORT, useExisting: VoiceReconcileService },
  ],
  exports: [BAIDU_AGENT_CLIENT_PORT, VOICE_CATALOG_PORT, VOICE_RECONCILE_PORT],
})
export class BaiduAgentModule {}
