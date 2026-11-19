import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const SCRIPT = join(REPO_ROOT, ".github/scripts/pr-hygiene.mjs");

type RunResult = { status: number | null; stdout: string; stderr: string };

/**
 * 黑盒调用校验脚本：body 与 base 只经 env 传入（与 ci.yml 的接线方式一致），
 * 不走 argv，避免正文里的引号与换行在 shell 层被二次解析。
 */
function run(options: { body?: string; bodyFile?: string; base?: string }) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PR_BODY;
  delete env.PR_BODY_FILE;
  if (options.body !== undefined) env.PR_BODY = options.body;
  if (options.bodyFile !== undefined) env.PR_BODY_FILE = options.bodyFile;
  env.PR_BASE = options.base ?? "staging";

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

const FEATURE_OK = [
  "## 一句话结论",
  "给 PR 正文加结构闸口，缺段即红。",
  "",
  "## 改了什么",
  "- ci.yml：新增 pr-hygiene job，只在 pull_request 事件跑",
  "- .github/scripts：新增零依赖校验脚本",
  "",
  "## 风险披露",
  "- 破坏性变更：无（新增 job 不触碰部署路径）",
  "- 数据库迁移：无",
  "- 跨仓依赖：无",
  "",
  "## 自动化验证",
  "| 命令 | 结果 |",
  "| --- | --- |",
  "| npm run test | 1883 passed |",
  "",
  "## 需要人工测试的地方",
  "### 作者已实测（合并前）",
  "- [x] 场景：本地喂 #72 正文；步骤：node 脚本；期望：识别已有段落；实测：通过",
  "### 合并到 staging 后需要人工点",
  "- 无（不改运行时接口，staging 无新行为可点）",
  "### 上线 prod 后需要人工点（批准 production 之后）",
  "- 无（不涉及 prod 行为变化）",
  "",
  "## 本 PR 没有交付的",
  "- 日报单列「等你点的人工验证」属第二期，未做",
  "",
  "## 文件清单（7）",
  "- .github/scripts/pr-hygiene.mjs",
].join("\n");

const RELEASE_OK = [
  "## 本次带入",
  "| feature PR | 人工验证项数 |",
  "| --- | --- |",
  "| #71 | 3 |",
  "",
  "## prod 实际影响面",
  "- 路由：新增 /client/bot/getvalue；迁移：无；env：无新增",
  "",
  "## 验证",
  "- staging CI run 全绿，实机冒烟 15/15",
  "",
  "## 上线后人工验证清单",
  "- 合并本 PR 不自动上线，需先在 Actions 批准 production",
  "- 命令：curl -s https://api.example/health；期望：200",
  "",
  "## 回滚",
  "- 触发条件：health 连续 3 次非 200；步骤：Actions 重跑上一个 prod 部署",
  "",
  "## 已知待办（不阻塞发布）",
  "- 音色切换待机芯厂固件",
].join("\n");

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pr-hygiene-"));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("校验脚本本体", () => {
  it("脚本存在于 .github/scripts 下（ci.yml 直接 node 调用，不经 npm ci）", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });
});

describe("feature → staging 段表", () => {
  it("七段齐备且人工测试三子段有实质内容时放行", () => {
    const res = run({ body: FEATURE_OK });
    expect(res.status).toBe(0);
  });

  it("缺 H2 段时退出 1 并点名缺失段", () => {
    const body = FEATURE_OK.replace(
      /## 风险披露[\s\S]*?(?=\n## )/,
      "## 改了什么之外的内容\n",
    );
    const res = run({ body });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("风险披露");
  });

  it("段名尾括号里的变量后缀不影响识别（文件清单（N））", () => {
    const res = run({
      body: FEATURE_OK.replace("文件清单（7）", "文件清单（12）"),
    });
    expect(res.status).toBe(0);
  });

  it("只剩 > 提示行与 HTML 注释等于空段，拦下", () => {
    const body = FEATURE_OK.replace(
      /## 需要人工测试的地方[\s\S]*?(?=\n## 本 PR)/,
      [
        "## 需要人工测试的地方",
        "<!-- 三段都要写，确实没有就写「无」+ 理由 -->",
        "> 作者已实测 / 合并到 staging 后 / 上线 prod 后，每项都要带期望结果",
        "",
      ].join("\n"),
    );
    const res = run({ body });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("需要人工测试的地方");
  });

  it("子段写「无」+ 理由算已填，放行", () => {
    expect(FEATURE_OK).toContain("无（不改运行时接口");
    expect(run({ body: FEATURE_OK }).status).toBe(0);
  });

  it("缺人工测试子段时点名子段", () => {
    const body = FEATURE_OK.replace(
      /### 上线 prod 后需要人工点[\s\S]*?(?=\n## 本 PR)/,
      "",
    );
    const res = run({ body });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("上线 prod 后需要人工点");
  });

  it("段落降级成 H3 不算 H2 段", () => {
    const res = run({ body: FEATURE_OK.replace(/^## /gm, "### ") });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("一句话结论");
  });

  it("代码围栏内的 ## 不被当成真段落", () => {
    const body = [
      "正文只有一段散文，段落全在围栏里：",
      "",
      "```markdown",
      FEATURE_OK,
      "```",
    ].join("\n");
    const res = run({ body });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("一句话结论");
  });

  it("CRLF 换行同样识别", () => {
    const res = run({ body: FEATURE_OK.replace(/\n/g, "\r\n") });
    expect(res.status).toBe(0);
  });
});

describe("release → main 段表", () => {
  it("base=main 时用 release 六段，齐备放行", () => {
    const res = run({ body: RELEASE_OK, base: "main" });
    expect(res.status).toBe(0);
  });

  it("base=main 缺回滚段时点名", () => {
    const body = RELEASE_OK.replace(/## 回滚[\s\S]*?(?=\n## 已知待办)/, "");
    const res = run({ body, base: "main" });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("回滚");
  });

  it("base=main 时 feature 段名不能满足 release 段表", () => {
    const res = run({ body: FEATURE_OK, base: "main" });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("本次带入");
  });

  it("base 非 main（含堆叠分支）一律按 feature 段表", () => {
    const res = run({ body: FEATURE_OK, base: "feat/some-stack" });
    expect(res.status).toBe(0);
  });
});

describe("fail-open：闸口自己出问题绝不卡住 PR", () => {
  it("PR_BODY 未注入时放过并说明原因", () => {
    const res = run({ base: "staging" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("fail-open");
  });

  it("PR_BODY 为空串是明确缺段，拦下", () => {
    const res = run({ body: "   \n  " });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain("一句话结论");
  });

  it("PR_BODY_FILE 与 PR_BODY 等价", () => {
    const file = join(tempDir, "body.md");
    writeFileSync(file, FEATURE_OK, "utf8");
    const res = run({ bodyFile: file });
    expect(res.status).toBe(0);
  });

  it("PR_BODY_FILE 指向不存在的文件时 fail-open，不抛栈", () => {
    const res = run({ bodyFile: join(tempDir, "missing.md") });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("fail-open");
    expect(res.stderr).not.toContain("Error:");
  });

  it("畸形输入（未闭合围栏 + 只有 H1）不崩，退出码只允许 0 或 1", () => {
    const res = run({ body: "# 标题\n```markdown\n## 一句话结论\n" });
    expect([0, 1]).toContain(res.status);
    expect(res.status).not.toBeNull();
  });
});
