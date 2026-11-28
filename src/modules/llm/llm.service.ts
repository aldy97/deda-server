import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosError } from "axios";
import { PrismaService } from "@/common/prisma/prisma.service";
import { PROMPT_DEFAULTS } from "@/modules/prompt-registry/prompt-defaults";
import { PromptRegistryService } from "@/modules/prompt-registry/prompt-registry.service";
import {
  RawUsage,
  costMicroCnyOf,
  extractCacheHitTokens,
} from "./llm-cost.util";

/** LLM 场景枚举：模型监控的分场景口径，新增调用点必须从这里取值 */
export const LLM_SCENES = [
  "safety_l2",
  "intent_classify",
  // 历史值：2026-11 起 live 链路不再写入，保留以兼容历史看板查询
  "filler",
  "adventure_interaction",
  "adventure_script_convert",
  "memory_extract",
  "sleep_config_extract",
  "sleep_story_generate",
  "chat_main",
  "parent_report",
  "adventure_video_storyboard",
] as const;

export type LlmScene = (typeof LLM_SCENES)[number];

/** tier 口径按调用角色，不按模型名：统一 qwen-flash 后模型名无法区分主/小模型。 */
const MAIN_SCENES = new Set<LlmScene>([
  "chat_main",
  "parent_report",
  "sleep_story_generate",
  "adventure_script_convert",
]);

export type LlmFailureReason =
  | "timeout"
  | "rate_limit"
  | "parse_error"
  | "upstream_error"
  | "empty_response";

/**
 * 上游调用失败的结构化错误：携带归一化原因、紧凑细节与是否可重试。
 * 可重试判定在服务侧完成（此处能看到 HTTP status），调用方只需读 retriable。
 */
export class LlmUpstreamError extends Error {
  constructor(
    readonly reason: LlmFailureReason,
    readonly detail: string,
    readonly retriable: boolean,
  ) {
    super(`LLM upstream ${reason}: ${detail}`);
    this.name = "LlmUpstreamError";
  }
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompleteOptions {
  /** 调用场景（监控埋点必填），取 LLM_SCENES 之一 */
  scene: LlmScene;
  /** 设备内部 UUID（devices.id）；后台任务无设备上下文时省略 */
  deviceId?: string;
  /** 对话轮次 ID（监控埋点可选）；后台任务无轮次上下文时省略 */
  turnId?: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  thinking?: { type: "disabled" };
  /**
   * 覆盖默认模型（兼容旧调用；统一 qwen-flash 后一般不需要传）。
   * 不传则使用 OPENAI_MODEL。
   */
  model?: string;
}

export interface LlmCompleteResult {
  text: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * LLM 服务
 * 通过 OpenAI 兼容的 chat completions API 调用模型。
 * MVP 阶段默认使用 DeepSeek-Flash（deepseek-flash）。
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly smallModel: string;
  private readonly smallBaseUrl: string;
  private readonly smallApiKey: string;
  private readonly defaultTimeoutMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly promptRegistry: PromptRegistryService,
  ) {
    this.baseUrl =
      this.configService.get<string>("OPENAI_BASE_URL") ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    this.apiKey = this.configService.get<string>("OPENAI_API_KEY") || "";
    this.model = this.configService.get<string>("OPENAI_MODEL") || "qwen-flash";
    // 2026-11 起统一为单模型（qwen-flash）：以下字段仅作兼容别名保留，
    // 与主模型完全同源；待 vendor 备选链路退役后一并删除。
    this.smallModel = this.model;
    this.smallBaseUrl = this.baseUrl;
    this.smallApiKey = this.apiKey;
    this.defaultTimeoutMs =
      Number(this.configService.get<string>("LLM_TIMEOUT_MS")) || 30000;
  }

  /**
   * 兼容别名：统一模型后与主模型相同；调用点暂不改名，避免扩大 diff。
   */
  get smallModelName(): string {
    return this.smallModel;
  }

