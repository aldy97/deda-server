import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { load } from "js-yaml";
import * as ts from "typescript";

const REPO_ROOT = resolve(__dirname, "../../..");
const SCRIPT = join(REPO_ROOT, ".github/scripts/worker-affected.mjs");
const CONFIG = join(REPO_ROOT, ".github/worker-trigger-paths.json");
const WORKFLOW = join(REPO_ROOT, ".github/workflows/deploy-staging.yml");

type TriggerConfig = { prefixes: string[]; exact: string[] };
type Step = {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = { "timeout-minutes"?: number; steps?: Step[] };
type Workflow = {
  on?: Record<string, { inputs?: Record<string, { default?: unknown }> }>;
  jobs?: Record<string, Job>;
};

function readConfig(): TriggerConfig {
  return JSON.parse(readFileSync(CONFIG, "utf8")) as TriggerConfig;
}

function matches(config: TriggerConfig, file: string): boolean {
  return (
    config.exact.includes(file) ||
    config.prefixes.some((prefix) => file.startsWith(prefix))
  );
}

function runScript(input: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    input,
    encoding: "utf8",
    env: { ...process.env, WORKER_TRIGGER_CONFIG: CONFIG, ...env },
  });
}

function rebuildOf(result: ReturnType<typeof runScript>): string {
  return result.stdout.trim();
}

