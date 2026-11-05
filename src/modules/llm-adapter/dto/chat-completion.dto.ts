/**
 * OpenAI 兼容 chat completions 请求类型与手工校验。
 *
 * 不用 class-validator 的原因：全局 ValidationPipe 开启了 forbidNonWhitelisted，
 * 而百度 RTC 会通过 llm_eb 注入我们未声明的扩展字段（thinking/user 等），
 * 该端点必须容忍未知字段，因此走 @Req() 原始 body + 手工校验。
 */

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  /** 模型名原样回显；适配层按别名路由，不校验取值 */
  model: string;
  messages: ChatCompletionMessage[];
  stream: boolean;
  /**
   * OpenAI 标准 user 字段。百度 RTC 用它携带设备 userid（机芯厂约定 = 设备
   * MAC，重启/烧录/OTA 不变），适配层据此解析设备身份；缺省走匿名链路。
   */
  user?: string;
}

export type ParseResult =
  { ok: true; value: ChatCompletionRequest } | { ok: false; message: string };

const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);

export function parseChatCompletionRequest(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "request body must be a JSON object" };
  }

  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    return { ok: false, message: "messages must be a non-empty array" };
  }

  const messages: ChatCompletionMessage[] = [];
  for (const item of raw.messages) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, message: "each message must be an object" };
    }
    const m = item as Record<string, unknown>;
    if (typeof m.role !== "string" || !ALLOWED_ROLES.has(m.role)) {
      return { ok: false, message: `unsupported message role` };
    }
    if (typeof m.content !== "string") {
      return { ok: false, message: "message content must be a string" };
    }
    messages.push({
      role: m.role as ChatCompletionMessage["role"],
      content: m.content,
    });
  }

  if (!messages.some((m) => m.role === "user")) {
    return { ok: false, message: "messages must contain a user message" };
  }

  return {
    ok: true,
    value: {
      model:
        typeof raw.model === "string" && raw.model.length > 0
          ? raw.model
          : "deda-english-tutor",
      messages,
      stream: raw.stream === true,
      user:
        typeof raw.user === "string" && raw.user.trim().length > 0
          ? raw.user.trim()
          : undefined,
    },
  };
}
