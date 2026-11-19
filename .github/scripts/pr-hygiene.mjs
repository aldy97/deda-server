#!/usr/bin/env node
/**
 * PR 正文结构闸口（L2）。
 *
 * 只校验段落骨架是否齐备、是否被填过，不校验措辞、不做 checkbox 正则（那是被否掉的 L3）。
 * 强制力来自协作铁律「CI 全绿才允许 merge」，不进分支保护 required checks（那是 L4，
 * 单人仓库把自己锁死的经典事故）。
 *
 * 两条 fail-open 铁则：body 取不到、或脚本自身出任何异常，一律放过。
 * 闸口宁可漏判也不可因为 API 抖动或解析 bug 把 PR 全部卡死。
 *
 * 输入（与 ci.yml 的接线一致，全走 env，不走 argv，避免正文里的引号换行被 shell 二次解析）：
 *   PR_BODY      PR 正文；未定义 = 事件负载里没有 body，fail-open
 *   PR_BODY_FILE 从文件读正文，优先于 PR_BODY，便于本地拿真实 PR 正文自检
 *   PR_BASE      目标分支；main = release 段表，其余一律按 feature 段表
 *
 * 退出码：0 = 通过或 fail-open；1 = 明确缺段/空段
 */
import { readFileSync } from "node:fs";

const MANUAL_SECTION = "需要人工测试的地方";

const TEMPLATES = {
  feature: {
    file: "feature-to-staging.md",
    sections: [
      "一句话结论",
      "改了什么",
      "风险披露",
      "自动化验证",
      MANUAL_SECTION,
      "本 PR 没有交付的",
      "文件清单",
    ],
    manualSubsections: [
      "作者已实测",
      "合并到 staging 后需要人工点",
      "上线 prod 后需要人工点",
    ],
  },
  release: {
    file: "release-to-main.md",
    sections: [
      "本次带入",
      "prod 实际影响面",
      "验证",
      "上线后人工验证清单",
      "回滚",
      "已知待办",
    ],
    manualSubsections: [],
  },
};

function failOpen(reason) {
  console.log(`PR 正文规范检查 · fail-open 放过：${reason}`);
  process.exit(0);
}

/** 段名归一化：去 markdown 修饰、去尾部括号后缀（「文件清单（12）」→「文件清单」）。 */
function normalizeTitle(raw) {
  return raw
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[（(][^（）()]*[)）]\s*$/, "")
    .trim();
}

/**
 * 解析出围栏外的所有标题。围栏内的 ## 属于示例代码，不是真段落——
 * 不挡这一层，模板示例本身就能把闸口喂饱。
 */
function parseOutline(body) {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const headings = [];
  let fence = null;

  lines.forEach((line, index) => {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence !== null) return;

    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      headings.push({
        level: match[1].length,
        title: normalizeTitle(match[2]),
        index,
      });
    }
  });

  return { lines, headings };
}

/** 某个标题管辖的正文行：到下一个同级或更高级标题为止。 */
function contentOf(headings, lines, pos, hardEnd = lines.length) {
  const level = headings[pos].level;
  let end = Math.min(hardEnd, lines.length);
  for (let next = pos + 1; next < headings.length; next++) {
    if (headings[next].level <= level) {
      end = Math.min(end, headings[next].index);
      break;
    }
  }
  return lines.slice(headings[pos].index + 1, end);
}

/**
 * 是否填过：剥掉 HTML 注释与「>」引导的模板提示行后还有实质内容。
 * 模板里所有格式要求都写在提示行里，所以原样交回来的空模板必然判空。
 */
function hasSubstance(contentLines) {
  const stripped = contentLines.join("\n").replace(/<!--[\s\S]*?-->/g, "");
  return stripped
    .split("\n")
    .some((line) => line.trim() !== "" && !line.trim().startsWith(">"));
}

function findSection(headings, lines, required, level = 2, range = null) {
  for (let pos = 0; pos < headings.length; pos++) {
    const heading = headings[pos];
    if (heading.level !== level) continue;
    if (range && (heading.index < range.start || heading.index >= range.end)) {
      continue;
    }
    if (heading.title === required || heading.title.startsWith(required)) {
      return { pos, heading, content: contentOf(headings, lines, pos, range?.end) };
    }
  }
  return null;
}

function readBody() {
  const file = process.env.PR_BODY_FILE;
  if (file) {
    try {
      return readFileSync(file, "utf8");
    } catch (err) {
      failOpen(`读取 PR_BODY_FILE 失败（${err?.code ?? "unknown"}），不因此卡住 PR`);
    }
  }
  const body = process.env.PR_BODY;
  if (body === undefined) {
    failOpen("未取到 PR body（非 pull_request 事件或事件负载缺失）");
  }
  return body;
}

function main() {
  const base = process.env.PR_BASE ?? "";
  const template = base === "main" ? TEMPLATES.release : TEMPLATES.feature;
  const header = `PR 正文规范检查 · 模板 ${template.file}（base=${base || "未知"}）`;

  const body = readBody();
  const { lines, headings } = parseOutline(body);

  const missing = [];
  const empty = [];
  const found = new Map();

  for (const required of template.sections) {
    const section = findSection(headings, lines, required);
    if (!section) {
      missing.push(required);
      continue;
    }
    found.set(required, section);
    if (!hasSubstance(section.content)) empty.push(required);
  }

  const missingSubs = [];
  const emptySubs = [];
  const manual = found.get(MANUAL_SECTION);
  if (manual && template.manualSubsections.length > 0) {
    const range = {
      start: manual.heading.index,
      end: manual.heading.index + 1 + manual.content.length,
    };
    for (const required of template.manualSubsections) {
      const sub = findSection(headings, lines, required, 3, range);
      if (!sub) {
        missingSubs.push(required);
      } else if (!hasSubstance(sub.content)) {
        emptySubs.push(required);
      }
    }
  }

  if (missing.length === 0 && empty.length === 0 && missingSubs.length === 0 && emptySubs.length === 0) {
    console.log(header);
    console.log(
      `✓ 必需段落 ${template.sections.length}/${template.sections.length} 齐备` +
        (template.manualSubsections.length > 0
          ? `，「${MANUAL_SECTION}」${template.manualSubsections.length} 个子段均有实质内容`
          : ""),
    );
    return;
  }

  console.log(header);
  if (missing.length > 0) console.log(`✗ 缺少必需段落：${missing.join("、")}`);
  if (empty.length > 0) {
    console.log(`✗ 段落为空（只剩模板提示行或空白）：${empty.join("、")}`);
  }
  if (missingSubs.length > 0) {
    console.log(`✗ 「${MANUAL_SECTION}」缺子段：${missingSubs.join("、")}`);
  }
  if (emptySubs.length > 0) {
    console.log(`✗ 「${MANUAL_SECTION}」子段为空：${emptySubs.join("、")}`);
  }
  console.log(
    `提示：用 gh pr create --template ${template.file} 重建正文；每项人工测试都要带期望结果，` +
      "确实无需人工测试写「无」+ 一句理由，禁止留空或删段。",
  );
  process.exitCode = 1;
}

try {
  main();
} catch (err) {
  failOpen(`校验脚本自身异常（${err?.name ?? "unknown"}），不因此卡住 PR`);
}
