import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { load } from "js-yaml";

type Step = { name?: string; run?: string; uses?: string };
type Concurrency = {
  group?: string;
  "cancel-in-progress"?: boolean;
};
type Job = {
  needs?: string | string[];
  if?: string;
  uses?: string;
  steps?: Step[];
  concurrency?: string | Concurrency;
  "timeout-minutes"?: number;
};
type Workflow = {
  on?: Record<string, unknown> | string;
  jobs?: Record<string, Job>;
};

const WORKFLOWS_DIR = resolve(__dirname, "../../../.github/workflows");
const DEPLOY_MARKERS = ["ECS_SSH_KEY", "docker compose", "scp "];

const workflows = new Map<string, Workflow>(
  readdirSync(WORKFLOWS_DIR)
    .filter((file) => file.endsWith(".yml"))
    .map((file) => [
      file,
      load(readFileSync(join(WORKFLOWS_DIR, file), "utf8")) as Workflow,
    ]),
);

function triggerKeys(wf: Workflow): string[] {
  const on = wf.on;
  if (!on) return [];
  if (typeof on === "string") return [on];
  return Object.keys(on);
}

function pushBranches(wf: Workflow): string[] {
  const on = wf.on;
  if (typeof on !== "object" || on === null) return [];
  const push = (on as Record<string, { branches?: string | string[] }>).push;
  if (!push?.branches) return [];
  return Array.isArray(push.branches) ? push.branches : [push.branches];
}

function deploys(job: Job): boolean {
  const steps = job.steps ?? [];
  return steps.some((step) => {
    const text = `${step.run ?? ""} ${step.uses ?? ""}`;
    return DEPLOY_MARKERS.some((marker) => text.includes(marker));
  });
}

function isDeployJob(job: Job): boolean {
  return deploys(job) || (job.uses ?? "").includes("deploy-");
}

