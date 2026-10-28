import { Module } from "@nestjs/common";
import { VendorGateway } from "./vendor.gateway";
import { VendorController } from "./vendor.controller";
import { VendorService } from "./vendor.service";
import { VendorReplyUploader } from "./vendor-reply.uploader";
import { VendorTrafficRecorder } from "./traffic-recorder";
import { RagModule } from "@/modules/rag/rag.module";
import { LlmModule } from "@/modules/llm/llm.module";
import { AdventureModule } from "@/modules/adventure/adventure.module";

@Module({
  imports: [RagModule, LlmModule, AdventureModule],
  providers: [
    VendorGateway,
    VendorService,
    VendorReplyUploader,
    VendorTrafficRecorder,
  ],
  controllers: [VendorController],
  exports: [VendorService],
})
export class VendorModule {}
