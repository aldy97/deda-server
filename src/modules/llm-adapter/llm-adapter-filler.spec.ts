import {
  checkFillerHead,
  fillerFallback,
  fillerTemplateFor,
  isFillerDuplicate,
  logFillerPostChecks,
  normalizeFiller,
} from "./llm-adapter-filler";

describe("normalizeFiller", () => {
  it("去大小写/空白/标点/符号", () => {
    expect(normalizeFiller("Hello, 世界！")).toBe("hello世界");
    expect(normalizeFiller("  A B  C  ")).toBe("abc");
  });
});

describe("isFillerDuplicate", () => {
  it("归一化后逐字比对", () => {
    expect(isFillerDuplicate("Hello World", ["hello world"])).toBe(true);
    expect(isFillerDuplicate("Hello World", ["别的", "hello,world"])).toBe(
      true,
    );
    expect(isFillerDuplicate("新句子", ["旧的"])).toBe(false);
    expect(isFillerDuplicate("新句子", [])).toBe(false);
  });
});

describe("checkFillerHead", () => {
  it("任意位置出现人设名 → reject", () => {
    expect(checkFillerHead("我是小象Elly呀", undefined, "小象 Elly")).toBe(
      "reject",
    );
  });

  it("剥离语气词后以孩子名开头 → reject", () => {
    expect(checkFillerHead("呀小明你好", "小明", "小象 Elly")).toBe("reject");
  });

  it("缓冲不足 8 字且无违规 → undecided", () => {
    expect(checkFillerHead("你好", undefined, "小象 Elly")).toBe("undecided");
  });

  it("缓冲足够且无违规 → pass", () => {
    expect(checkFillerHead("这句话足够长了呀", undefined, "小象 Elly")).toBe(
      "pass",
    );
  });

  it("final=true 时短句也 pass（完整文本上定论）", () => {
    expect(checkFillerHead("你好", undefined, "小象 Elly", true)).toBe("pass");
  });

  it("final=true 但短句违规仍 reject", () => {
    expect(checkFillerHead("小象Elly", undefined, "小象 Elly", true)).toBe(
      "reject",
    );
  });
});

describe("fillerTemplateFor", () => {
  it("身份问句返回身份模板（中文）", () => {
    const t = fillerTemplateFor("你叫什么名字呀", []);
    expect(t).toBeTruthy();
    expect(t!.length).toBeGreaterThan(0);
  });

  it("偏好问句返回偏好模板", () => {
    const t = fillerTemplateFor("你喜欢吃什么", []);
    expect(t).toBeTruthy();
  });

  it("非窄类问句返回 null", () => {
    expect(fillerTemplateFor("今天天气怎么样", [])).toBeNull();
  });

  it("池内首选重复时换次选", () => {
    const t = fillerTemplateFor("你叫什么名字呀", [
      "你在问我的名字呀，让我想一想怎么介绍自己呢……",
    ]);
    expect(t).toBe("你想知道我是谁呀，这个问题还挺有意思的呢……");
  });
});

describe("fillerFallback", () => {
  it("返回通用模板池里的非重复项", () => {
    const t = fillerFallback("随便说点什么", []);
    expect(t).toBeTruthy();
  });
  it("首选重复时换次选", () => {
    const t = fillerFallback("随便说点什么", [
      "嗯嗯，我在认真听呢，你接着往下说呀……",
    ]);
    expect(t).toBe("哇，你说的话真有意思呀，我还想再听呢……");
  });
});

describe("logFillerPostChecks", () => {
  const logger = () => ({ warn: jest.fn() });

  it("空文本不告警", () => {
    const log = logger();
    logFillerPostChecks(log, "", [], "小象 Elly");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("重复 filler 告警", () => {
    const log = logger();
    logFillerPostChecks(log, "已经说过的话", ["已经说过的话"], "小象 Elly");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("repeated"));
  });

  it("低于长度下限告警", () => {
    const log = logger();
    logFillerPostChecks(log, "短", [], "小象 Elly");
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("shorter"));
  });

  it("含人设名告警", () => {
    const log = logger();
    logFillerPostChecks(log, "这句话里有小象Elly的名字", [], "小象 Elly");
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("persona name"),
    );
  });
});
