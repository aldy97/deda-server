import { Module } from "@nestjs/common";
import { DeviceConfigsController } from "./device-configs.controller";
import { DeviceConfigsService } from "./device-configs.service";
import { BaiduAgentModule } from "@/modules/baidu-agent/baidu-agent.module";

@Module({
  imports: [BaiduAgentModule],
  controllers: [DeviceConfigsController],
  providers: [DeviceConfigsService],
  exports: [DeviceConfigsService],
})
export class DeviceConfigsModule {}
