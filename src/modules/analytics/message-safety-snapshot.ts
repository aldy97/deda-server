import { ADVENTURE_UNSAFE_LINE } from "@/modules/adventure/adventure.constants";

/** 从 turn_decision_logs 取到的最小判定形状（历史回补只读这一份）。 */
export interface MessageSafetyDecision {
  safetyLayer: string | null;
  safetyCategory: string | null;
  safetyBlocked: boolean;
  safetySource: string;
  safetyMatched: string | null;
}

export type MessageSafetyReply =
  "canned_block" | "unsafe_line_echo" | "caution_injected" | "none" | "unknown";

/**
 * 回补写入 messages.rawPayload.safety 的快照。
 *
 * `inferred=true` 表示没有判定行，只能从 AI 回复内容推断；前端必须显示
 * 「推断回补」，不能伪装成模型原始判定。
 */
export interface MessageSafetySnapshot {
  layer: string | null;
  category: string | null;
  blocked: boolean;
  source: string;
  matched: string | null;
  reply: MessageSafetyReply;
  inferred: boolean;
  backfilledAt: string;
}

const FAIL_OPEN_SOURCES = new Set(["l2_fail_open", "l2_invalid_label"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnsafeLine(assistantTexts: string[]): boolean {
  return assistantTexts.some((text) => text.includes(ADVENTURE_UNSAFE_LINE));
}

function isNonSafeCategory(category: string | null): boolean {
  return category !== null && category !== "safe";
}

/**
 * 判定一行历史轮次是否需要、以及需要写成什么安全快照。
 *
 * 返回 null = 该轮没有可回补的安全信号，脚本应计入 skippedNoSignal。
 */
export function buildMessageSafetySnapshot(input: {
  decision: MessageSafetyDecision | null;
  mode: string | null;
  assistantTexts: string[];
  now?: Date;
}): MessageSafetySnapshot | null {
  const { decision, mode, assistantTexts } = input;
  const backfilledAt = (input.now ?? new Date()).toISOString();
  const echoed = hasUnsafeLine(assistantTexts);

  if (decision) {
    const failOpen = FAIL_OPEN_SOURCES.has(decision.safetySource);
    const caught =
      decision.safetyBlocked ||
      isNonSafeCategory(decision.safetyCategory) ||
      failOpen ||
      echoed;
    if (!caught) return null;

    let reply: MessageSafetyReply;
    if (decision.safetyBlocked) {
      reply = "canned_block";
    } else if (echoed) {
      reply = "unsafe_line_echo";
    } else if (failOpen && mode === "adventure_story") {
      // 惰性 L2 上线后，冒险 fail-open 会注入 ADVENTURE_SAFETY_CAUTION；
      // 历史行没有单独的「指令已注入」标记，只能按模式推断。
      reply = "caution_injected";
    } else {
      reply = "none";
    }

    return {
      layer: decision.safetyLayer,
      category: decision.safetyCategory,
      blocked: decision.safetyBlocked,
      source: decision.safetySource,
      matched: decision.safetyMatched,
      reply,
      inferred: false,
      backfilledAt,
    };
  }

  if (!echoed) return null;

  return {
    layer: null,
    category: null,
    blocked: false,
    source: "inferred_from_reply",
    matched: null,
    reply: "unsafe_line_echo",
    inferred: true,
    backfilledAt,
  };
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) => jsonEqual(a[key], b[key]))
    );
  }
  return false;
}

/**
 * 把 safety 合并进 rawPayload，保留原有 key。
 *
 * 已有 safety 时默认不覆盖（避免回补脚本反复跑漂移）；force 才覆盖。
 * rawPayload 不是普通对象时替换为只含 safety 的对象，并标记 replacedNonObject。
 */
export function mergeSafetyIntoRawPayload(
  rawPayload: unknown,
  snapshot: MessageSafetySnapshot,
  options: { force: boolean },
): {
  payload: unknown;
  changed: boolean;
  replacedNonObject: boolean;
} {
  if (!isPlainObject(rawPayload)) {
    return {
      payload: { safety: snapshot },
      changed: true,
      replacedNonObject: true,
    };
  }

  const existing = rawPayload.safety;
  if (existing !== undefined && jsonEqual(existing, snapshot)) {
    return { payload: rawPayload, changed: false, replacedNonObject: false };
  }
  if (existing !== undefined && !options.force) {
    return { payload: rawPayload, changed: false, replacedNonObject: false };
  }

  return {
    payload: { ...rawPayload, safety: snapshot },
    changed: true,
    replacedNonObject: false,
  };
}

/** 只删除回补脚本写入的快照（带 backfilledAt），不碰未来写入链路的真实快照。 */
export function removeBackfilledSafety(rawPayload: unknown): {
  payload: unknown;
  changed: boolean;
} {
  if (!isPlainObject(rawPayload) || !isPlainObject(rawPayload.safety)) {
    return { payload: rawPayload, changed: false };
  }
  const safety = rawPayload.safety;
  if (typeof safety.backfilledAt !== "string" || safety.backfilledAt === "") {
    return { payload: rawPayload, changed: false };
  }
  const rest = { ...rawPayload };
  delete rest.safety;
  return { payload: rest, changed: true };
}
