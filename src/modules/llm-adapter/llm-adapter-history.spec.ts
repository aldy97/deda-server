import { buildHistoryFromRows, HistoryRow } from "./llm-adapter-history";

describe("buildHistoryFromRows", () => {
  it("user 行原文直入，assistant 行剥 filler 留 answer", () => {
    // rows 为时间倒序（最新在前），函数 reverse 后正序输出
    const rows: HistoryRow[] = [
      { role: "user", content: "你好", rawPayload: null },
      {
        role: "assistant",
        content: "播报全文",
        rawPayload: { answer: "回答", filler: "嗯嗯" },
      },
    ];
    const built = buildHistoryFromRows(rows);
    expect(built.history).toEqual([
      { role: "assistant", content: "回答" },
      { role: "user", content: "你好" },
    ]);
    expect(built.recentFillers).toEqual(["嗯嗯"]);
  });

  it("无边界信息的旧 assistant 行（answer 缺失）跳过", () => {
    const rows: HistoryRow[] = [
      { role: "user", content: "你好", rawPayload: null },
      { role: "assistant", content: "旧数据", rawPayload: {} },
    ];
    const built = buildHistoryFromRows(rows);
    expect(built.history).toEqual([{ role: "user", content: "你好" }]);
    expect(built.recentFillers).toEqual([]);
  });

  it("时间倒序输入正序输出，recentFillers 只留最近 5 轮", () => {
    const rows: HistoryRow[] = Array.from({ length: 7 }, (_, i) => ({
      role: "assistant" as const,
      content: `t${i}`,
      rawPayload: { answer: `a${i}`, filler: `f${i}` },
    }));
    const built = buildHistoryFromRows(rows);
    // 输入是倒序（最新的在前），输出正序（最旧的在前）
    expect(built.history[0].content).toBe("a6");
    expect(built.history[6].content).toBe("a0");
    // fillers 正序（最旧→最新），slice(-5) 取最新 5 轮
    expect(built.recentFillers).toEqual(["f4", "f3", "f2", "f1", "f0"]);
  });
});
