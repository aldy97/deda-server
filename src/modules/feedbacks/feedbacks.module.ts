import { Module } from "@nestjs/common";
import { FeedbacksController } from "./feedbacks.controller";
import { FeedbacksService } from "./feedbacks.service";

@Module({
  controllers: [FeedbacksController],
  providers: [FeedbacksService],
  exports: [FeedbacksService],
})
export class FeedbacksModule {}
