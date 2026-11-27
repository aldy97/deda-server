import { Module } from "@nestjs/common";
import { ConversationNetworkAggregator } from "./conversation-network-aggregator.service";

@Module({
  providers: [ConversationNetworkAggregator],
  exports: [ConversationNetworkAggregator],
})
export class ConversationNetworkModule {}