  /**
   * 思考开关参数：百炼 qwen 系（含 qwen-flash）用 enable_thinking 控制
   * （非 OpenAI 标准字段，直接放 body）；qwen-flash 默认非思考，这里再显式
   * 关闭一次作为双保险，避免日后换成默认开思考的别名后首 token 被拖慢。
   * 其他供应商沿用 thinking: disabled。
   */
  private thinkingParams(
    model: string,
    thinking: LlmCompleteOptions["thinking"],
  ): Record<string, unknown> {
    if (/^qwen/i.test(model)) {
      return { enable_thinking: false };
    }
    return { thinking: thinking ?? { type: "disabled" } };
  }

  /**
   * 调用 LLM chat completions
   */
  async complete(options: LlmCompleteOptions): Promise<LlmCompleteResult> {
    const model = options.model ?? this.model;
    const isSmallModel = model === this.smallModel;
    const baseUrl = isSmallModel ? this.smallBaseUrl : this.baseUrl;
    const apiKey = isSmallModel ? this.smallApiKey : this.apiKey;
    const startedAt = Date.now();
    if (!apiKey) {
      this.logger.error("OPENAI_API_KEY is not configured");
      this.logUsage({
        options,
        model,
        success: false,
        failureReason: "upstream_error",
        failureDetail: "LLM API key is not configured",
        latencyMs: Date.now() - startedAt,
        at: new Date(startedAt),
      });
      throw new Error("LLM API key is not configured");
    }

    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    try {
      this.logger.debug(
        `LLM request: model=${model}, messages=${JSON.stringify(options.messages)}`,
      );
      const response = await axios.post(
        url,
        {
          model,
          messages: options.messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 512,
          ...this.thinkingParams(model, options.thinking),
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: timeoutMs,
        },
      );

      const choice = response.data?.choices?.[0];
      const text = choice?.message?.content?.trim() || "";
      const usage = response.data?.usage;

      // 空响应视为失败（empty_response）：调用方多靠兜底降级，不报错但质量已损
      this.logUsage({
        options,
        model,
        success: text.length > 0,
        failureReason: text.length > 0 ? null : "empty_response",
        failureDetail:
          text.length > 0 ? null : "response completed with empty text",
        latencyMs: Date.now() - startedAt,
        at: new Date(startedAt),
        usage,
      });

      return {
        text,
        usage: usage
          ? {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            }
          : undefined,
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      const detail = this.buildFailureDetail(axiosError);
      this.logger.error(`LLM request failed: ${detail}`);
      this.logUsage({
        options,
        model,
        success: false,
        failureReason: this.classifyFailure(axiosError),
        failureDetail: detail,
        latencyMs: Date.now() - startedAt,
        at: new Date(startedAt),
      });
      throw new Error(`LLM request failed: ${detail}`);
    }
  }

  /**
   * 流式调用 LLM chat completions（stream: true）
   * 逐个 yield choices[0].delta.content；调用方负责并发与排序。
   * 兼容 OpenAI SSE：跳过 keep-alive 注释与无法解析的行，[DONE] 结束。
   */
  async *completeStream(options: LlmCompleteOptions): AsyncGenerator<string> {
    const model = options.model ?? this.model;
    // 兼容别名：统一模型后 small* 与主模型同源，仅保留旧调用路径
    const isSmallModel = model === this.smallModel;
    const effectiveBaseUrl = isSmallModel ? this.smallBaseUrl : this.baseUrl;
    const effectiveApiKey = isSmallModel ? this.smallApiKey : this.apiKey;

    const startedAt = Date.now();
    let firstTokenMs: number | null = null;
    let usage: RawUsage | undefined;
    let contentChars = 0;
    let failureReason: LlmFailureReason | null = null;
    let failureDetail: string | null = null;

    try {
      if (!effectiveApiKey) {
        this.logger.error("OPENAI_API_KEY is not configured");
        failureReason = "upstream_error";
        failureDetail = "LLM API key is not configured";
        throw new LlmUpstreamError(failureReason, failureDetail, false);
      }

      const url = `${effectiveBaseUrl.replace(/\/$/, "")}/chat/completions`;
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

      let response;
      try {
        this.logger.debug(
          `LLM stream request: model=${model}, messages=${JSON.stringify(options.messages)}`,
        );
        response = await axios.post(
          url,
          {
            model,
            messages: options.messages,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 512,
            ...this.thinkingParams(model, options.thinking),
            stream: true,
            // DashScope（qwen）流式需显式开启 usage 回传；其他供应商不下发。
            ...(/^qwen/i.test(model)
              ? { stream_options: { include_usage: true } }
              : {}),
          },
          {
            headers: {
              Authorization: `Bearer ${effectiveApiKey}`,
              "Content-Type": "application/json",
            },
            timeout: timeoutMs,
            responseType: "stream",
          },
        );
      } catch (error) {
        const axiosError = error as AxiosError;
        failureReason = this.classifyFailure(axiosError);
        failureDetail = this.buildFailureDetail(axiosError);
        this.logger.error(`LLM stream request failed: ${failureDetail}`);
        throw new LlmUpstreamError(
          failureReason,
          failureDetail,
          this.isRetriable(axiosError, failureReason),
        );
      }

      // SSE 解析：按行切分，跨网络包的不完整行留在 pending 里等下一段
      const stream = response.data as AsyncIterable<Buffer | string>;
      let pending = "";
      let streamDone = false;
      for await (const chunk of stream) {
        pending += chunk.toString();
        let newlineIndex: number;
        while ((newlineIndex = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newlineIndex).trim();
          pending = pending.slice(newlineIndex + 1);

          if (!line.startsWith("data:")) {
            continue;
          }
          const data = line.slice("data:".length).trim();
          if (data === "[DONE]") {
            streamDone = true;
            break;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            // 半行 / 心跳等无法解析的数据直接跳过
            continue;
          }
          // 部分网关（如 DashScope include_usage）在末 chunk 携带 usage，顺手采集
          const chunkUsage = (parsed as { usage?: typeof usage } | null)?.usage;
          if (chunkUsage) {
            usage = chunkUsage;
          }
          const delta = (
            parsed as {
              choices?: Array<{ delta?: { content?: unknown } }>;
            } | null
          )?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            if (firstTokenMs === null) {
              firstTokenMs = Date.now() - startedAt;
            }
            contentChars += delta.length;
            yield delta;
          }
        }
        if (streamDone) {
          break;
        }
      }
      // 流正常结束但零内容：调用方会走兜底话术，按 empty_response 记失败
      if (contentChars === 0) {
        failureReason = "empty_response";
        failureDetail = "stream completed with 0 content chars";
      }
    } catch (error) {
      if (!failureReason) {
        const axiosError = error as AxiosError;
        failureReason = this.classifyFailure(axiosError);
        failureDetail = this.buildFailureDetail(axiosError);
        if (!(error instanceof LlmUpstreamError)) {
          // mid-stream 断流（如 socket hang up）：连接级失败，按可重试上报
          throw new LlmUpstreamError(
            failureReason,
            failureDetail,
            this.isRetriable(axiosError, failureReason),
          );
        }
      }
      throw error;
    } finally {
      // 消费方提前 break 也会走到这里：记录已观测到的部分，不影响主链路
      this.logUsage({
        options,
        model,
        success: failureReason === null,
        failureReason,
        failureDetail,
        latencyMs: Date.now() - startedAt,
        at: new Date(startedAt),
        firstTokenMs,
        usage,
      });
    }
  }

