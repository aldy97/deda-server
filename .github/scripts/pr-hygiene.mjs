#!/usr/bin/env node
/**
 * PR 正文结构闸口（L2）。三仓（deda-server / deda-dashboard / deda-wechat-app）共用
 * **逐字节相同**的这一份脚本，仓库差异全部落在两个数据文件里：
 *
 *   .github/pr-hygiene.json                  base → 用哪个模板
 *   .github/PULL_REQUEST_TEMPLATE/*.md       段落骨架本身就是必需段清单
 *
 * 必需段不写死在代码里，而是**从选定模板派生**：模板是唯一事实来源，改模板即改闸口，
 * 加/删一个段不需要动脚本。派生规则：
 *   - 取模板里最浅的标题层级为 topLevel；
 *   - 若 topLevel 只有一个标题且其下还有更深一级的标题 → 认定是「包裹标题 + 子段」形态
 *     （release PR 的历史写法：一个 H2 包裹 + 若干 H3），必需段取深一级的那批，
 *     包裹标题本身不参与判定（它的措辞每个 PR 都不一样）；
 *   - 否则必需段就是 topLevel 那批（feature PR 的平铺 H2 写法）；
 *   - 必需段下若还有更深一级的标题，就是该段的必需子段（人工测试三段/两段由此自动裁剪，
 *     wechat-app 的模板只写两个子段，闸口就只查两个）；
 *   - 段落内容里出现 `<!-- optional -->` → 该段可整段缺席；但一旦写了标题仍必须填。
 *
 * 正文匹配对层级宽容：段标题写成 H2 或 H3 都认（两种历史习惯并存），子段只要比父段深一级。
 * 只校验段落骨架与是否填过，不校验措辞、不做 checkbox 正则（那是被否掉的 L3）。
 * 强制力来自协作铁律「CI 全绿才允许 merge」，不进分支保护 required checks（那是 L4，
 * 单人仓库把自己锁死的经典事故）。
 *
 * 两条 fail-open 铁则：正文/配置/模板取不到，或脚本自身出任何异常，一律放过。
 * 闸口宁可漏判也不可因为 API 抖动、配置缺失或解析 bug 把 PR 全部卡死。
 *
 * 输入（与 ci.yml 的接线一致，全走 env，不走 argv，避免正文里的引号换行被 shell 二次解析）：
 *   PR_BODY            PR 正文；未定义 = 事件负载里没有 body，fail-open
 *   PR_BODY_FILE       从文件读正文，优先于 PR_BODY，便于本地拿真实 PR 正文自检
 *   PR_BASE            目标分支，用于查 pr-hygiene.json 的 byBase
 *   PR_HYGIENE_CONFIG  映射配置路径，默认 <repo>/.github/pr-hygiene.json（测试注入用）
 *   PR_TEMPLATE_DIR    模板目录，默认 <repo>/.github/PULL_REQUEST_TEMPLATE（测试注入用）
 *
 * 退出码：0 = 通过或 fail-open；1 = 明确缺段/空段
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const DEFAULT_CONFIG_PATH = join(REPO_ROOT, ".github", "pr-hygiene.json");
const DEFAULT_TEMPLATE_DIR = join(REPO_ROOT, ".github", "PULL_REQUEST_TEMPLATE");

/** 正文里段标题可接受的层级：H2（平铺习惯）与 H3（包裹 + 子段习惯）都认。 */
const SECTION_LEVELS = [2, 3];
const OPTIONAL_MARKER = /<!--\s*optional\s*-->/i;

function failOpen(reason) {
  console.log(`PR 正文规范检查 · fail-open 放过：${reason}`);
  process.exit(0);
}

function rel(path) {
  return path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length + 1) : path;
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
 * 不挡这一层，模板里的示例写法就能把闸口喂饱。
 */
