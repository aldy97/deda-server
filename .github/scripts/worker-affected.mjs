#!/usr/bin/env node
/**
 * 判定一次 diff 是否触及 video worker 的运行面（决定 staging 是否重建 worker 镜像）。
 *
 * 输入：stdin 逐行喂 `git diff --name-only` 的结果。
 * 输出：`rebuild=true` / `rebuild=false`，可直接追加进 $GITHUB_OUTPUT。
 * 环境：
 *   WORKER_FORCE=true        无视 diff 强制重建（workflow_dispatch 默认开启）
 *   WORKER_TRIGGER_CONFIG    清单路径，默认仓库根 .github/worker-trigger-paths.json
 *
 * 任何读取/解析失败都 fail-safe 到 rebuild=true：漏建 worker 意味着线上跑旧代码，
 * 代价远高于多建一次。配置与清单的完整性由 worker-trigger-gate.spec.ts 兜住。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_PATH =
  process.env.WORKER_TRIGGER_CONFIG ||
  join(REPO_ROOT, ".github/worker-trigger-paths.json");

function emit(rebuild) {
  process.stdout.write(`rebuild=${rebuild}\n`);
  process.exit(0);
}

function failSafe(reason) {
  process.stderr.write(`worker-affected fail-safe：${reason}，按需要重建处理\n`);
  emit(true);
}

if (process.env.WORKER_FORCE === "true") {
  process.stderr.write("worker-affected：WORKER_FORCE=true，强制重建\n");
  emit(true);
}

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (error) {
  failSafe(
    `读取 ${CONFIG_PATH} 失败（${error instanceof Error ? error.message : String(error)}）`,
  );
}

if (!Array.isArray(config?.prefixes) || !Array.isArray(config?.exact)) {
  failSafe(`${CONFIG_PATH} 缺少 prefixes/exact 数组`);
}

let input;
try {
  input = readFileSync(0, "utf8");
} catch (error) {
  failSafe(
    `读取 stdin 失败（${error instanceof Error ? error.message : String(error)}）`,
  );
}

const changedFiles = input
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const affected = changedFiles.some(
  (file) =>
    config.exact.includes(file) ||
    config.prefixes.some((prefix) => file.startsWith(prefix)),
);

emit(affected);
