import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { load } from "js-yaml";

type Step = { run?: string; uses?: string };
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
