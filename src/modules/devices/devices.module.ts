import { Module } from "@nestjs/common";
import { DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";
import { ManufacturerModule } from "../manufacturer/manufacturer.module";
import { DeviceStatusModule } from "../device-status/device-status.module";
import { DeviceLinkModule } from "../device-link/device-link.module";

@Module({
  imports: [ManufacturerModule, DeviceStatusModule, DeviceLinkModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
