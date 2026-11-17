import {
  PromptRenderError,
  findPlaceholders,
  renderPrompt,
} from "./prompt-render.util";
import type { PromptVariableSpec } from "./prompt-keys";

const SPEC: PromptVariableSpec[] = [
  { name: "persona", required: true, description: "角色人设" },
  { name: "segmentText", required: true, description: "当前互动问题" },
  { name: "contextSection", required: false, description: "可选拼接段" },
];

describe("renderPrompt", () => {
  it("无占位符时原样返回", () => {
    expect(renderPrompt("你是安全分类器。", {}, [])).toBe("你是安全分类器。");
  });

  it("替换必填变量", () => {
    const template = "角色：{{persona}}\n问题：{{segmentText}}";
    expect(
      renderPrompt(
        template,
        { persona: "小象 Elly", segmentText: "走哪条路？" },
        SPEC,
      ),
    ).toBe("角色：小象 Elly\n问题：走哪条路？");
  });

  it("同一占位符出现多次时全部替换", () => {
    expect(
      renderPrompt(
        "{{persona}} 和 {{persona}}",
        { persona: "Elly", segmentText: "x" },
        SPEC,
      ),
    ).toBe("Elly 和 Elly");
  });

  it("可选变量缺省时渲染为空串", () => {
    expect(
      renderPrompt("前{{contextSection}}后", {}, [
        { name: "contextSection", required: false, description: "" },
      ]),
    ).toBe("前后");
  });

  it("可选变量提供空串时正常渲染", () => {
    expect(
      renderPrompt("前{{contextSection}}后", { contextSection: "" }, SPEC),
    ).toBe("前后");
  });

  it("声明了但模板未使用的变量不报错", () => {
    expect(
      renderPrompt(
        "只有 {{persona}}",
        { persona: "Elly", segmentText: "未被用到" },
        SPEC,
      ),
    ).toBe("只有 Elly");
  });

  it("必填变量缺失时抛 PromptRenderError", () => {
    expect(() =>
      renderPrompt("{{persona}}", { segmentText: "x" }, SPEC),
    ).toThrow(PromptRenderError);
    expect(() =>
      renderPrompt("{{persona}}", { segmentText: "x" }, SPEC),
    ).toThrow(/persona/);
  });

  it("必填变量为空串时抛 PromptRenderError", () => {
    expect(() =>
      renderPrompt("{{persona}}", { persona: "", segmentText: "x" }, SPEC),
    ).toThrow(PromptRenderError);
  });

  it("必填变量为纯空白时抛 PromptRenderError", () => {
    expect(() =>
      renderPrompt("{{persona}}", { persona: "   ", segmentText: "x" }, SPEC),
    ).toThrow(PromptRenderError);
  });

  it("模板含未声明的占位符时抛错（防 admin 写入代码不提供的变量）", () => {
    expect(() => renderPrompt("{{unknownVar}}", {}, SPEC)).toThrow(
      PromptRenderError,
    );
    expect(() => renderPrompt("{{unknownVar}}", {}, SPEC)).toThrow(
      /unknownVar/,
    );
  });

  it("带空格的占位符写法视为未声明并抛错", () => {
    expect(() =>
      renderPrompt("{{ persona }}", { persona: "Elly" }, SPEC),
    ).toThrow(PromptRenderError);
  });

  it("变量值本身含占位符时抛错（防注入二次展开）", () => {
    expect(() =>
      renderPrompt(
        "{{contextSection}}",
        { contextSection: "{{persona}}" },
        SPEC,
      ),
    ).toThrow(PromptRenderError);
  });

  it("变量值不是字符串时抛错", () => {
    expect(() =>
      renderPrompt("{{persona}}", { persona: 123 as unknown as string }, SPEC),
    ).toThrow(PromptRenderError);
  });

  // 上面那条命中的是「必填变量缺失」的前置校验；可选变量不走那条路径，
  // 这里单独覆盖渲染阶段的类型闸：拿到 number/boolean 必须炸，
  // 绝不 String() 静默转换后把 "123" 发给模型。
  it("可选变量传入非字符串时抛错（不静默转成字符串）", () => {
    expect(() =>
      renderPrompt(
        "{{contextSection}}",
        { contextSection: 123 as unknown as string },
        SPEC,
      ),
    ).toThrow(/must be a string/);
  });

  it("vars 里出现未声明的键不报错（调用方可传超集）", () => {
    expect(
      renderPrompt(
        "{{persona}}",
        { persona: "Elly", segmentText: "x", extra: "y" },
        SPEC,
      ),
    ).toBe("Elly");
  });

  it("保留模板中的花括号单字符", () => {
    expect(renderPrompt("JSON 格式 {field:null}", {}, [])).toBe(
      "JSON 格式 {field:null}",
    );
  });
});

describe("findPlaceholders", () => {
  it("按出现顺序去重返回占位符名", () => {
    expect(findPlaceholders("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });

  it("无占位符返回空数组", () => {
    expect(findPlaceholders("纯文本")).toEqual([]);
  });

  it("不匹配带空格的写法", () => {
    expect(findPlaceholders("{{ a }}")).toEqual([]);
  });
});
