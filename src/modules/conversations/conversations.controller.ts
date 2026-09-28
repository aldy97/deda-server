import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Request } from "express";
import { ConversationsService } from "./conversations.service";
import { JwtAuthGuard } from "@/modules/users/guards/jwt-auth.guard";

interface RequestWithUser extends Request {
  user: { userId: string; openid: string };
}

@ApiTags("对话记录")
@Controller("conversations")
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get()
  async list(@Req() req: RequestWithUser, @Query() query: any) {
    return this.conversationsService.list(req.user.userId, query);
  }
}
