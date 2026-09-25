import { Conversation } from "@prisma/client";

export interface ConversationWithDevice extends Conversation {
  device?: {
    deviceId: string;
    name?: string | null;
  } | null;
}

export interface MetricCalculator<T> {
  calculate(conversations: ConversationWithDevice[]): T;
}
