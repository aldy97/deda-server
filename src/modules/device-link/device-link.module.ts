import { Module } from "@nestjs/common";
import { MqttModule } from "@/common/mqtt/mqtt.module";
import { RedisModule } from "@/common/redis/redis.module";
import { DeviceLinkService } from "./device-link.service";
import { DevicePresenceService } from "./device-presence.service";

/**
 * 设备链路模块（机芯厂新 MQTT 三主题协议）
 *
 * 与 DeviceStatusModule（旧协议 zhianxin/event/report）并行运行，
 * 待机芯厂确认旧协议下线后清理旧模块。
 */
@Module({
  imports: [MqttModule, RedisModule],
  providers: [DeviceLinkService, DevicePresenceService],
  exports: [DeviceLinkService],
})
export class DeviceLinkModule {}
