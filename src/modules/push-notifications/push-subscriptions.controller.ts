import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { JwtAuthGuard } from "@/modules/users/guards/jwt-auth.guard";
import { PushSubscriptionsService } from "./push-subscriptions.service";
import { ReportPushSubscriptionDto } from "./dto/report-push-subscription.dto";

interface RequestWithUser extends Request {
  user: { userId: string; openid: string };
}

@ApiTags("推送订阅")
@Controller("push-subscriptions")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PushSubscriptionsController {
  constructor(
    private readonly pushSubscriptionsService: PushSubscriptionsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: "上报订阅消息授权结果（accept 累计额度 / reject 清零）",
  })
  async report(
    @Body() dto: ReportPushSubscriptionDto,
    @Req() req: RequestWithUser,
  ) {
    return this.pushSubscriptionsService.report(req.user.userId, dto);
  }
}
