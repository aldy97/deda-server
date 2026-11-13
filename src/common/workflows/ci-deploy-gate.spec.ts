import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { load } from "js-yaml";

type Step = { run?: string; uses?: string };
type Job = {
  needs?: string | string[];
  if?: string;
  uses?: string;
  steps?: Step[];
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

function isGatedByCi(job: Job): boolean {
  const condition = job.if ?? "";
  return (
    needsOf(job).includes("ci") &&
    /event_name\s*==\s*'push'/.test(condition) &&
    /refs\/heads\/staging/.test(condition)
  );
}

function deployJobs(wf: Workflow): Array<[string, Job]> {
  return Object.entries(wf.jobs ?? {}).filter(([, job]) => isDeployJob(job));
}

describe("staging 部署闸门", () => {
  it("push 到 staging 只允许由 ci.yml 自动触发", () => {
    const autoTriggered = [...workflows.entries()]
      .filter(([, wf]) => pushBranches(wf).includes("staging"))
      .map(([file]) => file);
    expect(autoTriggered).toEqual(["ci.yml"]);
  });

  it("ci.yml 的部署 job 必须 needs ci 且限定 push+staging", () => {
    const ci = workflows.get("ci.yml");
    expect(ci).toBeDefined();
    expect(ci?.jobs?.ci).toBeDefined();
    const gated = deployJobs(ci as Workflow).filter(([, job]) =>
      isGatedByCi(job),
    );
    expect(gated.length).toBeGreaterThanOrEqual(1);
  });

  it("deploy-staging.yml 仅保留手动/可复用触发，且仍是部署步骤的唯一来源", () => {
    const wf = workflows.get("deploy-staging.yml");
    expect(wf).toBeDefined();
    const triggers = triggerKeys(wf as Workflow);
    expect(
      triggers.every((t) => ["workflow_dispatch", "workflow_call"].includes(t)),
    ).toBe(true);
    expect(deployJobs(wf as Workflow).length).toBeGreaterThanOrEqual(1);
  });

  it("deploy-prod.yml 的自动触发仍只面向 main", () => {
    const wf = workflows.get("deploy-prod.yml");
    expect(pushBranches(wf as Workflow)).toEqual(["main"]);
  });
});
