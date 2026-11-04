import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqual } from "crypto";
import { LlmService, LlmMessage } from "@/modules/llm/llm.service";
import {
  BlockedSafetyCategory,
  ChildSafetyService,
} from "@/modules/vendor/child-safety.service";
import { ChatCompletionRequest } from "./dto/chat-completion.dto";

/** 上游故障时的兜底话术：保证设备端有声音，不让孩子面对沉默 */
const UPSTREAM_FALLBACK_TEXT =
  "Sorry, I didn't catch that. Can you say it again?";

/** 历史轮数上限：防爆上下文（最近 10 轮一问一答） */
const MAX_HISTORY_TURNS = 10;

const BLOCKED_CATEGORIES: BlockedSafetyCategory[] = [
  "sexual",
  "violence",
  "self_harm",
];

/**
 * LLM 适配服务：承接百度 RTC 的 OpenAI 兼容回调。
 *
 * 编排：Bearer 鉴权 → L1 安全闸 → buildEnglishTutorPrompt 组装动态 prompt
 * → LlmService.completeStream 流式上游。本期走 free_chat 默认模式，
 * 设备标识/教材 RAG 待百度回传设备信息后二期接入。
 */
@Injectable()
export class LlmAdapterService {
  private readonly logger = new Logger(LlmAdapterService.name);
  private readonly apiKey?: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly llmService: LlmService,
    private readonly childSafety: ChildSafetyService,
  ) {
    this.apiKey = this.configService.get<string>("LLM_ADAPTER_API_KEY");
    if (!this.apiKey) {
      this.logger.warn(
        "LLM_ADAPTER_API_KEY is not configured; all adapter requests will be rejected",
      );
    }
  }

  /**
   * 校验 Authorization: Bearer <token>，时序安全比较，token 不落日志。
   */
  validateToken(authorization?: string): boolean {
    if (!this.apiKey) return false;
    const match = /^Bearer\s+(.+)$/.exec(authorization ?? "");
    if (!match) return false;
    const given = Buffer.from(match[1]);
    const expected = Buffer.from(this.apiKey);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  assertToken(authorization?: string): void {
    if (!this.validateToken(authorization)) {
      throw new UnauthorizedException("invalid api key");
    }
  }

  /**
   * 生成回复文本流。L1 命中与上游首 chunk 前故障都会转为兜底文本流，
   * 保证对百度侧永远是"成功的流式响应"。
   */
  async *streamReply(req: ChatCompletionRequest): AsyncGenerator<string> {
    const asrText = this.lastUserMessage(req);
    const history = this.extractHistory(req);
    const baiduSystem = req.messages.filter((m) => m.role === "system");

    const verdict = this.childSafety.checkL1(asrText);
    if (
      verdict.blocked &&
      verdict.category &&
      BLOCKED_CATEGORIES.includes(verdict.category as BlockedSafetyCategory)
    ) {
      this.logger.warn(
        `L1 blocked category=${verdict.category} matched=${verdict.matched ?? ""}`,
      );
      yield this.childSafety.cannedReply(
        verdict.category as BlockedSafetyCategory,
      );
      return;
    }

    const built = this.llmService.buildEnglishTutorPrompt(asrText, history, {
      mode: "free_chat",
    });
    const messages: LlmMessage[] = [...baiduSystem, ...built];

    let yielded = false;
    try {
      const stream = this.llmService.completeStream({
        messages,
        maxTokens: 200,
        thinking: { type: "disabled" },
      });
      for await (const chunk of stream) {
        yielded = true;
        yield chunk;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`LLM upstream failed: ${message}`);
      if (!yielded) {
        yield UPSTREAM_FALLBACK_TEXT;
      }
    }
  }

  /** 非流式：聚合全部 chunk 为整段文本 */
  async completeReply(req: ChatCompletionRequest): Promise<string> {
    let text = "";
    for await (const chunk of this.streamReply(req)) {
      text += chunk;
    }
    return text;
  }

  private lastUserMessage(req: ChatCompletionRequest): string {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      if (req.messages[i].role === "user") return req.messages[i].content;
    }
    throw new BadRequestException("messages must contain a user message");
  }

  /** 取最后一条 user 消息之前的 user/assistant 对作为历史，截最近 N 轮 */
  private extractHistory(
    req: ChatCompletionRequest,
  ): Array<{ role: "user" | "assistant"; content: string }> {
    const turns = req.messages.filter((m) => m.role !== "system");
    // 最后一条即当前 asrText，不进历史
    const prior = turns.slice(0, -1);
    const history = prior.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
    return history.slice(-MAX_HISTORY_TURNS * 2);
  }
}
