import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { ManufacturerModule } from '../manufacturer/manufacturer.module';
import { DeviceStatusModule } from '../device-status/device-status.module';

@Module({
  imports: [ManufacturerModule, DeviceStatusModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
