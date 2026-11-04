import { Module } from "@nestjs/common";
import { VendorGateway } from "./vendor.gateway";
import { VendorController } from "./vendor.controller";
import { VendorService } from "./vendor.service";
import { ConversationSessionService } from "./conversation-session.service";
import { ChildSafetyService } from "./child-safety.service";
import { VendorReplyUploader } from "./vendor-reply.uploader";
import { VendorTrafficRecorder } from "./traffic-recorder";
import { LlmModule } from "@/modules/llm/llm.module";
import { AdventureModule } from "@/modules/adventure/adventure.module";
import { ChildMemoriesModule } from "@/modules/child-memories/child-memories.module";
import { SleepConfigsModule } from "@/modules/sleep-configs/sleep-configs.module";

@Module({
  imports: [
    LlmModule,
    AdventureModule,
    ChildMemoriesModule,
    SleepConfigsModule,
  ],
  providers: [
    VendorGateway,
    VendorService,
    ConversationSessionService,
    ChildSafetyService,
    VendorReplyUploader,
    VendorTrafficRecorder,
  ],
  controllers: [VendorController],
  exports: [VendorService, VendorGateway, ConversationSessionService],
})
export class VendorModule {}