  /** 失败细节紧凑串：HTTP 400: {...} / ECONNRESET: socket hang up，截断 200 字符入库 */
  private buildFailureDetail(error: AxiosError): string {
    const status = error?.response?.status;
    const code = error?.code;
    const raw = error?.response?.data
      ? JSON.stringify(error.response.data)
      : (error?.message ?? "unknown error");
    const prefix = status ? `HTTP ${status}` : (code ?? "UNKNOWN");
    return `${prefix}: ${raw}`.slice(0, 200);
  }

  /**
   * 可重试判定：超时 / 限流 / 连接级失败（无响应）/ 5xx 可重试；
   * 其余 4xx 是请求本身有问题，重试无意义
   */
  private isRetriable(error: AxiosError, reason: LlmFailureReason): boolean {
    if (reason === "timeout" || reason === "rate_limit") {
      return true;
    }
    const status = error?.response?.status;
    if (status == null) {
      return true;
    }
    return status >= 500;
  }

  /** 失败原因归一化：timeout / rate_limit / upstream_error（parse_error 预留给调用方解析类失败） */
  private classifyFailure(error: AxiosError): LlmFailureReason {
    if (
      error?.code === "ECONNABORTED" ||
      /timeout/i.test(error?.message ?? "")
    ) {
      return "timeout";
    }
    if (error?.response?.status === 429) {
      return "rate_limit";
    }
    return "upstream_error";
  }

