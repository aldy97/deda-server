import { Module } from "@nestjs/common";
import { WechatModule } from "@/common/wechat/wechat.module";
import { PushSubscriptionsController } from "./push-subscriptions.controller";
import { PushSubscriptionsService } from "./push-subscriptions.service";
import { PushSenderService } from "./push-sender.service";

@Module({
  imports: [WechatModule],
  controllers: [PushSubscriptionsController],
  providers: [PushSubscriptionsService, PushSenderService],
  exports: [PushSenderService],
})
export class PushNotificationsModule {}