function parseOutline(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
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

/** YAML front-matter（模板的 name/about）不参与段表派生。 */
function stripFrontMatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
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

/** 从模板正文派生必需段清单。 */
function deriveContract(templateText) {
  const { lines, headings } = parseOutline(stripFrontMatter(templateText));
  if (headings.length === 0) return null;

  const topLevel = Math.min(...headings.map((heading) => heading.level));
  const topCount = headings.filter((h) => h.level === topLevel).length;
  const hasDeeper = headings.some((h) => h.level === topLevel + 1);
  const sectionLevel = topCount === 1 && hasDeeper ? topLevel + 1 : topLevel;

  const sections = [];
  headings.forEach((heading, pos) => {
    if (heading.level !== sectionLevel) return;
    const content = contentOf(headings, lines, pos);
    const subsections = [];
    for (let next = pos + 1; next < headings.length; next++) {
      if (headings[next].level <= sectionLevel) break;
      if (headings[next].level === sectionLevel + 1) {
        subsections.push(headings[next].title);
      }
    }
    sections.push({
      title: heading.title,
      optional: OPTIONAL_MARKER.test(content.join("\n")),
      subsections,
    });
  });

  return sections.length > 0 ? { sections } : null;
}

function titleMatches(actual, required) {
  return actual === required || actual.startsWith(required);
}

/** 在正文里找一个必需段：层级宽容（H2 或 H3 都认），取第一个匹配的。 */
function findSection(headings, lines, required) {
  for (let pos = 0; pos < headings.length; pos++) {
    const heading = headings[pos];
    if (!SECTION_LEVELS.includes(heading.level)) continue;
    if (!titleMatches(heading.title, required)) continue;
    return { heading, content: contentOf(headings, lines, pos) };
  }
  return null;
}

/** 在父段管辖范围内找一个子段：层级必须比父段深。 */
function findSubsection(headings, lines, required, parent) {
  const end = parent.heading.index + 1 + parent.content.length;
  for (let pos = 0; pos < headings.length; pos++) {
    const heading = headings[pos];
    if (heading.level <= parent.heading.level) continue;
    if (heading.index <= parent.heading.index || heading.index >= end) continue;
    if (!titleMatches(heading.title, required)) continue;
    return { heading, content: contentOf(headings, lines, pos, end) };
  }
  return null;
}

function loadTemplate(base) {
  const configPath = process.env.PR_HYGIENE_CONFIG || DEFAULT_CONFIG_PATH;
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    failOpen(
      `映射配置 ${rel(configPath)} 读不到或不是合法 JSON（${err?.code ?? "unknown"}）`,
    );
  }
  if (!config || typeof config.default !== "string" || config.default === "") {
    failOpen(`映射配置 ${rel(configPath)} 缺 default 字段`);
  }

  const byBase =
    config.byBase && typeof config.byBase === "object" ? config.byBase : {};
  const name = (base && byBase[base]) || config.default;
  if (typeof name !== "string" || name === "") {
    failOpen(`映射配置 ${rel(configPath)} 里 base=${base} 指向的模板名非法`);
  }

  const templateDir = process.env.PR_TEMPLATE_DIR || DEFAULT_TEMPLATE_DIR;
  const templatePath = isAbsolute(name) ? name : join(templateDir, name);
  let text;
  try {
    text = readFileSync(templatePath, "utf8");
  } catch (err) {
    failOpen(
      `模板 ${rel(templatePath)} 读不到（${err?.code ?? "unknown"}），无契约可依`,
    );
  }
  return { name, text };
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
  const template = loadTemplate(base);
  const contract = deriveContract(template.text);
  const header = `PR 正文规范检查 · 模板 ${template.name}（base=${base || "未知"}）`;

  if (!contract) {
    failOpen(`模板 ${template.name} 里没有可派生的标题，无契约可依`);
  }

  const { lines, headings } = parseOutline(readBody());
  const missing = [];
  const empty = [];
  const missingSubs = [];
  const emptySubs = [];
  let filled = 0;
  let subFilled = 0;
  let subTotal = 0;
  let optionalSkipped = 0;

  for (const section of contract.sections) {
    const found = findSection(headings, lines, section.title);
    if (!found) {
      if (section.optional) optionalSkipped += 1;
      else missing.push(section.title);
      continue;
    }
    if (!hasSubstance(found.content)) {
      empty.push(section.title);
      continue;
    }
    filled += 1;
    for (const sub of section.subsections) {
      subTotal += 1;
      const foundSub = findSubsection(headings, lines, sub, found);
      if (!foundSub) missingSubs.push(`${section.title} → ${sub}`);
      else if (!hasSubstance(foundSub.content)) {
        emptySubs.push(`${section.title} → ${sub}`);
      } else subFilled += 1;
    }
  }

  const clean =
    missing.length === 0 &&
    empty.length === 0 &&
    missingSubs.length === 0 &&
    emptySubs.length === 0;

  if (clean) {
    console.log(header);
    console.log(
      `✓ 必需段落 ${filled}/${contract.sections.length - optionalSkipped} 齐备` +
        (subTotal > 0 ? `，子段 ${subFilled}/${subTotal} 有实质内容` : "") +
        (optionalSkipped > 0 ? `，optional 段缺席 ${optionalSkipped} 个` : ""),
    );
    return;
  }

  console.log(header);
  if (missing.length > 0) console.log(`✗ 缺少必需段落：${missing.join("、")}`);
  if (empty.length > 0) {
    console.log(`✗ 段落为空（只剩模板提示行或空白）：${empty.join("、")}`);
  }
  if (missingSubs.length > 0) {
    console.log(`✗ 缺少必需子段：${missingSubs.join("、")}`);
  }
  if (emptySubs.length > 0) {
    console.log(`✗ 子段为空（只剩模板提示行或空白）：${emptySubs.join("、")}`);
  }
  console.log(
    `提示：按 .github/PULL_REQUEST_TEMPLATE/${template.name} 的骨架补齐；每项人工测试都要带期望结果，` +
      "确实无需人工测试写「无」+ 一句理由，禁止留空或删段（标了 optional 的段可整段省略）。",
  );
  process.exitCode = 1;
}

try {
  main();
} catch (err) {
  failOpen(`校验脚本自身异常（${err?.name ?? "unknown"}），不因此卡住 PR`);
}
