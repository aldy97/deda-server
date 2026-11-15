import { Module } from "@nestjs/common";
import { ClientApiController } from "./client-api.controller";
import { ClientApiService } from "./client-api.service";
import { BaiduAgentModule } from "@/modules/baidu-agent/baidu-agent.module";

/**
 * 机芯厂设备侧 HTTP 接口模块（《设备端接口文档》v1.1）。
 * PrismaModule / RedisModule 为全局模块，无需显式 imports；
 * BaiduAgentModule 提供 bot/start 后的音色追平端口。
 */
@Module({
  imports: [BaiduAgentModule],
  controllers: [ClientApiController],
  providers: [ClientApiService],
})
export class ClientApiModule {}
