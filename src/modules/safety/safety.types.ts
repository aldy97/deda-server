import type { Prisma } from "@prisma/client";

/**
 * 本轮实际安全话术处置，不是分类器结论。
 * - canned_block：任一 layer 明确拦截，代码返回固定话术
 * - unsafe_line_echo：模型输出中包含固定安全句（含 fail-open 回抄）
 * - caution_injected：注入了 L2 不可用时的谨慎指令
 * - none：未触发安全话术
 */
export type SafetyReply =
  "canned_block" | "unsafe_line_echo" | "caution_injected" | "none";

/**
 * 消息 rawPayload.safety 的持久化形状。
 * 对外 JSON key 固定为 reply（dashboard 已上线读取该字段）；
 * 内部调用方传 safetyReply，映射只发生在 buildSafetySnapshot 一处。
 */
export type SafetySnapshot = Prisma.InputJsonObject & {
  layer: string | null;
  category: string | null;
  blocked: boolean;
  source: string;
  matched: string | null;
  reply: SafetyReply;
  inferred: boolean;
};

/** 安全话术文本与指令按模式分组，但策略本身不依赖任何业务模块。 */
export type SafetyProfileKey = "default" | "adventure" | "sleep";
