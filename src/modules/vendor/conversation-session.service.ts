import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";

export type ConversationIntent =
  | "free_chat"
  | "adventure_story"
  | "english_story"
  | "idiom_story"
  | "sleep_story"
  | "free_story";

type PersistentConversationMode = Extract<
  ConversationIntent,
  "english_story" | "idiom_story" | "sleep_story"
>;

const SESSION_TTL_MINUTES: Record<PersistentConversationMode, number> = {
  english_story: 20,
  idiom_story: 20,
  sleep_story: 45,
};

const CONVERSATION_INTENTS: ConversationIntent[] = [
  "free_chat",
  "adventure_story",
  "english_story",
  "idiom_story",
  "sleep_story",
  "free_story",
];

@Injectable()
export class ConversationSessionService {
  private readonly logger = new Logger(ConversationSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
  ) {}

  async resolve(
    deviceId: string,
    asrText: string,
  ): Promise<ConversationIntent> {
    const session = await this.prisma.conversationSession.findUnique({
      where: { deviceId },
    });
    const activeMode = this.persistentMode(session?.currentMode);

    if (session && activeMode) {
      if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) {
        await this.reset(deviceId);
      } else {
        if (this.isContinuation(asrText)) {
          await this.activate(deviceId, activeMode);
          return activeMode;
        }
        if (this.isExplicitModeSwitch(asrText)) {
          return this.classifyAndActivate(deviceId, asrText, true);
        }
        if (this.isExplicitExit(asrText)) {
          await this.reset(deviceId);
          return "free_chat";
        }

        // 故事作答、二选一和普通接话默认留在当前模式，并滑动续期。
        await this.activate(deviceId, activeMode);
        return activeMode;
      }
    }

    if (!this.isRoutingCandidate(asrText)) {
      return "free_chat";
    }
    return this.classifyAndActivate(deviceId, asrText, false);
  }

  async reset(deviceId: string): Promise<void> {
    await this.prisma.conversationSession.upsert({
      where: { deviceId },
      create: { deviceId, currentMode: "free_chat", expiresAt: null },
      update: { currentMode: "free_chat", expiresAt: null },
    });
  }

  private async classifyAndActivate(
    deviceId: string,
    asrText: string,
    hadActiveSession: boolean,
  ): Promise<ConversationIntent> {
    const intent = await this.classify(asrText);
    const persistentIntent = this.persistentMode(intent);
    if (persistentIntent) {
      await this.activate(deviceId, persistentIntent);
    } else if (hadActiveSession) {
      await this.reset(deviceId);
    }
    return intent;
  }

  private async classify(asrText: string): Promise<ConversationIntent> {
    // TODO(可用性)：灰度补充分类模型超时、限流与非法输出的真实指标。
    try {
      const result = await this.llmService.complete({
        model: this.llmService.smallModelName,
        temperature: 0,
        maxTokens: 10,
        messages: [
          {
            role: "system",
            content:
              "你是儿童语音产品的对话意图分类器。只输出一个标签，禁止解释：" +
              "free_chat（普通聊天）；adventure_story（每日互动冒险、续听或重听已播冒险）；" +
              "english_story（英语故事或英语口语陪练）；idiom_story（成语故事）；" +
              "sleep_story（哄睡故事，要求安静且不互动）；free_story（泛化听故事或自由创作故事）。" +
              "孩子表达含糊时按字面选择最接近标签。",
          },
          { role: "user", content: `孩子的话：${asrText}` },
        ],
      });
      const text = result.text.trim().toLowerCase();
      return (
        CONVERSATION_INTENTS.find((intent) => text.includes(intent)) ||
        this.fallbackIntent(asrText)
      );
    } catch (error) {
      this.logger.warn(
        `Conversation intent classification failed, keyword fallback used: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.fallbackIntent(asrText);
    }
  }

  private async activate(
    deviceId: string,
    currentMode: PersistentConversationMode,
  ): Promise<void> {
    const expiresAt = new Date(
      Date.now() + SESSION_TTL_MINUTES[currentMode] * 60_000,
    );
    await this.prisma.conversationSession.upsert({
      where: { deviceId },
      create: { deviceId, currentMode, expiresAt },
      update: { currentMode, expiresAt },
    });
  }

  private persistentMode(
    mode: string | null | undefined,
  ): PersistentConversationMode | null {
    return mode === "english_story" ||
      mode === "idiom_story" ||
      mode === "sleep_story"
      ? mode
      : null;
  }

  private isRoutingCandidate(asrText: string): boolean {
    return /故事|冒险|风铃树|再听一遍|继续讲|接着讲|哄睡|晚安|睡觉|story|adventure|sleep/i.test(
      asrText,
    );
  }

  private isContinuation(asrText: string): boolean {
    return /^(继续|接着讲|继续讲|再讲一个|再来一个|接着来|continue|go on)[啊呀呢吧。！!，, ]*$/i.test(
      asrText.trim(),
    );
  }

  private isExplicitModeSwitch(asrText: string): boolean {
    const hasModeTarget =
      /故事|冒险|英语|英文|成语|哄睡|睡觉|story|adventure|english|idiom|sleep/i.test(
        asrText,
      );
    return (
      hasModeTarget &&
      /想听|想玩|换成|切换|我要|给我讲|讲个|讲一个|哄睡|睡觉|listen to|tell me|switch/i.test(
        asrText,
      )
    );
  }

  private isExplicitExit(asrText: string): boolean {
    return /不想听|不要听|不玩了|停止|退出|结束|别讲了|stop|quit|exit/i.test(
      asrText,
    );
  }

  private fallbackIntent(asrText: string): ConversationIntent {
    if (/哄睡|睡觉|晚安|sleep/i.test(asrText)) {
      return "sleep_story";
    }
    if (/英语|英文|english/i.test(asrText)) {
      return "english_story";
    }
    if (/成语|idiom/i.test(asrText)) {
      return "idiom_story";
    }
    if (/冒险|风铃树|再听一遍|继续.*故事|接着.*故事/i.test(asrText)) {
      return "adventure_story";
    }
    return this.isRoutingCandidate(asrText) ? "free_story" : "free_chat";
  }
}
