import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const HUSKY_DIR = join(REPO_ROOT, ".husky");
const HOOK_NAMES = ["post-merge", "post-checkout"];
const LIB_RELATIVE = "lib/prisma-generate-if-stale.sh";
const LIB_PATH = join(HUSKY_DIR, LIB_RELATIVE);
const SCHEMA_RELATIVE = "src/prisma/schema.prisma";
const CLIENT_RELATIVE = "node_modules/.prisma/client/index.d.ts";
const HOOK_FILES = [
  ...HOOK_NAMES.map((name) => join(HUSKY_DIR, name)),
  LIB_PATH,
];

/** 钩子里一旦出现这些，就意味着它开始写库或改依赖——两者都必须人工来做。 */
const FORBIDDEN = [
  "prisma migrate",
  "migrate deploy",
  "migrate dev",
  "migrate reset",
  "db push",
  "npm install",
  "npm ci",
];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function isExecutable(path: string): boolean {
  return (statSync(path).mode & 0o111) !== 0;
}

type Sandbox = { dir: string; marker: string };
const sandboxes: Sandbox[] = [];

/**
 * 造一个假的工作树：schema + node_modules + 一个 stub prisma（被调用就留痕并
 * 伪造出「已生成 client」）。mtime 用 ±60s 显式拉开，避免同秒比较导致偶发。
 */
function createSandbox(options: {
  withDependencies: boolean;
  clientAge?: "missing" | "newer" | "older" | "equal";
}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "husky-prisma-"));
  const marker = join(dir, "generate-ran.txt");
  const sandbox: Sandbox = { dir, marker };
  sandboxes.push(sandbox);

  mkdirSync(join(dir, "src/prisma"), { recursive: true });
  writeFileSync(join(dir, SCHEMA_RELATIVE), "datasource db {}\n");

  if (options.withDependencies) {
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    mkdirSync(join(dir, "node_modules/prisma"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules/.bin/prisma"),
      [
        "#!/bin/sh",
        `echo "$@" > "${marker}"`,
        `mkdir -p "${dir}/node_modules/.prisma/client"`,
        `touch "${dir}/${CLIENT_RELATIVE}"`,
      ].join("\n"),
    );
    chmodSync(join(dir, "node_modules/.bin/prisma"), 0o755);
  }

  // 以 schema 的时间为基准拉开 client 的时间，避免依赖真实时钟的先后
  const schemaTime = new Date();
  const clientAge = options.clientAge ?? "missing";
  if (options.withDependencies && clientAge !== "missing") {
    const clientPath = join(dir, CLIENT_RELATIVE);
    mkdirSync(join(dir, "node_modules/.prisma/client"), { recursive: true });
    writeFileSync(clientPath, "// generated\n");
    const offsetSeconds =
      clientAge === "newer" ? 60 : clientAge === "older" ? -60 : 0;
    const clientTime = new Date(schemaTime.getTime() + offsetSeconds * 1000);
    utimesSync(clientPath, clientTime, clientTime);
  }

  utimesSync(join(dir, SCHEMA_RELATIVE), schemaTime, schemaTime);
  return sandbox;
}

function runHook(hook: string, args: string[], cwd: string) {
  return spawnSync("sh", [join(HUSKY_DIR, hook), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
}

/** post-checkout 的三个参数：旧 HEAD、新 HEAD、1=分支切换 / 0=文件检出 */
const BRANCH_CHECKOUT = ["0".repeat(40), "a".repeat(40), "1"];
const FILE_CHECKOUT = ["0".repeat(40), "a".repeat(40), "0"];

afterAll(() => {
  for (const { dir } of sandboxes) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("钩子文件结构", () => {
  it("共享脚本与两个钩子都存在且可执行", () => {
    const missing = HOOK_FILES.filter((path) => !existsSync(path));
    expect(missing).toEqual([]);
    expect(HOOK_FILES.filter((path) => !isExecutable(path))).toEqual([]);
  });

  it("两个钩子都委托给共享脚本，不各自复制一份逻辑", () => {
    for (const name of HOOK_NAMES) {
      expect(read(join(HUSKY_DIR, name))).toContain(LIB_RELATIVE);
    }
  });

  it("post-checkout 只在分支切换时触发，文件级检出直接放过", () => {
    const hook = read(join(HUSKY_DIR, "post-checkout"));
    expect(hook).toMatch(/\$\{?3/);
    expect(hook).toContain('"1"');
  });

  it("钩子绝不写库、绝不装依赖", () => {
    const violations: string[] = [];
    for (const path of HOOK_FILES) {
      const body = read(path);
      for (const banned of FORBIDDEN) {
        if (body.includes(banned)) {
          violations.push(`${path} 含 ${banned}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("依赖未装时必须跳过，而不是报错", () => {
    expect(read(LIB_PATH)).toContain("node_modules/prisma");
  });

  it("generate 必须显式指定 schema 路径（本仓 schema 不在默认位置）", () => {
    const body = read(LIB_PATH);
    expect(body).toContain("prisma generate");
    expect(body).toContain("--schema=");
    expect(body).toContain(SCHEMA_RELATIVE);
  });

  it("package.json 仍靠 prepare 装 husky，否则钩子根本不生效", () => {
    const pkg = JSON.parse(read(join(REPO_ROOT, "package.json"))) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.prepare).toBe("husky");
  });
});

describe("钩子实际行为（沙箱里真跑）", () => {
  it("client 缺失时生成", () => {
    const { dir, marker } = createSandbox({
      withDependencies: true,
      clientAge: "missing",
    });
    const result = runHook("post-merge", [], dir);
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it("client 比 schema 新时不生成：切分支不该刷屏", () => {
    const { dir, marker } = createSandbox({
      withDependencies: true,
      clientAge: "newer",
    });
    const result = runHook("post-merge", [], dir);
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("schema 变新后重新生成", () => {
    const { dir, marker } = createSandbox({
      withDependencies: true,
      clientAge: "older",
    });
    const result = runHook("post-merge", [], dir);
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it("mtime 完全相等时选择重新生成：宁可多跑一次，不可留下陈旧 client", () => {
    // git 写 schema 与 generate 写 client 可能落在同一秒，而 -nt 在相等时为假。
    // 这里钉住「相等 → 重新生成」的方向：代价是一次多余生成，收益是绝不漏跑。
    const { dir, marker } = createSandbox({
      withDependencies: true,
      clientAge: "equal",
    });
    const result = runHook("post-merge", [], dir);
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it("依赖未装时静默退出 0（新 worktree / 刚 clone）", () => {
    const { dir, marker } = createSandbox({ withDependencies: false });
    const result = runHook("post-merge", [], dir);
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("post-checkout 只在第三参数为 1 时生成", () => {
    const fileLevel = createSandbox({
      withDependencies: true,
      clientAge: "missing",
    });
    expect(runHook("post-checkout", FILE_CHECKOUT, fileLevel.dir).status).toBe(
      0,
    );
    expect(existsSync(fileLevel.marker)).toBe(false);

    const branchLevel = createSandbox({
      withDependencies: true,
      clientAge: "missing",
    });
    expect(
      runHook("post-checkout", BRANCH_CHECKOUT, branchLevel.dir).status,
    ).toBe(0);
    expect(existsSync(branchLevel.marker)).toBe(true);
  });
});
