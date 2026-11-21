/**
 * LLM 适配层请求解析的纯函数：设备提示解析、历史提取、错误描述。
 * 从 LlmAdapterService 抽出，无 this 状态，供独立单测。
 */
import { BadRequestException } from "@nestjs/common";
import { ChatCompletionRequest } from "./dto/chat-completion.dto";

/** 历史轮数上限：防爆上下文（最近 10 轮一问一答） */
export const MAX_HISTORY_TURNS = 10;

/** 统一错误描述：不把未知对象直接拼进日志 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 取最后一条 user 消息作为本轮 ASR 原文；没有则拒绝请求 */
export function lastUserMessage(req: ChatCompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i].role === "user") return req.messages[i].content;
  }
  throw new BadRequestException("messages must contain a user message");
}

/** 取最后一条 user 消息之前的 user/assistant 对作为历史，截最近 N 轮 */
export function extractHistory(
  req: ChatCompletionRequest,
): Array<{ role: "user" | "assistant"; content: string }> {
  const turns = req.messages.filter((m) => m.role !== "system");
  // 最后一条即当前 asrText，不进历史
  const prior = turns.slice(0, -1);
  const history = prior.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));
  return history.slice(-MAX_HISTORY_TURNS * 2);
}
