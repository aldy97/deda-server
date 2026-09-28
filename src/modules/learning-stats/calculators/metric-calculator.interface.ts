import { Message } from "@prisma/client";

// 统计口径：一轮对话 = 一条 role='user' 的消息（由 service 层过滤后传入）
export interface ConversationWithDevice extends Message {
  device?: {
    deviceId: string;
    name?: string | null;
  } | null;
}

export interface MetricCalculator<T> {
  calculate(conversations: ConversationWithDevice[]): T;
}