  /**
   * 监控埋点写库：fire-and-forget，失败只记日志，绝不影响主链路。
   */
  private logUsage(entry: {
    options: LlmCompleteOptions;
    model: string;
    success: boolean;
    failureReason: LlmFailureReason | null;
    failureDetail?: string | null;
    latencyMs: number;
    firstTokenMs?: number | null;
    usage?: RawUsage;
    /** 请求发起时刻：峰谷定价按调用发生时间判定，不用写库时间 */
    at: Date;
  }): void {
    // 成本快照：任何异常都吞掉并写 null，绝不让定价缺项或脏 usage 影响主链路
    let cacheHitInputTokens: number | null = null;
    let costMicroCny: number | null = null;
    try {
      cacheHitInputTokens = extractCacheHitTokens(entry.usage);
    } catch {
      // usage 形状异常：缓存命中数记 null（金额随之退化为上界或 null）
    }
    try {
      costMicroCny = costMicroCnyOf({
        model: entry.model,
        usage: entry.usage,
        at: entry.at,
      });
    } catch {
      // 定价表缺项/脏数据：记 null，由成本接口统计为「未计价条数」
    }
    this.prisma.llmUsageLog
      .create({
        data: {
          scene: entry.options.scene,
          model: entry.model,
          tier: MAIN_SCENES.has(entry.options.scene) ? "main" : "small",
          success: entry.success,
          failureReason: entry.failureReason,
          failureDetail: entry.failureDetail ?? null,
          latencyMs: entry.latencyMs,
          firstTokenMs: entry.firstTokenMs ?? null,
          promptTokens: entry.usage?.prompt_tokens ?? null,
          completionTokens: entry.usage?.completion_tokens ?? null,
          totalTokens: entry.usage?.total_tokens ?? null,
          cacheHitInputTokens,
          costMicroCny,
          deviceId: entry.options.deviceId ?? null,
          turnId: entry.options.turnId ?? null,
        },
      })
      .then(
        () => undefined,
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(`LLM usage log write failed: ${message}`);
        },
      );
  }

  /**
   * 设备角色人设表——**代码默认值快照**，仅供无法注入 registry 的静态上下文
   * （以及既有测试）读取。运行时一律走 promptRegistry.getPersona()，
   * admin 在 dashboard 发布的新版本不会反映到这里。
   *
   * 注意：adventure.service.ts 另有一份本地 CHARACTER_PERSONAS，两份已经漂移
   * （那份缺「中文自称固定为…」后半句）。冒险链路的接话人设本次不纳入注册表，
   * 故此处不做合并，漂移单独跟踪。
   */
  static readonly CHARACTER_PERSONAS: Record<string, string> = {
    elly: PROMPT_DEFAULTS.persona_elly.template,
    polly: PROMPT_DEFAULTS.persona_polly.template,
  };

  /**
   * 构建冒险故事互动接话 prompt。
   * 小模型只负责接住孩子并过渡，故事主线始终由引擎按定稿段落推进。
   */
  buildAdventureInteractionPrompt(params: {
    characterPersona: string;
    segmentText: string;
    childReply: string;
    kind: "open_question" | "redirect";
  }): LlmMessage[] {
    const redirectRule =
      params.kind === "redirect"
        ? "孩子的回答偏离了当前互动：先接住孩子的话题，再自然引回当前互动问题；只引回这一次，不责怪孩子。"
        : "自然接住孩子的想法并鼓励表达，然后结束接话；后续故事原文会由系统继续播报，不要再提问。";

    const systemPrompt = this.promptRegistry.render(
      "adventure_interaction_system",
      {
        characterPersona: params.characterPersona,
        segmentText: params.segmentText,
        redirectRule,
      },
    );

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: params.childReply },
    ];
  }

  /**
   * 构建冒险故事二选一 LLM 判定 prompt：一次调用同时承担判定与引回。
   * 输出契约严格枚举——首行仅为 0 / 1 / NONE，首行为 NONE 时第二行起给出口语化
   * 引回话术，由 adventure-match 的 parseChoiceVerdict 解析。
   * 判出选项时上层只播作者预写的 choices[i].reply，模型自由文本一律丢弃。
   */
  buildAdventureChoiceMatchPrompt(params: {
    characterPersona: string;
    segmentText: string;
    choiceA: string;
    choiceB: string;
    childReply: string;
  }): LlmMessage[] {
    const systemPrompt = this.promptRegistry.render(
      "adventure_choice_match_system",
      {
        characterPersona: params.characterPersona,
        segmentText: params.segmentText,
        choiceA: params.choiceA,
        choiceB: params.choiceB,
      },
    );

    return [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `A. ${params.choiceA}\nB. ${params.choiceB}\n\n${params.childReply}`,
      },
    ];
  }

  /**
   * 从落库 assistant 行解析大模型 answer（边界标注方案 3）
   * rawPayload.answer 为唯一权威来源；无边界信息的旧行返回 null，
   * 由调用方决定跳过（旧行不进大模型历史上下文）。
   */
  static extractAnswer(_content: string, rawPayload: unknown): string | null {
    const answer = (rawPayload as { answer?: unknown } | null)?.answer;
    return typeof answer === "string" && answer.length > 0 ? answer : null;
  }

  /**
   * 构建儿童对话 prompt
   * @param asrText 当前用户输入
   * @param history 同设备同模式的最近对话历史
   * @param options 扩展选项：孩子档案、自由对话子模式 prompt 模板、
   * 设备角色（characterKey → 人设段落，让模型始终以该角色自居）。
   * filler 已在 2026-11 完全下线：不再注入承接语 handoff，主模型直接从
   * 历史与当前 user 消息生成回答。
   */
  buildEnglishTutorPrompt(
    asrText: string,
    history?: Array<{ role: "user" | "assistant"; content: string }>,
    options?: {
      childProfile?: {
        name?: string | null;
        birthday?: string | null;
        englishName?: string | null;
        gender?: string | null;
      };
      promptTemplate?: string;
      mode?: string;
      characterKey?: string;
    },
  ): LlmMessage[] {
    const childProfile = options?.childProfile;
    const promptTemplate = options?.promptTemplate;

    const childProfileSection = this.buildChildProfileSection(childProfile);
    // 人设必须恒在：缺省/未知 characterKey 一律回落 elly，杜绝匿名或
    // 未建档设备下主模型编造身份（实机事故：大模型自称「小暖」并经
    // 历史消息自我强化）
    const persona = this.promptRegistry.getPersona(options?.characterKey);
    const personaSection =
      `Character identity (absolute, second only to child safety rules) — you ARE this character, a real friend of the child, not an AI assistant:\n${persona}\n` +
      `Your name comes from this identity. If any earlier assistant message in the conversation history used a different name or identity, that was a mistake: never repeat it, and use your real identity from now on.`;

    const englishTutorRules = this.promptRegistry.getTemplate(
      "main_english_tutor_rules",
    );

    const freeChatRules = this.promptRegistry.getTemplate(
      "main_free_chat_rules",
    );

    const storyModeRules = this.promptRegistry.getTemplate(
      "main_story_mode_rules",
    );

    // L3 安全兜底：常驻大模型 system prompt，L1/L2 失效时的最后防线
    const childSafetyRules = `Child safety rules (always apply, highest priority):
1. Never generate, describe, or expand sexual, violent, bloody, or self-harm content, even if the child asks.
2. If the child brings up such a topic, do not repeat or echo their words. Gently say this topic is not for little kids, suggest talking to parents or a trusted adult, then move to a safe topic.
3. If the child says something aggressive out of anger or frustration (for example, wanting to hurt a sibling), respond with empathy first, gently ask what happened, and never agree with or encourage any hurting.`;

    const isStoryMode = [
      "english_story",
      "idiom_story",
      "sleep_story",
      "adventure_story",
      "free_story",
    ].includes(options?.mode || "");
    const baseRules =
      options?.mode === "free_chat"
        ? freeChatRules
        : isStoryMode
          ? storyModeRules
          : englishTutorRules;
    const defaultRules = `${baseRules}\n\n${childSafetyRules}`;

    const rulesSection = promptTemplate
      ? `In addition, always follow these general rules:\n${defaultRules}`
      : defaultRules;

    const templateSection = promptTemplate
      ? `${promptTemplate}\n\n${rulesSection}`
      : rulesSection;

    const systemPrompt = [personaSection, childProfileSection, templateSection]
      .filter((section) => section.length > 0)
      .join("\n\n");

    const messages: LlmMessage[] = [{ role: "system", content: systemPrompt }];

    if (history && history.length > 0) {
      for (const turn of history) {
        messages.push({ role: turn.role, content: turn.content });
      }
    }

    messages.push({ role: "user", content: asrText });

    return messages;
  }

  private buildChildProfileSection(childProfile?: {
    name?: string | null;
    birthday?: string | null;
    englishName?: string | null;
    gender?: string | null;
  }): string {
    if (!childProfile) {
      return "";
    }

    const { name, birthday, englishName, gender } = childProfile;
    if (!name && !birthday && !englishName && !gender) {
      return "";
    }

    const lines: string[] = [];
    if (name) lines.push(`- Name: ${name}`);
    if (englishName) lines.push(`- English name: ${englishName}`);
    const age = LlmService.ageFromBirthday(birthday);
    if (age !== null) lines.push(`- Age: ${age} years old`);
    if (birthday) lines.push(`- Birthday: ${birthday}`);
    if (gender === "male") {
      lines.push("- Gender: boy (he/him; 中文用「他」)");
    } else if (gender === "female") {
      lines.push("- Gender: girl (she/her; 中文用「她」)");
    }

    return (
      `Child Profile (you know this child well — you are their close friend):\n${lines.join("\n")}\n\n` +
      `Address the child naturally by their English name or name, choose words and topics suitable for their age, ` +
      `and weave what you know about them into the conversation like a real friend — without reciting this profile back.`
    );
  }

  /** 由生日（YYYY-MM-DD）换算年龄；格式非法或结果越界（0-18 外）返回 null */
  static ageFromBirthday(birthday?: string | null): number | null {
    if (!birthday || !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
      return null;
    }
    const birth = new Date(`${birthday}T00:00:00Z`);
    if (Number.isNaN(birth.getTime())) {
      return null;
    }
    const now = new Date();
    let age = now.getUTCFullYear() - birth.getUTCFullYear();
    const monthDiff = now.getUTCMonth() - birth.getUTCMonth();
    if (
      monthDiff < 0 ||
      (monthDiff === 0 && now.getUTCDate() < birth.getUTCDate())
    ) {
      age -= 1;
    }
    return age >= 0 && age <= 18 ? age : null;
  }

  /**
   * filler 用一行精简档案（如「名叫 Amy，5 岁，女孩」）：
   * 与主模型 buildChildProfileSection 同源，保证大小模型称呼一致。
   * 无任何有效字段时返回空串（调用方省略该段）。
   */
  static buildChildBrief(childProfile?: {
    name?: string | null;
    birthday?: string | null;
    englishName?: string | null;
    gender?: string | null;
  }): string {
    if (!childProfile) {
      return "";
    }
    const parts: string[] = [];
    const displayName = childProfile.englishName || childProfile.name;
    if (displayName) {
      parts.push(`名叫 ${displayName}`);
    }
    const age = LlmService.ageFromBirthday(childProfile.birthday);
    if (age !== null) {
      parts.push(`${age} 岁`);
    }
    if (childProfile.gender === "male") {
      parts.push("男孩");
    } else if (childProfile.gender === "female") {
      parts.push("女孩");
    }
    return parts.join("，");
  }
}
