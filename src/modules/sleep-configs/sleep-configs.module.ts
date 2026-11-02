import { Module } from "@nestjs/common";
import { SleepConfigsController } from "./sleep-configs.controller";
import { SleepConfigsService } from "./sleep-configs.service";

@Module({
  controllers: [SleepConfigsController],
  providers: [SleepConfigsService],
  exports: [SleepConfigsService],
})
export class SleepConfigsModule {}
