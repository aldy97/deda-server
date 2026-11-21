/**
 * LLM 适配层历史组装的纯逻辑：把 DB 消息行组装成对话历史 + 最近 filler。
 * 从 LlmAdapterService.getDbHistory 抽出，无 this 状态，供独立单测。
 */
import { LlmService } from "@/modules/llm/llm.service";

/** getDbHistory 查询行（select role/content/rawPayload 三列） */
export interface HistoryRow {
  role: string;
  content: string;
  rawPayload: unknown;
}

export interface BuiltHistory {
  history: Array<{ role: "user" | "assistant"; content: string }>;
  recentFillers: string[];
}

/**
 * 把时间倒序取回的 DB 行组装为时间正序历史：
 * user 行原文直入；assistant 行剥离 filler 只留 answer，
 * 无边界信息的旧 assistant 行（extractAnswer 返回 null）跳过。
 * 口径同老链路 getRecentHistory；recentFillers 返回最近 5 轮 filler 原文。
 */
export function buildHistoryFromRows(rows: HistoryRow[]): BuiltHistory {
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  const fillers: string[] = [];
  for (const row of rows.slice().reverse()) {
    if (row.role === "user") {
      history.push({ role: "user", content: row.content });
      continue;
    }
    const answer = LlmService.extractAnswer(row.content, row.rawPayload);
    if (answer === null) {
      continue;
    }
    history.push({ role: "assistant", content: answer });
    const filler = (row.rawPayload as { filler?: unknown } | null)?.filler;
    if (typeof filler === "string" && filler.length > 0) {
      fillers.push(filler);
    }
  }
  return { history, recentFillers: fillers.slice(-5) };
}
