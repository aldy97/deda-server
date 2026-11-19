import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const SCRIPT = join(REPO_ROOT, ".github/scripts/pr-hygiene.mjs");
const REAL_TEMPLATE_DIR = join(REPO_ROOT, ".github/PULL_REQUEST_TEMPLATE");
const REAL_CONFIG = join(REPO_ROOT, ".github/pr-hygiene.json");

type RunResult = { status: number | null; stdout: string; stderr: string };

/**
 * 黑盒调用校验脚本：正文、base、模板目录、映射配置全走 env（与 ci.yml 的接线一致），
 * 不走 argv，避免正文里的引号与换行在 shell 层被二次解析。
 */
function run(options: {
  body?: string;
  bodyFile?: string;
  base?: string;
  templateDir?: string;
  config?: string;
}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PR_BODY;
  delete env.PR_BODY_FILE;
  if (options.body !== undefined) env.PR_BODY = options.body;
  if (options.bodyFile !== undefined) env.PR_BODY_FILE = options.bodyFile;
  env.PR_BASE = options.base ?? "staging";
  if (options.templateDir) env.PR_TEMPLATE_DIR = options.templateDir;
  if (options.config) env.PR_HYGIENE_CONFIG = options.config;

  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  } as RunResult;
}

const tempDirs: string[] = [];

/** 造一个隔离的「模板目录 + 映射配置」夹具，让派生逻辑不依赖仓库真模板。 */
function makeFixture(
  templates: Record<string, string>,
  config: Record<string, unknown> | string | null,
) {
  const dir = mkdtempSync(join(tmpdir(), "pr-hygiene-fx-"));
  tempDirs.push(dir);
  const templateDir = join(dir, "templates");
  mkdirSync(templateDir, { recursive: true });
  for (const [name, text] of Object.entries(templates)) {
    writeFileSync(join(templateDir, name), text, "utf8");
  }
  const configPath = join(dir, "pr-hygiene.json");
  if (config !== null) {
    writeFileSync(
      configPath,
      typeof config === "string" ? config : JSON.stringify(config),
      "utf8",
    );
  }
  return { templateDir, config: configPath };
}

const FRONT_MATTER = "---\nname: Fixture\nabout: 夹具模板\n---\n\n";

/** flat 形态：三个 H2 段，其中人工测试段带两个 H3 子段。 */
const TPL_FLAT =
  FRONT_MATTER +
  [
    "## 一句话结论",
    "> 提示行不算内容",
    "## 改了什么",
    "> 提示行不算内容",
    "## 需要人工测试的地方",
    "<!-- 两个子段都要写 -->",
    "### 作者已实测",
    "> 提示",
    "### 合并后需要人工点",
    "> 提示",
  ].join("\n");

/** wrapper 形态：一个 H2 包裹标题 + 三个 H3 段，末段标 optional。 */
const TPL_WRAPPER =
  FRONT_MATTER +
  [
    "## 发布 PR（夹具）：`staging` → `main`",
    "> 包裹标题不参与判定，可随意改写",
    "### 本次带入",
    "> 提示",
    "### 验证",
    "> 提示",
    "### 已知待办（不阻塞发布）",
    "<!-- optional -->",
    "> 提示",
  ].join("\n");

/** 模板里带围栏，围栏内的 ## 不能被当成必需段派生出来。 */
const TPL_FENCED =
  FRONT_MATTER +
  ["## 甲段", "> 提示", "## 示例写法", "```markdown", "## 假段名", "```"].join(
    "\n",
  );

const CFG_BOTH = {
  default: "flat.md",
  byBase: { main: "wrapper.md" },
};

const BODY_FLAT_OK = [
  "## 一句话结论",
  "落地闸口。",
  "## 改了什么",
  "- 脚本改为从模板派生段表",
  "## 需要人工测试的地方",
  "### 作者已实测",
  "- [x] 场景：夹具；期望：exit 0；实测：通过",
  "### 合并后需要人工点",
  "- 无（不改运行时接口）",
].join("\n");

const BODY_WRAPPER_OK = [
  "## 发布 PR（后端侧）：`staging` → `main`",
  "### 本次带入",
  "| PR | 人工验证项数 |",
  "| --- | --- |",
  "| #75 | 3 |",
  "### 验证",
  "- staging CI 全绿",
  "### 已知待办（不阻塞发布）",
  "- 无",
].join("\n");

