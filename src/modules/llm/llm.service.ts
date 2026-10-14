import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosError } from "axios";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompleteOptions {
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

  constructor(private readonly configService: ConfigService) {
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
    if (!this.apiKey) {
      this.logger.error("OPENAI_API_KEY is not configured");
      throw new Error("LLM API key is not configured");
    }

    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    try {
      this.logger.debug(
        `LLM request: model=${this.model}, messages=${JSON.stringify(options.messages)}`,
      );
      const response = await axios.post(
        url,
        {
          model: options.model ?? this.model,
          messages: options.messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 512,
          thinking: options.thinking ?? { type: "disabled" },
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: timeoutMs,
        },
      );

      const choice = response.data?.choices?.[0];
      const text = choice?.message?.content?.trim() || "";
      const usage = response.data?.usage;

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
      const message = axiosError.response?.data
        ? JSON.stringify(axiosError.response.data)
        : axiosError.message;
      this.logger.error(`LLM request failed: ${message}`);
      throw new Error(`LLM request failed: ${message}`);
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

    if (!effectiveApiKey) {
      this.logger.error(
        isSmallModel
          ? "SMALL_LLM_API_KEY is not configured"
          : "OPENAI_API_KEY is not configured",
      );
      throw new Error("LLM API key is not configured");
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
      const message = axiosError.response?.data
        ? JSON.stringify(axiosError.response.data)
        : axiosError.message;
      this.logger.error(`LLM stream request failed: ${message}`);
      throw new Error(`LLM request failed: ${message}`);
    }

    // SSE 解析：按行切分，跨网络包的不完整行留在 pending 里等下一段
    const stream = response.data as AsyncIterable<Buffer | string>;
    let pending = "";
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
          return;
        }

        let delta: unknown;
        try {
          delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
        } catch {
          // 半行 / 心跳等无法解析的数据直接跳过
          continue;
        }
        if (typeof delta === "string" && delta.length > 0) {
          yield delta;
        }
      }
    }
  }

  /**
   * 构建首响「打哈哈」prompt（小模型用）
   * 业内 filler 写法要点：明确角色定位（只为正式回答争取时间）、
   * 语言跟随用户、极短、禁止实质回答、措辞多样化，并给 few-shot 示例。
   * 不带教材上下文与历史，避免小模型展开真正回答。
   */
  buildFillerPrompt(asrText: string): LlmMessage[] {
    const systemPrompt = `You are the fast first-response layer of a voice chat companion for children. Your only job is to buy time for the main reply: instantly produce ONE short, warm sentence that acknowledges or echoes what the child just said, so the child feels heard.

Rules:
1. Reply in the same language the child just used.
2. Keep it under 20 words, in a natural spoken style.
3. Never answer the question or provide real content — the main reply comes later.
4. Echo the child's topic keywords so it feels personal, and vary your wording — never reuse the same opener twice in a row.
5. No lists, no emojis, no questions.
6. End with a trailing, transitional tone (e.g. "呀", "呢", "...") so the main reply can take over naturally — never sound like a finished, closed statement.
7. Never shorter than at least 10 characters in Chinese or at least 6 words in English — your sentence is spoken aloud as audio cover while the main reply is being prepared, and a too-short utterance leaves dead air.

Examples:
Child: 我喜欢上海的天气 → 原来你喜欢上海的天气呀
Child: Why is the sky blue? → That is such a fun question!
Child: 我昨天去公园玩了 → 去公园玩听起来好开心呀
Child: I can draw a cat → Wow, drawing a cat sounds lovely!`;

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: asrText },
    ];
  }

  /**
   * 构建儿童英语陪练 prompt
   * @param asrText 当前用户输入
   * @param context 教材单元上下文
   * @param unitName 单元名称
   * @param history 同设备同教材同单元的最近对话历史
   * @param options 扩展选项：孩子档案、模式/教材 prompt 模板
   */
  buildEnglishTutorPrompt(
    asrText: string,
    context: string,
    unitName?: string,
    history?: Array<{ role: "user" | "assistant"; content: string }>,
    options?: {
      childProfile?: {
        name?: string | null;
        birthday?: string | null;
        englishName?: string | null;
      };
      promptTemplate?: string;
      mode?: string;
      conversationModeKey?: string;
    },
  ): LlmMessage[] {
    const childProfile = options?.childProfile;
    const promptTemplate = options?.promptTemplate;

    const childProfileSection = this.buildChildProfileSection(childProfile);

    const defaultRules = `You are a friendly English-speaking AI companion for Chinese children aged 4-10.
Your goal is to help kids practice spoken English in a fun, encouraging, and safe way.

Rules:
1. Reply in English only, using simple words and short sentences suitable for children.
2. Keep responses concise (1-3 sentences, ideally under 30 words) so they are easy to repeat.
3. Be warm, patient, and encouraging. Praise effort.
4. If the child says something in Chinese, gently guide them to say it in English.
5. If the child's English has mistakes, correct them gently by repeating the correct form.
6. Never use content that is scary, violent, or inappropriate for children.
7. When a textbook context is provided, use the unit topic and key sentences as a starting point, but do NOT repeat the same facts over and over. Introduce variety by exploring different angles, related words, and imaginative connections within the unit theme.
8. Always end your reply with a question that is relevant to the unit topic, especially those topics that are not covered yet in the conversation, encouraging the child to respond in English.
9. If the child does not answer your engaging question, smoothly shift to another aspect of the same unit. For example, ask about different jobs, describe what people do, or invite the child to imagine their own future job.
10. IMPORTANT: If the child's answer seems off-topic, do NOT just say "let's go back." Instead, make a friendly, creative bridge back to the unit. For example, if the unit is about jobs and the child says "I want to play football," you can say "Playing football is fun! Do you want to be a football player when you grow up?" This keeps the conversation in the unit while honoring what the child said.
11. Avoid repeating the same job titles or example people (e.g., Nadiya Hussain, chef, TV presenter) in every reply. Use them only when truly relevant, and prefer open-ended questions that invite the child to speak.
12. The child has just heard a short warm acknowledgment of what they said (played by a separate fast-response channel). Do NOT repeat greetings or acknowledgments (e.g. "Oh, you like...") — go straight into your reply content so the two parts sound like one natural utterance.`;

    const rulesSection = promptTemplate
      ? `In addition, always follow these general rules:\n${defaultRules}`
      : defaultRules;

    const templateSection = promptTemplate
      ? `${promptTemplate}\n\n${rulesSection}`
      : rulesSection;

    const contextSection = context
      ? `Current textbook context (${unitName || "selected unit"}):\n"""\n${context}\n"""`
      : "No specific textbook context is selected. Have a free English chat with the child.";

    const systemPrompt = [childProfileSection, templateSection, contextSection]
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
  }): string {
    if (!childProfile) {
      return "";
    }

    const name = childProfile.name || "the child";
    const birthday = childProfile.birthday || "not provided";
    const englishName = childProfile.englishName || "not provided";

    if (
      !childProfile.name &&
      !childProfile.birthday &&
      !childProfile.englishName
    ) {
      return "";
    }

    return `Child Profile:
- Name: ${name}
- Birthday: ${birthday}
- English Name: ${englishName}

Please address the child using their name or English name when appropriate.`;
  }
}
