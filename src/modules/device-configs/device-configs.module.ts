import { Module } from '@nestjs/common';
import { DeviceConfigsController } from './device-configs.controller';
import { DeviceConfigsService } from './device-configs.service';

@Module({
  controllers: [DeviceConfigsController],
  providers: [DeviceConfigsService],
  exports: [DeviceConfigsService],
})
export class DeviceConfigsModule {}
