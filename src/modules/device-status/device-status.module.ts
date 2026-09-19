import { Module } from '@nestjs/common';
import { MqttModule } from '@/common/mqtt/mqtt.module';
import { RedisModule } from '@/common/redis/redis.module';
import { DeviceStatusService } from './device-status.service';

@Module({
  imports: [MqttModule, RedisModule],
  providers: [DeviceStatusService],
  exports: [DeviceStatusService],
})
export class DeviceStatusModule {}
