import { Module } from "@nestjs/common";
import { ClientApiController } from "./client-api.controller";
import { ClientApiService } from "./client-api.service";

/**
 * 机芯厂设备侧 HTTP 接口模块（《设备端接口文档》v1.1）。
 * PrismaModule / RedisModule 为全局模块，无需显式 imports。
 */
@Module({
  controllers: [ClientApiController],
  providers: [ClientApiService],
})
export class ClientApiModule {}
