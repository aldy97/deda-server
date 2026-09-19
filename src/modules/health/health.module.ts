import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { VendorModule } from '../vendor/vendor.module';

@Module({
  imports: [VendorModule],
  controllers: [HealthController],
})
export class HealthModule {}
