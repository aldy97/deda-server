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
 * MVP 阶段默认使用 DeepSeek-V3（deepseek-chat）。
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultTimeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl =
      this.configService.get<string>("OPENAI_BASE_URL") ||
      "https://api.deepseek.com/v1";
    this.apiKey = this.configService.get<string>("OPENAI_API_KEY") || "";
    this.model =
      this.configService.get<string>("OPENAI_MODEL") || "deepseek-chat";
    this.defaultTimeoutMs =
      Number(this.configService.get<string>("LLM_TIMEOUT_MS")) || 30000;
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
          model: this.model,
          messages: options.messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 512,
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
11. Avoid repeating the same job titles or example people (e.g., Nadiya Hussain, chef, TV presenter) in every reply. Use them only when truly relevant, and prefer open-ended questions that invite the child to speak.`;

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

  private buildChildProfileSection(
    childProfile?: {
      name?: string | null;
      birthday?: string | null;
      englishName?: string | null;
    },
  ): string {
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
