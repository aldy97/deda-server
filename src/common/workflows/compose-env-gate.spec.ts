import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { load } from "js-yaml";

const DOCKER_DIR = resolve(__dirname, "../../../docker");

type Limits = { cpus?: string; memory?: string };
type ComposeService = {
  environment?: Record<string, string>;
  deploy?: { resources?: { limits?: Limits } };
};
type Compose = { services?: Record<string, ComposeService> };

function readCompose(file: string): Compose {
  return load(readFileSync(resolve(DOCKER_DIR, file), "utf8")) as Compose;
}

const base = readCompose("docker-compose.yml");
const prod = readCompose("docker-compose.prod.yml");
const staging = readCompose("docker-compose.staging.yml");

const baseEnv = base.services?.app?.environment ?? {};
const prodEnv = prod.services?.app?.environment ?? {};
const stagingEnv = staging.services?.app?.environment ?? {};

/**
 * compose 的 environment 是白名单：--env-file 只做变量替换，不会把变量注入容器。
 * 代码读了但白名单里没有的键，等于在容器里永久失效——env 文件里写了也不生效，
 * 而且不报错。以下键都曾漏过，逐个钉住。
 */
const MUST_FORWARD = [
  "NODE_OPTIONS",
  "ANALYTICS_JWT_EXPIRES_IN",
  "LLM_ADAPTER_FILLER",
  "MQTT_STATUS_TTL_SECONDS",
  "PROMPT_PUBLISH_CONFIRM_CODE",
  "PROMPT_WRITE_ENABLED",
  "PUSH_NOTIFICATIONS_ENABLED",
  "SAFETY_GATE_ADVENTURE",
  "WECHAT_TMPL_SLEEP_REMINDER",
  "ADVENTURE_BREAKER_THRESHOLD",
  "ADVENTURE_BREAKER_TRIPPED_TTL_SECONDS",
  "ADVENTURE_BREAKER_WINDOW_MS",
  "ADVENTURE_LINT_FORBIDDEN_WORDS",
  "ADVENTURE_LINT_MAX_INTERACTION_CHARS",
  "ADVENTURE_LINT_MAX_NARRATION_CHARS",
  "ADVENTURE_LINT_MAX_STARS_PER_EPISODE",
  "ADVENTURE_LINT_MAX_TITLE_CHARS",
  "ADVENTURE_LINT_MIN_CHOICE_TEXT_CHARS",
  "ADVENTURE_RECOVERY_ENABLED",
  "ADVENTURE_RECOVERY_STALE_AWAIT_ACTION",
  "ADVENTURE_RECOVERY_STALE_AWAIT_MS",
  "ADVENTURE_RECOVERY_SWEEP_INTERVAL_MS",
  "ADVENTURE_SIM_MAX_AWAIT_POINTS",
  "ADVENTURE_SIM_MAX_SESSION_SECONDS",
  // 百度智能体与设备端 TTS（v1.4 getvalue 的取值来源）。这组键只写在 env 文件里
  // 不会进容器：TTS_DEFAULT_VOL 缺失会让 getvalue 500（vcn 自 2026-11-21 起改读
  // character_timbre 表，CHARACTER_TIMBRE_JSON 仅为旧镜像回滚保留白名单）。
  "BAIDU_AGENT_ENABLED",
  "BAIDU_AGENT_TIMEOUT_MS",
  "CHARACTER_TIMBRE_JSON",
  "TTS_DEFAULT_VOL",
  "VOICE_CATALOG_JSON",
];

/**
 * 代码读过、但刻意不进 base compose 的键。每一项都必须有理由，
 * 否则「代码读了但容器里永远 undefined」会再次静默发生。
 */
const INTENTIONALLY_NOT_FORWARDED = new Set([
  // staging 写死 authoring；prod 不设 = 只读（fail-safe），转发会让误配写生产
  "CONTENT_ADMIN_PROFILE",
  // 仅 staging 覆盖里显式 true，base/prod 不得出现
  "ADVENTURE_TEST_MODE_ENABLED",
]);

const SOURCE_DIR = resolve(__dirname, "../..");

/** 单键替换形式：${KEY} 或 ${KEY:-默认值} */
const SUBSTITUTION = /^\$\{([A-Z_0-9]+)(?::?-[^}]*)?\}$/;

