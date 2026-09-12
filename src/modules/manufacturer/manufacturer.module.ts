import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ManufacturerService } from './manufacturer.service';

@Module({
  imports: [HttpModule],
  providers: [ManufacturerService],
  exports: [ManufacturerService],
})
export class ManufacturerModule {}
