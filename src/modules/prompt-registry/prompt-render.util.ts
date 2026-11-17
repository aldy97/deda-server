import type { PromptVariableSpec } from "./prompt-keys";

/**
 * 模板占位符渲染。
 *
 * 只认 `{{name}}` 精确写法（不带空格），不引入模板引擎依赖。
 * 设计取向是 fail-loud：任何不确定情形都抛 PromptRenderError，
 * 由 PromptRegistryService 捕获后回落代码内默认 prompt——
 * 宁可退回默认，也绝不把 `{{xxx}}` 原样喂给模型。
 */
export class PromptRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptRenderError";
  }
}

const PLACEHOLDER_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** 按出现顺序去重列出模板里的占位符名；不匹配 `{{ name }}` 这类带空格写法 */
export function findPlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * 渲染模板。
 *
 * @param template 含 `{{name}}` 占位符的模板正文
 * @param vars     变量值；可传超集，未声明的键被忽略
 * @param spec     变量契约（代码为唯一真相，DB 里的 renderSchema 仅供展示）
 * @throws PromptRenderError 必填缺失/为空、模板含未声明占位符、
 *                           变量值非字符串、渲染后仍残留 `{{`（注入二次展开）
 */
export function renderPrompt(
  template: string,
  vars: Record<string, unknown>,
  spec: PromptVariableSpec[],
): string {
  const declared = new Set(spec.map((entry) => entry.name));

  for (const name of findPlaceholders(template)) {
    if (!declared.has(name)) {
      throw new PromptRenderError(
        `template placeholder {{${name}}} is not declared in the variable contract`,
      );
    }
  }

  for (const entry of spec) {
    if (!entry.required) continue;
    if (!findPlaceholders(template).includes(entry.name)) continue;
    const value = vars[entry.name];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new PromptRenderError(
        `required prompt variable "${entry.name}" is missing or empty`,
      );
    }
  }

  const rendered = template.replace(
    PLACEHOLDER_PATTERN,
    (_match, name: string) => {
      const value = vars[name];
      if (value === undefined || value === null) {
        return "";
      }
      if (typeof value !== "string") {
        throw new PromptRenderError(
          `prompt variable "${name}" must be a string, got ${typeof value}`,
        );
      }
      return value;
    },
  );

  // 变量值自带占位符会造成二次展开（admin 可编辑正文 → 潜在注入面），一律拒绝
  if (rendered.includes("{{") || rendered.includes("}}")) {
    throw new PromptRenderError(
      "rendered prompt still contains placeholder braces; refusing to emit",
    );
  }

  return rendered;
}
