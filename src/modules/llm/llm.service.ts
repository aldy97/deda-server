import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosError } from "axios";
import { PrismaService } from "@/common/prisma/prisma.service";

/** LLM 场景枚举：模型监控的分场景口径，新增调用点必须从这里取值 */
export const LLM_SCENES = [
  "safety_l2",
  "intent_classify",
  "filler",
  "adventure_interaction",
  "memory_extract",
  "sleep_config_extract",
  "sleep_story_generate",
  "chat_main",
  "parent_report",
] as const;

export type LlmScene = (typeof LLM_SCENES)[number];

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
   * 覆盖默认模型（如小模型首响场景）。
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
  ) {
    this.baseUrl =
      this.configService.get<string>("OPENAI_BASE_URL") ||
      "https://api.deepseek.com/v1";
    this.apiKey = this.configService.get<string>("OPENAI_API_KEY") || "";
    this.model =
      this.configService.get<string>("OPENAI_MODEL") || "deepseek-flash";
    // 首响「打哈哈」小模型；未配置时回落到主模型
    this.smallModel =
      this.configService.get<string>("SMALL_LLM_MODEL") || this.model;
    // 小模型独立端点与 key（如百炼 DashScope）；未配置时回落主凭证，
    // 保证本地无小模型 key 时主链路仍可跑通
    this.smallBaseUrl =
      this.configService.get<string>("SMALL_LLM_BASE_URL") || this.baseUrl;
    this.smallApiKey =
      this.configService.get<string>("SMALL_LLM_API_KEY") || this.apiKey;
    this.defaultTimeoutMs =
      Number(this.configService.get<string>("LLM_TIMEOUT_MS")) || 30000;
  }

  /**
   * 小模型名称（首响场景使用）
   */
  get smallModelName(): string {
    return this.smallModel;
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
      this.logger.error(
        isSmallModel
          ? "SMALL_LLM_API_KEY is not configured"
          : "OPENAI_API_KEY is not configured",
      );
      this.logUsage({
        options,
        model,
        success: false,
        failureReason: "upstream_error",
        failureDetail: "LLM API key is not configured",
        latencyMs: Date.now() - startedAt,
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
          thinking: options.thinking ?? { type: "disabled" },
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
    // 小模型走独立端点与 key（如百炼 DashScope；未配置时已回落主凭证）
    const isSmallModel = model === this.smallModel;
    const effectiveBaseUrl = isSmallModel ? this.smallBaseUrl : this.baseUrl;
    const effectiveApiKey = isSmallModel ? this.smallApiKey : this.apiKey;

    const startedAt = Date.now();
    let firstTokenMs: number | null = null;
    let usage:
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        }
      | undefined;
    let contentChars = 0;
    let failureReason: LlmFailureReason | null = null;
    let failureDetail: string | null = null;

    try {
      if (!effectiveApiKey) {
        this.logger.error(
          isSmallModel
            ? "SMALL_LLM_API_KEY is not configured"
            : "OPENAI_API_KEY is not configured",
        );
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
            thinking: options.thinking ?? { type: "disabled" },
            stream: true,
            // 仅小模型（DashScope）流式需要显式开启 usage 回传；
            // DeepSeek 主网关流式原生返回 usage，加此参数反而会 400，故不下发
            ...(isSmallModel
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
    usage?:
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        }
      | undefined;
  }): void {
    const isSmallModel = entry.model === this.smallModel;
    this.prisma.llmUsageLog
      .create({
        data: {
          scene: entry.options.scene,
          model: entry.model,
          tier: isSmallModel ? "small" : "main",
          success: entry.success,
          failureReason: entry.failureReason,
          failureDetail: entry.failureDetail ?? null,
          latencyMs: entry.latencyMs,
          firstTokenMs: entry.firstTokenMs ?? null,
          promptTokens: entry.usage?.prompt_tokens ?? null,
          completionTokens: entry.usage?.completion_tokens ?? null,
          totalTokens: entry.usage?.total_tokens ?? null,
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
   * 设备角色人设表（与 adventure.service.ts 的 CHARACTER_PERSONAS 同步修改）。
   * 注入主对话 system prompt，让模型始终以该角色自居（含自报名字）。
   */
  static readonly CHARACTER_PERSONAS: Record<string, string> = {
    elly: "小象 Elly：听风原野的居民，性格温暖好奇，说话轻声细语，喜欢用「呀」「呢」结尾，爱鼓励孩子。中文自称固定为「小象 Elly」，不要用「艾莉」「小艾」等其他写法。",
    polly:
      "小马 Polly：听风原野的居民，性格开朗勇敢，说话活泼简洁，喜欢邀请孩子一起尝试，也爱鼓励孩子。中文自称固定为「小马 Polly」，不要用其他写法。",
  };

  /**
   * 构建首响「打哈哈」prompt（小模型用，中文撰写——输出以中文为主，
   * 指令与目标语言对齐可减少跨语言指令遵循滑移，也便于团队维护）。
   * 要点：明确角色定位（只为正式回答争取时间）、语言跟随用户、
   * 15-20 字（音频覆盖主模型首包，实测 gap P90=2.36s）、禁止实质回答、
   * 禁止以孩子名字开头、禁止自称/人设名、禁止新增意象（filler 越抒情，
   * 主模型越有东西可复读）、措辞多样化，并给达标的 few-shot 示例。
   * 不带教材上下文与历史，避免小模型展开真正回答。
   * @param recentFillers 最近若干轮本方用过的 filler 原文，
   * 进入禁用清单，保证跨轮次措辞多样性（首轮/无数据时省略该段）
   * @param turnContext 本轮只读情境（意图/门禁结论/角色人设/孩子档案），
   * 让 filler 的拖延话术与主回答同向，杜绝"预告冒险启动但主模型婉拒"、
   * "filler 自称小星但主模型是 Elly"这类矛盾播报
   */
  buildFillerPrompt(
    asrText: string,
    recentFillers?: string[],
    turnContext?: {
      intent?: string;
      adventureDeclined?: boolean;
      persona?: string;
      childBrief?: string;
    },
  ): LlmMessage[] {
    const systemPrompt = `你是儿童语音陪伴玩具的「首响承接层」。你的唯一任务是为正式回答争取时间：立刻说出一句温暖的话，接住孩子刚说的事，让孩子感到被听见。

规则：
1. 用孩子刚说的语言回复。
2. 中文 15 到 20 个字，英文 8 到 12 个词，口语自然。你的话会被立刻语音播报，用来盖住正式回答的准备时间——太短会留下尴尬的沉默。
3. 绝不回答问题或提供实质内容——正式回答稍后由主回答给出。
4. 回声孩子话里的关键词，让 TA 觉得被听见；措辞要多样，绝不连续两次用同样的开头。
5. 不要以孩子的名字开头——正式回答里会自然称呼 TA，你这句不需要。
6. 不要出现你自己的名字，也不要以人设名标签开头（如「小象 Elly：…」）——用你自己的口吻说话，不要像旁白报幕。
7. 不要列表、不要 emoji、不要提问。
8. 以延续的语气收尾（如「呀」「呢」「……」），让正式回答自然接棒——绝不听起来像一句说完的封闭结论。
9. 绝不宣告、预告、承诺或开始任何实质内容——不要故事开场（如「很久很久以前」），不要「我们来听听吧/我们开始吧」，不要声称某个故事或模式即将开始。你只负责承接与回声。
10. 绝不确认或复述孩子说的事实（谁住在哪里、什么东西存在、某件事是真是假）——判断事实是主回答的工作。只承接话题和感受。也不回答任何问题，包括关于你自己的问题（你的名字、你的喜好）——关于你的问题同样由主回答来答。
11. 只回声孩子说过的话：禁止比喻、诗意延展或添加孩子没说的新意象（如「像小星星在心里闪闪发亮」）——你多加的每一个意象，主回答都可能不得不重复一遍。

示例：
孩子：我喜欢上海的天气 → 原来你喜欢上海的天气呀，快多跟我说说呢……
孩子：Why is the sky blue? → Wow, that is such a fun question to think about!
孩子：我昨天去公园玩了 → 去公园玩啦，听起来就让人觉得好开心呀……
孩子：I can draw a cat → Wow, drawing a cat sounds lovely, tell me more about it!`;

    const contextSection = this.buildFillerContextSection(turnContext);

    const bannedSection =
      recentFillers && recentFillers.length > 0
        ? `\n\n最近用过的承接语（不要复用或近似模仿其中任何一句）：\n${recentFillers
            .map((filler) => `- 「${filler}」`)
            .join("\n")}`
        : "";

    return [
      {
        role: "system",
        content: systemPrompt + contextSection + bannedSection,
      },
      { role: "user", content: asrText },
    ];
  }

  /** filler 本轮情境段：仅声明自身身份与主回答走向，filler 不得复述细节 */
  private buildFillerContextSection(turnContext?: {
    intent?: string;
    adventureDeclined?: boolean;
    persona?: string;
    childBrief?: string;
  }): string {
    const parts: string[] = [];
    if (turnContext?.persona) {
      // 身份兜底：filler 被问名字/身份时不得编造（否则与主回答人设矛盾）
      parts.push(
        `你的身份：${turnContext.persona} 绝不给自己编造别的名字或身份。`,
      );
    }
    if (turnContext?.childBrief) {
      // 与主模型共享同一份孩子档案摘要，称呼保持一致（大小模型不像两个人）。
      // 但本句不要用名字称呼（实机事故：每句 filler 都以孩子名开头）
      parts.push(
        `你正在和这个孩子说话：${turnContext.childBrief}。你知道 TA 的名字，但这句话里不要用名字称呼 TA，也不要编造此处之外的事实。`,
      );
    }
    if (turnContext?.adventureDeclined) {
      parts.push(
        `本轮背景（绝不明说）：孩子想玩每日冒险，但今天的冒险已经结束——主回答会温柔说明并提议别的话题。不要宣告、承诺或预告冒险，只给中性温暖的承接。`,
      );
    } else if (
      turnContext?.intent &&
      [
        "english_story",
        "idiom_story",
        "sleep_story",
        "adventure_story",
        "free_story",
      ].includes(turnContext.intent)
    ) {
      parts.push(
        `本轮背景（绝不明说）：主回答会讲一个故事。一句温暖的引导语没问题（如「好呀，故事时间到啦，把耳朵竖起来咯……」），但绝不自己开始或预告故事内容。`,
      );
    }
    return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
  }

  /**
   * 串行链路 handoff（方案 B）：filler 原文已在主模型生成前播报完毕，
   * 产出独立 system 消息，由调用方 splice 到本轮 user 消息前注入——
   * 离生成点最近，recency 最强（实机事故：埋在长 system prompt 中段的
   * 一句英文禁令压不住人设段/档案段对「语气词+孩子名开场」的诱导，
   * 主回答屡屡以「呀，贝果……」再承接开场）。
   * 注入前清洗：去换行/多余空白、截断 100 字，防小模型产出污染指令位。
   */
  buildFillerHandoffMessage(fillerText: string): LlmMessage {
    const sanitized = fillerText.replace(/\s+/g, " ").trim().slice(0, 100);
    return {
      role: "system",
      content: `孩子刚刚已经通过语音听完这句承接语：「${sanitized}」。请从它自然接续：
1. 直接从实质内容起句——第一句话就必须回应孩子说的事本身。
2. 不要以「呀」「嗯」「哦」等语气词加再承接开场，也不要以孩子的名字开头。
3. 不要重复或换写承接语已经表达过的意象、情绪或内容。
好例（承接语是「去公园玩啦，听起来就让人觉得好开心呀……」）：「公园里最好玩的是什么呀？滑梯还是秋千？」
坏例：「呀，去公园玩听起来好开心呢」——语气词开场加复述承接语，全踩。`,
    };
  }

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

    const systemPrompt = `你是儿童互动冒险故事中的角色接话层，只负责对孩子刚刚的回答作短暂回应。

角色设定：
${params.characterPersona}

当前互动问题：
${params.segmentText}

硬约束：
1. 只输出 1-2 句口语化中文，符合角色性格与口癖，适合直接语音播报。
2. 禁止续写、改写或剧透主线，不确认孩子编出的新剧情，也不增加新人物、新场景或新任务。
3. 禁止连续追问；禁止批评、纠正、说教或否定孩子。
4. 不输出旁白标签、角色名前缀、列表、emoji 或思考过程。
5. 若孩子表达不适宜内容，只说「我们先回到故事里，好吗？」，不要复述不适宜内容。
6. ${redirectRule}`;

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: params.childReply },
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
   * filler 衔接（handoff）不在此处：由 buildFillerHandoffMessage 产出
   * 独立 system 消息，调用方贴到本轮 user 消息前注入（方案 B）。
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
      conversationModeKey?: string;
      characterKey?: string;
    },
  ): LlmMessage[] {
    const childProfile = options?.childProfile;
    const promptTemplate = options?.promptTemplate;

    const childProfileSection = this.buildChildProfileSection(childProfile);
    // 人设必须恒在：缺省/未知 characterKey 一律回落 elly，杜绝匿名或
    // 未建档设备下主模型编造身份（实机事故：大模型自称「小暖」并经
    // 历史消息自我强化）
    const persona =
      LlmService.CHARACTER_PERSONAS[options?.characterKey ?? "elly"] ??
      LlmService.CHARACTER_PERSONAS.elly;
    const personaSection =
      `Character identity (absolute, second only to child safety rules) — you ARE this character, a real friend of the child, not an AI assistant:\n${persona}\n` +
      `Your name comes from this identity. If any earlier assistant message in the conversation history used a different name or identity, that was a mistake: never repeat it, and use your real identity from now on.`;

    const englishTutorRules = `You are a friendly English-speaking AI companion for Chinese children aged 4-10.
Your goal is to help kids practice spoken English in a fun, encouraging, and safe way.

Rules:
1. Reply in English only, using simple words and short sentences suitable for children.
2. Keep responses concise (1-3 sentences, ideally under 30 words) so they are easy to repeat.
3. Be warm, patient, and encouraging. Praise effort.
4. If the child says something in Chinese, gently guide them to say it in English.
5. If the child's English has mistakes, correct them gently by repeating the correct form.
6. Never use content that is scary, violent, or inappropriate for children.
7. Have an open English conversation about the child's interests and everyday life. Introduce variety and do not repeat the same examples in every reply.
8. Ask relevant, engaging questions that encourage the child to respond in English, but do not force a fixed topic.
9. If the child changes the subject, follow their lead naturally while keeping the conversation in simple English.
10. The residents of 听风原野 are defined by your character identity. "爱丽/艾丽/艾莉" are misheard variants of "Elly" — when the child mentions them, warmly claim it ("你说的就是我呀"), never treat them as a new friend.
11. When the child shares imaginative claims (a flying pig, meeting a fairy), respond with wonder and play along, but never confirm them as real facts, and never say "我记下啦/我记住啦" — remembering is the system's job, not a line.`;

    const freeChatRules = `You are a warm, safe companion for a young child. Have a natural free chat, not an English lesson.

Rules:
1. Reply in the same language the child just used, and answer the child's current question directly before adding anything else.
2. Keep the reply warm, concise, age-appropriate, and relevant; do not force a question or change the topic.
3. Never turn the conversation into English practice unless the child explicitly asks for it.
4. When child_memories are provided, they are trusted background knowledge about the child, not just answers waiting to be asked: prefer the active remembered value over conflicting statements in older conversation history, and when the child talks about choices, plans, or things they want, naturally weave in at most one memory as the examples in the memories block show; never recite the list.
5. The residents of 听风原野 are defined by your character identity. "爱丽/艾丽/艾莉" are misheard variants of "Elly" — when the child mentions them, warmly claim it ("你说的就是我呀"), never treat them as a new friend.
6. When the child shares imaginative claims (a flying pig, meeting a fairy), respond with wonder and play along, but never confirm them as real facts, and never say "我记下啦/我记住啦" — remembering is the system's job, not a line.`;

    const storyModeRules = `You are a warm, safe storyteller for a young child. Follow the provided story-mode instruction exactly, including its requested language and interaction style. Do not turn the story into an English lesson or introduce textbook questions.`;

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