describe("compose 环境变量白名单", () => {
  it("代码消费的键必须在 base 白名单里", () => {
    const missing = MUST_FORWARD.filter((key) => !(key in baseEnv));
    expect(missing).toEqual([]);
  });

  it("代码实际读取的环境变量也必须可达或显式豁免", () => {
    const missing = [...collectConfigKeys()]
      .filter((key) => !(key in baseEnv))
      .filter((key) => !INTENTIONALLY_NOT_FORWARDED.has(key))
      .sort();
    expect(missing).toEqual([]);
  });

  it("转发的键都要带默认值，缺配时 compose 不该报未定义变量", () => {
    for (const key of MUST_FORWARD) {
      const value = baseEnv[key];
      expect(SUBSTITUTION.test(value ?? "")).toBe(true);
      expect(value).toContain(":-");
    }
  });

  it("白名单里不允许张冠李戴：键名与替换的变量名必须一致", () => {
    const mismatched = Object.entries(baseEnv)
      .map(([key, value]) => {
        const match = SUBSTITUTION.exec(value ?? "");
        return match && match[1] !== key ? `${key} -> ${match[1]}` : null;
      })
      .filter(Boolean);
    expect(mismatched).toEqual([]);
  });

  it("CONTENT_ADMIN_PROFILE 刻意不进 base：prod 靠不设为只读兜底", () => {
    expect("CONTENT_ADMIN_PROFILE" in baseEnv).toBe(false);
    expect("CONTENT_ADMIN_PROFILE" in prodEnv).toBe(false);
    expect(stagingEnv.CONTENT_ADMIN_PROFILE).toBe("authoring");
  });

  it("ADVENTURE_TEST_MODE_ENABLED 刻意不进 base/prod：只有 staging 显式开启", () => {
    expect("ADVENTURE_TEST_MODE_ENABLED" in baseEnv).toBe(false);
    expect("ADVENTURE_TEST_MODE_ENABLED" in prodEnv).toBe(false);
    expect(stagingEnv.ADVENTURE_TEST_MODE_ENABLED).toBe("true");
  });
});

describe("同机双栈的内存护栏", () => {
  /**
   * Node 按宿主机总内存推算老生代上限，不看 cgroup limit。不设 NODE_OPTIONS，
   * 容器会在 GC 触发前就被 docker OOM kill，日志里只有一行 137。
   */
  it("两个环境的 app 都显式限定 V8 堆", () => {
    for (const env of [prodEnv, stagingEnv]) {
      expect(env.NODE_OPTIONS).toContain("--max-old-space-size=");
    }
  });

  it("prod 的 postgres 与 redis 都有内存上限", () => {
    for (const service of ["postgres", "redis"]) {
      const memory =
        prod.services?.[service]?.deploy?.resources?.limits?.memory;
      expect(typeof memory).toBe("string");
      expect(memory).toMatch(/\d+M/);
    }
  });

  it("V8 堆上限必须给非堆留余量，否则容器先被 OOM kill 才轮到 GC", () => {
    // 堆外还有 Buffer、代码段、线程栈、ARMS 探针，按 128M 余量算
    const HEADROOM_MB = 128;
    const cases: Array<[string, Compose, Record<string, string>]> = [
      ["prod", prod, prodEnv],
      ["staging", staging, stagingEnv],
    ];
    const violations = cases
      .map(([name, compose, env]) => {
        const limit = compose.services?.app?.deploy?.resources?.limits;
        const limitMb = parseMemoryMb(limit?.memory);
        const heapMb = parseHeapMb(env.NODE_OPTIONS);
        return heapMb > 0 && heapMb + HEADROOM_MB <= limitMb
          ? null
          : `${name}: heap=${heapMb}M limit=${limitMb}M`;
      })
      .filter(Boolean);
    expect(violations).toEqual([]);
  });

  it("prod 整栈 limit 之和不超过 ECS 预算", () => {
    // ECS 2 vCPU / 3623 MiB，与 staging 同机；prod 整栈按 2.5 GiB 封顶
    const BUDGET_MB = 2560;
    const total = ["app", "postgres", "redis"]
      .map((service) =>
        parseMemoryMb(
          prod.services?.[service]?.deploy?.resources?.limits?.memory,
        ),
      )
      .reduce((sum, mb) => sum + mb, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(BUDGET_MB);
  });
});

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      files.push(...collectTsFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

/**
 * 代码里真正读取的环境变量键：
 * - `configService.get("KEY")` / `this.config.get("KEY")` / `config.get("KEY")`
 * - `export const X_ENV = { ... "KEY" ... }` 这类常量映射（如冒险开关）
 *
 * 不扫描 process.env：APP_NAME/DATABASE_URL 等由 compose 直接注入或由
 * 运行时环境提供，不属于本闸口的「代码读了但没转发」口径。
 */
function collectConfigKeys(): Set<string> {
  const keys = new Set<string>();
  const literalGet =
    /(?:configService|this\.config|config)\.get(?:<[^>]+>)?\(\s*"([A-Z][A-Z0-9_]*)"/g;
  const envMap = /export const \w+_ENV = \{([\s\S]*?)\}/g;
  for (const file of collectTsFiles(SOURCE_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(literalGet)) {
      keys.add(match[1]);
    }
    for (const match of source.matchAll(envMap)) {
      for (const key of match[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)) {
        keys.add(key[1]);
      }
    }
  }
  return keys;
}

function parseMemoryMb(memory?: string): number {
  const match = /^(\d+)([MG])$/.exec(memory ?? "");
  if (!match) return 0;
  const value = Number(match[1]);
  return match[2] === "G" ? value * 1024 : value;
}

function parseHeapMb(nodeOptions?: string): number {
  const match = /--max-old-space-size=(\d+)/.exec(nodeOptions ?? "");
  return match ? Number(match[1]) : 0;
}
