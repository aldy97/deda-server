import { Module } from '@nestjs/common';
import { VendorGateway } from './vendor.gateway';
import { VendorController } from './vendor.controller';
import { VendorService } from './vendor.service';
import { RagModule } from '@/modules/rag/rag.module';
import { LlmModule } from '@/modules/llm/llm.module';

@Module({
  imports: [RagModule, LlmModule],
  providers: [VendorGateway, VendorService],
  controllers: [VendorController],
  exports: [VendorService],
})
export class VendorModule {}