function needsOf(job: Job): string[] {
  if (!job.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

/**
 * 部署 job 是否被 ci 闸口管住：必须 needs ci，且 if 同时限定 push 事件与目标分支。
 * 缺任一条件，部署就可能在 ci 未全绿（甚至 PR 阶段）时跑起来。
 */
function isGatedByCi(job: Job, branch: string): boolean {
  const condition = job.if ?? "";
  return (
    needsOf(job).includes("ci") &&
    /event_name\s*==\s*'push'/.test(condition) &&
    condition.includes(`refs/heads/${branch}`)
  );
}

/** 只允许手动触发或被别的 workflow 调用；带 push 触发即等于绕过 ci 闸口。 */
function isCallOnly(wf: Workflow): boolean {
  return triggerKeys(wf).every((trigger) =>
    ["workflow_dispatch", "workflow_call"].includes(trigger),
  );
}

function deployJobs(wf: Workflow): Array<[string, Job]> {
  return Object.entries(wf.jobs ?? {}).filter(([, job]) => isDeployJob(job));
}

function concurrencyOf(job: Job): Concurrency | undefined {
  return typeof job.concurrency === "string"
    ? { group: job.concurrency }
    : job.concurrency;
}

describe("staging 部署闸门", () => {
  it("push 到 staging 只允许由 ci.yml 自动触发", () => {
    const autoTriggered = [...workflows.entries()]
      .filter(([, wf]) => pushBranches(wf).includes("staging"))
      .map(([file]) => file);
    expect(autoTriggered).toEqual(["ci.yml"]);
  });

  it("ci.yml 的 staging 部署 job 必须 needs ci 且限定 push+staging", () => {
    const ci = workflows.get("ci.yml");
    expect(ci).toBeDefined();
    expect(ci?.jobs?.ci).toBeDefined();
    const gated = deployJobs(ci as Workflow).filter(([, job]) =>
      isGatedByCi(job, "staging"),
    );
    expect(gated.length).toBe(1);
    expect(gated[0][1].uses).toContain("deploy-staging.yml");
  });

  it("deploy-staging.yml 仅保留手动/可复用触发，且仍是部署步骤的唯一来源", () => {
    const wf = workflows.get("deploy-staging.yml");
    expect(wf).toBeDefined();
    expect(isCallOnly(wf as Workflow)).toBe(true);
    expect(deployJobs(wf as Workflow).length).toBeGreaterThanOrEqual(1);
  });
});

describe("prod 部署闸门", () => {
  it("push 到 main 只允许由 ci.yml 自动触发", () => {
    const autoTriggered = [...workflows.entries()]
      .filter(([, wf]) => pushBranches(wf).includes("main"))
      .map(([file]) => file);
    expect(autoTriggered).toEqual(["ci.yml"]);
  });

  it("ci.yml 的 prod 部署 job 必须 needs ci 且限定 push+main", () => {
    const ci = workflows.get("ci.yml");
    expect(ci).toBeDefined();
    const gated = deployJobs(ci as Workflow).filter(([, job]) =>
      isGatedByCi(job, "main"),
    );
    expect(gated.length).toBe(1);
    expect(gated[0][1].uses).toContain("deploy-prod.yml");
  });

  it("deploy-prod.yml 不得自带 push 触发，只能手动或被 ci.yml 调用", () => {
    const wf = workflows.get("deploy-prod.yml");
    expect(wf).toBeDefined();
    expect(pushBranches(wf as Workflow)).toEqual([]);
    expect(isCallOnly(wf as Workflow)).toBe(true);
    expect(deployJobs(wf as Workflow).length).toBeGreaterThanOrEqual(1);
  });
});

describe("部署 job 的并发策略", () => {
  const ci = workflows.get("ci.yml") as Workflow;
  const jobs = deployJobs(ci);

  it("staging 与 prod 各有一个部署 job", () => {
    expect(jobs.length).toBe(2);
  });

  it("两个环境各自成组，不共用 concurrency group", () => {
    const groups = jobs.map(([, job]) => concurrencyOf(job)?.group);
    expect(groups.every((group) => typeof group === "string" && group !== ""));
    expect(new Set(groups).size).toBe(2);
  });

  it("进行中的部署绝不被取消：取消等于把服务器留在半部署状态", () => {
    for (const [, job] of jobs) {
      expect(concurrencyOf(job)?.["cancel-in-progress"]).toBe(false);
    }
  });
});

/**
 * 2026-11-19 事故口径：staging 部署的「Transfer image to ECS」步骤僵死 1h21m，
 * `concurrency: {group: deploy-staging, cancel-in-progress: false}` 被它占住，
 * 后续两次合并的部署全部堵在队列里；runner 侧取消之后 ECS 上仍留下
 * `gunzip | docker load` 孤儿进程（CPU 时间 0，永不退出）。
 *
 * 因此超时必须三层都有界，缺一层就还会重演：
 * job 级 `timeout-minutes`（兜住所有步骤，含其余 ssh/scp）、
 * 本地管道 `timeout 600`（兜住传输本身）、
 * 远端命令自带 `timeout`（兜住 runner 先死时的 ECS 孤儿进程）。
 */
describe("部署 job 的超时与传输加固", () => {
  const REUSABLE_DEPLOY_FILES = ["deploy-staging.yml", "deploy-prod.yml"];
  const TRANSFER_STEP = "Transfer image to ECS";

  function reusableDeployJob(file: string): Job | undefined {
    return workflows.get(file)?.jobs?.deploy;
  }

  function transferRun(file: string): string {
    const step = (reusableDeployJob(file)?.steps ?? []).find(
      (candidate) => candidate.name === TRANSFER_STEP,
    );
    return step?.run ?? "";
  }

  it("两个可复用部署 workflow 的 deploy job 都必须设 timeout-minutes，且在 (0, 30] 内", () => {
    for (const file of REUSABLE_DEPLOY_FILES) {
      const timeout = reusableDeployJob(file)?.["timeout-minutes"];
      expect(typeof timeout).toBe("number");
      expect(timeout as number).toBeGreaterThan(0);
      expect(timeout as number).toBeLessThanOrEqual(30);
    }
  });

  it("ci.yml 的 uses 型调用 job 禁止出现 timeout-minutes：GitHub 不接受，会让整个 workflow 非法", () => {
    // 实测（2026-11-19，run 44471518994）：给 uses 型调用 job 加 timeout-minutes 后，
    // GitHub 直接判 workflow 文件非法——run 0 秒失败、一个 job 都没起来，
    // 反而把 deploy 全堵死，比不加更糟。
    // 上界只能由被调用方内层承担；保护链依然成立：内层 job 超时 → 可复用 workflow 结束
    // → 调用 job 结束 → concurrency group 释放。
    const ci = workflows.get("ci.yml") as Workflow;
    const callers = deployJobs(ci);
    expect(callers.length).toBe(2);
    for (const [, job] of callers) {
      const callee = (job.uses ?? "").replace("./.github/workflows/", "");
      expect(REUSABLE_DEPLOY_FILES).toContain(callee);
      expect(typeof reusableDeployJob(callee)?.["timeout-minutes"]).toBe(
        "number",
      );
      expect("timeout-minutes" in job).toBe(false);
    }
  });

  it("镜像传输的本地管道必须套 timeout 600，并开启 SSH 保活与建连超时", () => {
    for (const file of REUSABLE_DEPLOY_FILES) {
      const run = transferRun(file);
      expect(run).toMatch(/timeout\s+600\s+ssh\b/);
      expect(run).toMatch(/ServerAliveInterval=15/);
      expect(run).toMatch(/ServerAliveCountMax=\d+/);
      expect(run).toMatch(/ConnectTimeout=\d+/);
    }
  });

  it("远端 docker load 必须自带 timeout：runner 先死也不许在 ECS 留僵死进程", () => {
    for (const file of REUSABLE_DEPLOY_FILES) {
      expect(transferRun(file)).toMatch(
        /timeout\s+600\s+sh -c\s+'gunzip \| docker load'/,
      );
    }
  });

  it("传输步骤仍必须保留 docker save | gzip | ssh 直传形态（不得改成经镜像仓库）", () => {
    for (const file of REUSABLE_DEPLOY_FILES) {
      const run = transferRun(file);
      expect(run).toMatch(/docker save\b/);
      expect(run).toMatch(/\|\s*gzip\s*\|/);
      expect(run).toMatch(/gunzip \| docker load/);
    }
  });
});
