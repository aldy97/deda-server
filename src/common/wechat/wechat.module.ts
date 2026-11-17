import { Module } from "@nestjs/common";
import { WechatTokenService } from "./wechat-token.service";

@Module({
  providers: [WechatTokenService],
  exports: [WechatTokenService],
})
export class WechatModule {}
