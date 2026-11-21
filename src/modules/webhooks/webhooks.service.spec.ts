import { WebhooksService } from "./webhooks.service";

describe("WebhooksService", () => {
  const service = new WebhooksService({} as never, {} as never);

  it("handleConversation 返回收到回执", async () => {
    expect(await service.handleConversation({})).toEqual({ received: true });
  });
});
