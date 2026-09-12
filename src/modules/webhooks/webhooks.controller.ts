import { Controller, Post, Body, Headers } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { WebhooksService } from './webhooks.service';

@ApiTags('Webhook')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('conversation')
  async receiveConversation(
    @Body() payload: any,
    @Headers('x-idempotency-key') idempotencyKey?: string,
  ) {
    // TODO: 接收厂商对话结束 Webhook，幂等写入，更新学习统计
    return this.webhooksService.handleConversation(payload, idempotencyKey);
  }
}
