import { BadRequestException } from "@nestjs/common";
import {
  describeError,
  extractHistory,
  lastUserMessage,
  MAX_HISTORY_TURNS,
} from "./llm-adapter-request";
import type { ChatCompletionRequest } from "./dto/chat-completion.dto";

const req = (messages: unknown[]): ChatCompletionRequest =>
  ({ messages }) as unknown as ChatCompletionRequest;

describe("describeError", () => {
  it("Error 实例返回 message", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });
  it("非 Error 值 String 化", () => {
    expect(describeError("text")).toBe("text");
    expect(describeError(42)).toBe("42");
    expect(describeError(null)).toBe("null");
  });
});

describe("lastUserMessage", () => {
  it("返回最后一条 user 消息", () => {
    const m = req([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "最后一句" },
    ]);
    expect(lastUserMessage(m)).toBe("最后一句");
  });

  it("无 user 消息时抛 BadRequestException", () => {
    expect(() =>
      lastUserMessage(req([{ role: "assistant", content: "x" }])),
    ).toThrow(BadRequestException);
  });
});

describe("extractHistory", () => {
  it("过滤 system、去掉最后一条 user、截断最近 N 轮", () => {
    const messages = [
      { role: "system", content: "sys" },
      ...Array.from({ length: MAX_HISTORY_TURNS * 2 + 2 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `m${i}`,
      })),
      { role: "user", content: "当前话术" },
    ];
    const history = extractHistory(req(messages));
    expect(history.length).toBe(MAX_HISTORY_TURNS * 2);
    // 最后一条 user 被排除，且不含 system
    expect(history.some((m) => m.content === "当前话术")).toBe(false);
    expect(history.some((m) => m.content === "sys")).toBe(false);
  });
});
