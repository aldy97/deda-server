import { Module } from '@nestjs/common';
import { VendorGateway } from './vendor.gateway';
import { VendorController } from './vendor.controller';
import { VendorService } from './vendor.service';

@Module({
  providers: [VendorGateway, VendorService],
  controllers: [VendorController],
  exports: [VendorService],
})
export class VendorModule {}