function workflow(): Workflow {
  return load(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

function steps(): Step[] {
  return workflow().jobs?.deploy?.steps ?? [];
}

function stepByName(name: string): Step {
  const found = steps().find((step) => step.name === name);
  if (!found) throw new Error(`deploy-staging.yml 缺少步骤：${name}`);
  return found;
}

const REBUILD_GATE = "steps.detect.outputs.rebuild == 'true'";

describe("worker 变更判定脚本", () => {
  it.each([
    "src/video-worker/video-worker.runner.ts",
    "src/modules/adventure-video/worker/ffmpeg.args.ts",
    "src/modules/prompt-registry/prompt-registry.service.ts",
    "src/modules/adventure-admin/guards/content-admin.guard.ts",
    "src/modules/adventure-admin/adventure-content.service.ts",
    "src/modules/analytics/guards/super-admin.guard.ts",
    "src/modules/llm/llm.service.ts",
    "src/common/prisma/prisma.service.ts",
    "src/config/video.config.ts",
    "src/prisma/schema.prisma",
    "src/prisma/migrations/20261128120000_adventure_video/migration.sql",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "nest-cli.json",
    "docker/Dockerfile.worker",
    ".dockerignore",
  ])("命中 worker 运行面：%s", (file) => {
    expect(rebuildOf(runScript(`${file}\n`))).toBe("rebuild=true");
  });

  it.each([
    "src/common/mqtt/mqtt.service.ts",
    "src/modules/device-configs/device-configs.service.ts",
    "src/modules/analytics/voice-speed-broadcast.service.ts",
    "src/modules/devices/devices.controller.ts",
    "src/main.ts",
    "src/app.module.ts",
    "docs/adventure-video.md",
    ".github/workflows/deploy-staging.yml",
  ])("不命中 worker 运行面：%s", (file) => {
    expect(rebuildOf(runScript(`${file}\n`))).toBe("rebuild=false");
  });

  it("空 diff 不重建", () => {
    expect(rebuildOf(runScript(""))).toBe("rebuild=false");
  });

  it("WORKER_FORCE=true 时无视 diff 强制重建", () => {
    expect(
      rebuildOf(runScript("src/main.ts\n", { WORKER_FORCE: "true" })),
    ).toBe("rebuild=true");
  });

  it("配置缺失时 fail-safe 重建并说明原因", () => {
    const result = runScript("src/main.ts\n", {
      WORKER_TRIGGER_CONFIG: join(REPO_ROOT, ".github/missing-config.json"),
    });
    expect(result.status).toBe(0);
    expect(rebuildOf(result)).toBe("rebuild=true");
    expect(result.stderr).toContain("fail-safe");
  });
});

describe("deploy-staging.yml 接线", () => {
  it("保留唯一入口约定：workflow_call 默认不强制，workflow_dispatch 默认强制", () => {
    const on = workflow().on ?? {};
    expect(on.workflow_call?.inputs?.force_worker?.default).toBe(false);
    expect(on.workflow_dispatch?.inputs?.force_worker?.default).toBe(true);
  });

  it("checkout 拉全量历史，detect 步骤用 diff 驱动脚本", () => {
    const checkout = steps().find(
      (step) => step.uses === "actions/checkout@v4",
    );
    expect(checkout?.with?.["fetch-depth"]).toBe(0);

    const detect = steps().find((step) => step.id === "detect");
    expect(detect?.run).toContain("worker-affected.mjs");
    expect(detect?.run).toContain("fail-safe");
    expect(detect?.env?.FORCE_WORKER).toContain("inputs.force_worker");
    expect(detect?.run).toContain("git diff --name-only");
  });

  it("worker 镜像构建与传输都被 rebuild 输出门控，且镜像名与 compose 对齐", () => {
    const build = stepByName("Build worker image");
    expect(build.if).toBe(REBUILD_GATE);
    expect(build.run).toContain("docker/Dockerfile.worker");
    expect(build.run).toContain(
      "deda-server-video-worker:staging-${{ github.sha }}",
    );

    const transfer = stepByName("Transfer worker image");
    expect(transfer.if).toBe(REBUILD_GATE);
    expect(transfer.run).toContain("docker save");
    expect(transfer.run).toContain("timeout 600");
    expect(transfer.run).toContain("gunzip | docker load");
  });

  it("部署步骤仅在 rebuild 时加 --profile video", () => {
    const deploy = stepByName("Deploy on ECS");
    expect(deploy.run).toContain("--profile video");
    expect(deploy.run).toContain("steps.detect.outputs.rebuild");
  });

  it("worker 健康检查门控与启动日志口径一致", () => {
    const health = stepByName("Worker health check");
    expect(health.if).toBe(REBUILD_GATE);
    expect(health.run).toContain("worker 启动");
    expect(health.run).toContain("worker 不启动轮询");
    expect(health.run).toContain("docker inspect");
  });

  it("超时上界为 worker 构建/传输留出余量", () => {
    expect(workflow().jobs?.deploy?.["timeout-minutes"]).toBe(30);
  });
});

describe("worker 运行面闭包守卫", () => {
  function resolveImport(spec: string, fromFile: string): string | null {
    let base: string;
    if (spec.startsWith("@/")) base = join(REPO_ROOT, "src", spec.slice(2));
    else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
    else return null;
    for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const candidate = base + suffix;
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    }
    return null;
  }

  /** 与 worker 镜像实际加载面一致：type-only 导入在编译期被擦除，不计入。 */
  function workerClosure(): string[] {
    const seen = new Set<string>();
    const walk = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of source.statements) {
        if (
          !ts.isImportDeclaration(statement) &&
          !ts.isExportDeclaration(statement)
        ) {
          continue;
        }
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (clause?.isTypeOnly) continue;
          const bindings = clause?.namedBindings;
          if (
            bindings &&
            ts.isNamedImports(bindings) &&
            !clause?.name &&
            bindings.elements.every((element) => element.isTypeOnly)
          ) {
            continue;
          }
        } else if (statement.isTypeOnly) {
          continue;
        }
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier)) continue;
        const resolved = resolveImport(specifier.text, file);
        if (resolved) walk(resolved);
      }
    };
    walk(join(REPO_ROOT, "src/video-worker/main.ts"));
    return [...seen].map((file) => relative(REPO_ROOT, file)).sort();
  }

  it("闭包内每个文件都被触发清单覆盖（新增依赖必须同步清单）", () => {
    const config = readConfig();
    const closure = workerClosure();
    expect(closure.length).toBeGreaterThan(40);
    expect(closure.filter((file) => !matches(config, file))).toEqual([]);
  });

  it("纯 API 侧模块不在 worker 闭包里", () => {
    const closure = workerClosure();
    for (const excluded of [
      "src/common/mqtt/",
      "src/modules/device-configs/",
      "src/modules/client-api/",
      "src/modules/device-link/",
      "src/modules/devices/",
    ]) {
      expect(closure.some((file) => file.startsWith(excluded))).toBe(false);
    }
  });
});