beforeAll(() => {
  // 真实仓库产物也必须存在，否则后面几组用例是无意义的空跑
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("仓库产物齐备", () => {
  it("校验脚本存在", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it("映射配置存在且是合法 JSON，default 必填", () => {
    expect(existsSync(REAL_CONFIG)).toBe(true);
    const cfg = JSON.parse(readFileSync(REAL_CONFIG, "utf8"));
    expect(typeof cfg.default).toBe("string");
  });

  it("配置里 default 与 byBase 指向的模板文件都真实存在", () => {
    const cfg = JSON.parse(readFileSync(REAL_CONFIG, "utf8"));
    const names = [cfg.default, ...Object.values(cfg.byBase ?? {})];
    for (const name of names as string[]) {
      expect(existsSync(join(REAL_TEMPLATE_DIR, name))).toBe(true);
    }
  });
});

describe("段表从模板派生，不再写死在脚本里", () => {
  it("flat 模板：H2 即必需段，齐备放行", () => {
    const fx = makeFixture({ "flat.md": TPL_FLAT }, { default: "flat.md" });
    const res = run({ body: BODY_FLAT_OK, ...fx });
    expect(res.status).toBe(0);
  });

  it("flat 模板：缺任一段即红并点名", () => {
    const fx = makeFixture({ "flat.md": TPL_FLAT }, { default: "flat.md" });
    const res = run({
      body: BODY_FLAT_OK.replace(/## 改了什么[\s\S]*?(?=## )/, ""),
      ...fx,
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("改了什么");
  });

  it("wrapper 模板：必需段是 H3，包裹标题不参与判定", () => {
    const fx = makeFixture({ "w.md": TPL_WRAPPER }, { default: "w.md" });
    const res = run({ body: BODY_WRAPPER_OK, ...fx });
    expect(res.status).toBe(0);
  });

  it("wrapper 模板：包裹标题文字随意改写仍放行", () => {
    const fx = makeFixture({ "w.md": TPL_WRAPPER }, { default: "w.md" });
    const body = BODY_WRAPPER_OK.replace(
      "## 发布 PR（后端侧）：`staging` → `main`",
      "## 这次发布带上去的东西",
    );
    expect(run({ body, ...fx }).status).toBe(0);
  });

  it("wrapper 模板：缺 H3 段即红并点名", () => {
    const fx = makeFixture({ "w.md": TPL_WRAPPER }, { default: "w.md" });
    const body = BODY_WRAPPER_OK.replace(/### 验证[\s\S]*?(?=### )/, "");
    const res = run({ body, ...fx });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("验证");
  });

  it("模板段落下的 H3 派生成必需子段，缺子段即红", () => {
    const fx = makeFixture({ "flat.md": TPL_FLAT }, { default: "flat.md" });
    const body = BODY_FLAT_OK.replace(/### 合并后需要人工点[\s\S]*$/, "");
    const res = run({ body, ...fx });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("合并后需要人工点");
  });

  it("模板围栏内的 ## 不会被派生成必需段", () => {
    const fx = makeFixture({ "f.md": TPL_FENCED }, { default: "f.md" });
    const body = "## 甲段\n写了内容\n## 示例写法\n也写了内容\n";
    const res = run({ body, ...fx });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("假段名");
  });

  it("模板 front-matter 不参与派生", () => {
    const fx = makeFixture({ "flat.md": TPL_FLAT }, { default: "flat.md" });
    const res = run({ body: BODY_FLAT_OK, ...fx });
    expect(res.stdout).not.toContain("Fixture");
    expect(res.status).toBe(0);
  });
});

describe("optional 标记：缺段放过，写了就必须填", () => {
  it("标了 <!-- optional --> 的段整段不写 → 放行", () => {
    const fx = makeFixture({ "w.md": TPL_WRAPPER }, { default: "w.md" });
    const body = BODY_WRAPPER_OK.replace(
      /### 已知待办（不阻塞发布）[\s\S]*$/,
      "",
    );
    expect(run({ body, ...fx }).status).toBe(0);
  });

  it("optional 段写了标题却留空 → 仍然拦下", () => {
    const fx = makeFixture({ "w.md": TPL_WRAPPER }, { default: "w.md" });
    const body = BODY_WRAPPER_OK.replace(
      /### 已知待办（不阻塞发布）[\s\S]*$/,
      "### 已知待办（不阻塞发布）\n> 只剩提示行\n",
    );
    const res = run({ body, ...fx });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("已知待办");
  });

  it("未标 optional 的段缺失 → 拦下（对照组）", () => {
    const fx = makeFixture({ "w.md": TPL_WRAPPER }, { default: "w.md" });
    const body = BODY_WRAPPER_OK.replace(/### 本次带入[\s\S]*?(?=### )/, "");
    const res = run({ body, ...fx });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("本次带入");
  });
});

describe("base → 模板映射（每仓一份配置）", () => {
  const templates = { "flat.md": TPL_FLAT, "wrapper.md": TPL_WRAPPER };

  it("byBase 命中：base=main 用 release 段表", () => {
    const fx = makeFixture(templates, CFG_BOTH);
    expect(run({ body: BODY_WRAPPER_OK, base: "main", ...fx }).status).toBe(0);
    expect(run({ body: BODY_FLAT_OK, base: "main", ...fx }).status).toBe(1);
  });

  it("byBase 未命中：base=staging 回落 default", () => {
    const fx = makeFixture(templates, CFG_BOTH);
    expect(run({ body: BODY_FLAT_OK, base: "staging", ...fx }).status).toBe(0);
  });

  it("没有 byBase 字段时 base=main 也走 default（wechat-app 形态）", () => {
    const fx = makeFixture(templates, { default: "flat.md" });
    expect(run({ body: BODY_FLAT_OK, base: "main", ...fx }).status).toBe(0);
  });

  it("堆叠 PR 的非常规 base 也回落 default", () => {
    const fx = makeFixture(templates, CFG_BOTH);
    expect(
      run({ body: BODY_FLAT_OK, base: "feat/some-stack", ...fx }).status,
    ).toBe(0);
  });

  it("配置文件不存在 → fail-open", () => {
    const fx = makeFixture(templates, null);
    const res = run({ body: "随便写点什么", ...fx });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("fail-open");
  });

  it("配置 JSON 畸形 → fail-open", () => {
    const fx = makeFixture(templates, "{ 这不是 JSON");
    expect(run({ body: "随便", ...fx }).status).toBe(0);
  });

  it("配置缺 default 字段 → fail-open", () => {
    const fx = makeFixture(templates, { byBase: { main: "wrapper.md" } });
    expect(run({ body: "随便", ...fx }).status).toBe(0);
  });

  it("配置指向的模板文件不存在 → fail-open", () => {
    const fx = makeFixture(templates, { default: "ghost.md" });
    const res = run({ body: "随便", ...fx });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("fail-open");
  });
});

describe("正文层级兼容：H2 与 H3 两种写法都认", () => {
  it("必需段写成 H2（flat 习惯）→ 放行", () => {
    const fx = makeFixture({ "flat.md": TPL_FLAT }, { default: "flat.md" });
    expect(run({ body: BODY_FLAT_OK, ...fx }).status).toBe(0);
  });

  it("同样的段写成 H3 + 一个 H2 包裹（#72/#36 习惯）→ 放行", () => {
    const fx = makeFixture({ "flat.md": TPL_FLAT }, { default: "flat.md" });
    const body = [
      "## 随便一个包裹标题",
      "### 一句话结论",
      "落地闸口。",
      "### 改了什么",
      "- 从模板派生",
      "### 需要人工测试的地方",
      "#### 作者已实测",
      "- [x] 场景：夹具；期望：exit 0；实测：通过",
      "#### 合并后需要人工点",
      "- 无（不改运行时接口）",
    ].join("\n");
    expect(run({ body, ...fx }).status).toBe(0);
  });

  it("必需段写成 H4 → 不认，拦下", () => {
    const fx = makeFixture({ "flat.md": TPL_FLAT }, { default: "flat.md" });
    const body = BODY_FLAT_OK.replace(/^## /gm, "#### ").replace(
      /^### /gm,
      "#### ",
    );
    const res = run({ body, ...fx });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("一句话结论");
  });

  it("子段只要比父段深一级即可（父 H3 → 子 H4）", () => {
    const fx = makeFixture({ "flat.md": TPL_FLAT }, { default: "flat.md" });
    const body = [
      "## 包裹",
      "### 一句话结论",
      "内容",
      "### 改了什么",
      "内容",
      "### 需要人工测试的地方",
      "#### 作者已实测",
      "- [x] 已实测，期望与结果都写了",
      "#### 合并后需要人工点",
      "- 无（理由）",
    ].join("\n");
    expect(run({ body, ...fx }).status).toBe(0);
  });
});

describe("既有能力回归（#75 已验证的性质不能丢）", () => {
  const fx = () => makeFixture({ "flat.md": TPL_FLAT }, { default: "flat.md" });

  it("只剩 > 提示行与 HTML 注释等于空段 → 拦下", () => {
    const body = BODY_FLAT_OK.replace(
      /## 改了什么[\s\S]*?(?=## )/,
      "## 改了什么\n<!-- 注释 -->\n> 提示行\n",
    );
    const res = run({ body, ...fx() });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("改了什么");
  });

  it("子段写「无」+ 理由算已填 → 放行", () => {
    expect(run({ body: BODY_FLAT_OK, ...fx() }).status).toBe(0);
  });

  it("段名尾括号后缀与 ** 修饰都能识别", () => {
    const body = BODY_FLAT_OK.replace(
      "## 改了什么",
      "## **改了什么**（按模块分组）",
    );
    expect(run({ body, ...fx() }).status).toBe(0);
  });

  it("正文代码围栏内的 ## 不算真段落", () => {
    const body = "散文一段。\n```markdown\n" + BODY_FLAT_OK + "\n```\n";
    const res = run({ body, ...fx() });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("一句话结论");
  });

  it("CRLF 换行同样识别", () => {
    const body = BODY_FLAT_OK.replace(/\n/g, "\r\n");
    expect(run({ body, ...fx() }).status).toBe(0);
  });
});

describe("fail-open：闸口自己出问题绝不卡住 PR", () => {
  const fx = () => makeFixture({ "flat.md": TPL_FLAT }, { default: "flat.md" });

  it("PR_BODY 未注入 → 放过并说明原因", () => {
    const res = run({ ...fx() });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("fail-open");
  });

  it("PR_BODY 为空串是明确缺段 → 拦下", () => {
    const res = run({ body: "   \n  ", ...fx() });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("一句话结论");
  });

  it("PR_BODY_FILE 与 PR_BODY 等价", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-hygiene-body-"));
    tempDirs.push(dir);
    const file = join(dir, "body.md");
    writeFileSync(file, BODY_FLAT_OK, "utf8");
    expect(run({ bodyFile: file, ...fx() }).status).toBe(0);
  });

  it("PR_BODY_FILE 指向不存在的文件 → fail-open，不抛栈", () => {
    const res = run({
      bodyFile: join(tmpdir(), "definitely-missing.md"),
      ...fx(),
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("fail-open");
    expect(res.stderr).not.toContain("Error:");
  });

  it("畸形输入（未闭合围栏 + 只有 H1）不崩，退出码只允许 0 或 1", () => {
    const res = run({ body: "# 标题\n```markdown\n## 一句话结论\n", ...fx() });
    expect([0, 1]).toContain(res.status);
  });
});

describe("仓库真模板自校验（三仓共享同一份脚本，模板是唯一事实来源）", () => {
  const real = { templateDir: REAL_TEMPLATE_DIR, config: REAL_CONFIG };

  it("feature 模板原样交回必被判空", () => {
    const res = run({
      body: stripFrontMatter(
        readFileSync(join(REAL_TEMPLATE_DIR, "feature-to-staging.md"), "utf8"),
      ),
      base: "staging",
      ...real,
    });
    expect(res.status).toBe(1);
    // 原样交回时七段都「在但为空」，所以计的是缺段 + 空段之和，不是只数缺段
    expect(missingOrEmptyCount(res.stdout)).toBeGreaterThanOrEqual(6);
  });

  it("release 模板原样交回必被判空", () => {
    const res = run({
      body: stripFrontMatter(
        readFileSync(join(REAL_TEMPLATE_DIR, "release-to-main.md"), "utf8"),
      ),
      base: "main",
      ...real,
    });
    expect(res.status).toBe(1);
    expect(missingOrEmptyCount(res.stdout)).toBeGreaterThanOrEqual(5);
  });

  it("空正文时 feature 段表至少点名 7 段（防模板被清空导致闸口空转）", () => {
    const res = run({ body: "", base: "staging", ...real });
    expect(res.status).toBe(1);
    expect(missingCount(res.stdout)).toBeGreaterThanOrEqual(7);
  });

  it("release 段表含六项契约段（含 #75 补的回滚与人工验证清单）", () => {
    const res = run({ body: "", base: "main", ...real });
    for (const name of [
      "本次带入",
      "prod 实际影响面",
      "验证",
      "上线后人工验证清单",
      "回滚",
    ]) {
      expect(res.stdout).toContain(name);
    }
  });

  it("feature 模板派生出三个人工测试子段", () => {
    const body = stripFrontMatter(
      readFileSync(join(REAL_TEMPLATE_DIR, "feature-to-staging.md"), "utf8"),
    )
      .split("\n")
      .filter((line) => !/^#{2,3} /.test(line))
      .join("\n");
    const filled =
      body +
      [
        "## 一句话结论",
        "内容",
        "## 改了什么",
        "内容",
        "## 风险披露",
        "内容",
        "## 自动化验证",
        "内容",
        "## 需要人工测试的地方",
        "内容",
        "## 本 PR 没有交付的",
        "内容",
        "## 文件清单（3）",
        "内容",
      ].join("\n");
    const res = run({ body: filled, base: "staging", ...real });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("作者已实测");
    expect(res.stdout).toContain("合并到 staging 后需要人工点");
    expect(res.stdout).toContain("上线 prod 后需要人工点");
  });
});

function stripFrontMatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

function missingCount(stdout: string): number {
  const line = stdout.split("\n").find((l) => l.includes("缺少必需段落"));
  return line ? line.split("：")[1].split("、").filter(Boolean).length : 0;
}

function missingOrEmptyCount(stdout: string): number {
  return stdout
    .split("\n")
    .filter((l) => l.startsWith("✗"))
    .reduce(
      (sum, l) =>
        sum + (l.split("：")[1]?.split("、").filter(Boolean).length ?? 0),
      0,
    );
}
