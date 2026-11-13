import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Test } from "@nestjs/testing";
import type { Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";
import { LlmService } from "@/modules/llm/llm.service";
import { ChildSafetyService } from "@/modules/vendor/child-safety.service";
import { ConversationSessionService } from "@/modules/vendor/conversation-session.service";
import { ChildMemoriesService } from "@/modules/child-memories/child-memories.service";
import { SleepConfigsService } from "@/modules/sleep-configs/sleep-configs.service";
import { SleepVoiceConfigService } from "@/modules/sleep-configs/sleep-voice-config.service";
import { PromptRegistryService } from "./prompt-registry.service";

/**
 * 黄金等价测试：prompt 聚合重构的安全网。
 *
 * __fixtures__/prompt-goldens.json 是重构前（见 meta.sourceCommit）用一次性脚本
 * 冻结的 46 组运行时真实输出。本文件断言重构后的代码在同样入参下产出
 * **逐字节相同**的结果——任何 prompt 文本、拼接顺序、空行、标点的意外变动都会在这里红。
 *
 * 例外：intent_classify_system 一条在 rebase 到 origin/staging 时按上游最新正文
 * 重新冻结（上游在本重构之外单独改过该 prompt），来源提交见 meta.intentClassifySystemRefrozenAt。
 *
 * 全部服务通过 Nest testing module 构造，并把 PromptRegistryService 一并注入：
 * 重构前它是多余的 provider（被忽略），重构后它被真正注入。
 * 因此本文件在重构前后都无需修改断言。
 *
 * registry 使用「DB 永远为空」的 prisma 替身 → 全部 key 走代码默认值，
 * 这正是「首次上线行为零变化」要证明的路径。
 */

interface GoldenMessages {
  role: string;
  content: string;
}

type GoldenCase = GoldenMessages[] | string | number;

interface GoldenFile {
  meta: {
    /** 冻结这批基线时的提交 */
    sourceCommit: string;
    /** rebase 时按上游最新正文重新冻结过 intent_classify_system 一条，此为其来源提交 */
    intentClassifySystemRefrozenAt?: string;
    note?: string;
  };
  cases: Record<string, GoldenCase>;
}

const GOLDENS: GoldenFile = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "prompt-goldens.json"), "utf8"),
) as GoldenFile;

const CHILD_PROFILE = {
  name: "张小贝",
  birthday: "2020-05-14",
  englishName: "Amy",
  gender: "female",
};

const HISTORY = [
  { role: "user" as const, content: "我今天画画了" },
  { role: "assistant" as const, content: "哇，画了什么呀？" },
];

/** 冒险链路的人设是本地常量，本次不迁移；此处用与冻结脚本相同的字面量 */
const ADVENTURE_LOCAL_PERSONA = "小象 Elly：听风原野的居民（冒险链路本地常量）";

/** DB 恒空的 prisma 替身：registry 全部 key 回落代码默认值 */
function makeEmptyPrisma(): PrismaService {
  return {
    promptTemplate: { findMany: async () => [] },
    promptTemplateVersion: { findMany: async () => [] },
  } as unknown as PrismaService;
}

/** 捕获型 LlmService 替身：只记录 complete() 收到的 messages，不出网 */
function makeCapturingLlm(sink: { messages?: GoldenMessages[] }): LlmService {
  return {
    smallModelName: "qwen-flash",
    complete: async (options: { messages: GoldenMessages[] }) => {
      sink.messages = options.messages;
      return { text: "safe" };
    },
  } as unknown as LlmService;
}

async function compile<T>(
  target: new (...args: never[]) => T,
  providers: Provider[],
): Promise<T> {
  const moduleRef = await Test.createTestingModule({
    providers: [target, ...providers],
  }).compile();
  return moduleRef.get<T>(target);
}

const REGISTRY_PROVIDER = {
  provide: PromptRegistryService,
  useValue: new PromptRegistryService(makeEmptyPrisma()),
};

describe("prompt 黄金基线等价性", () => {
  it("基线来自重构前的提交，且用例数未意外减少", () => {
    expect(GOLDENS.meta.sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(GOLDENS.cases)).toHaveLength(46);
  });

  describe("filler：首响承接层 prompt", () => {
    let llm: LlmService;

    beforeAll(async () => {
      llm = await compile(LlmService, [
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PrismaService, useValue: {} },
        REGISTRY_PROVIDER,
      ]);
    });

    const cases: Array<[string, Parameters<LlmService["buildFillerPrompt"]>]> =
      [
        ["filler/minimal", ["我喜欢上海的天气", undefined, undefined]],
        [
          "filler/persona-and-child",
          [
            "我喜欢上海的天气",
            undefined,
            {
              persona: LlmService.CHARACTER_PERSONAS.elly,
              childBrief: LlmService.buildChildBrief(CHILD_PROFILE),
            },
          ],
        ],
        [
          "filler/adventure-declined",
          ["我想玩冒险", undefined, { adventureDeclined: true }],
        ],
        [
          "filler/story-intent",
          ["讲个故事", undefined, { intent: "sleep_story" }],
        ],
        [
          "filler/recent-fillers",
          [
            "我昨天去公园玩了",
            ["原来你喜欢上海的天气呀", "去公园玩啦"],
            undefined,
          ],
        ],
        [
          "filler/all-combined",
          [
            "Why is the sky blue?",
            ["Wow, that is such a fun question to think about!"],
            {
              intent: "english_story",
              persona: LlmService.CHARACTER_PERSONAS.polly,
              childBrief: LlmService.buildChildBrief(CHILD_PROFILE),
            },
          ],
        ],
        [
          "filler/empty-child-brief",
          ["你好", undefined, { childBrief: LlmService.buildChildBrief(null) }],
        ],
      ];

    it.each(cases)("%s 与基线逐字节一致", (id, args) => {
      expect(llm.buildFillerPrompt(...args)).toStrictEqual(GOLDENS.cases[id]);
    });
  });

  describe("adventure：角色接话层 prompt", () => {
    let llm: LlmService;

    beforeAll(async () => {
      llm = await compile(LlmService, [
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PrismaService, useValue: {} },
        REGISTRY_PROVIDER,
      ]);
    });

    it("open_question 与基线逐字节一致", () => {
      expect(
        llm.buildAdventureInteractionPrompt({
          characterPersona: ADVENTURE_LOCAL_PERSONA,
          segmentText:
            "你面前有两条路，一条通往风铃树，一条通往小溪。你想走哪一条呀？",
          childReply: "我想去看小溪！",
          kind: "open_question",
        }),
      ).toStrictEqual(GOLDENS.cases["adventure/open_question"]);
    });

    it("redirect 与基线逐字节一致", () => {
      expect(
        llm.buildAdventureInteractionPrompt({
          characterPersona: ADVENTURE_LOCAL_PERSONA,
          segmentText: "你面前有两条路，你想走哪一条呀？",
          childReply: "我昨天吃了一个很大的冰淇淋",
          kind: "redirect",
        }),
      ).toStrictEqual(GOLDENS.cases["adventure/redirect"]);
    });
  });

  describe("tutor：主对话 system prompt 全量组装", () => {
    let llm: LlmService;

    beforeAll(async () => {
      llm = await compile(LlmService, [
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PrismaService, useValue: {} },
        REGISTRY_PROVIDER,
      ]);
    });

    const cases: Array<
      [string, Parameters<LlmService["buildEnglishTutorPrompt"]>]
    > = [
      ["tutor/bare", ["What is a rainbow?"]],
      [
        "tutor/free_chat-with-profile",
        [
          "我画了一只猫",
          HISTORY,
          { mode: "free_chat", childProfile: CHILD_PROFILE },
        ],
      ],
      [
        "tutor/english_chat-with-template",
        [
          "Let us talk about animals",
          HISTORY,
          {
            mode: "english_chat",
            childProfile: CHILD_PROFILE,
            promptTemplate: "Use very simple vocabulary for a 5 year old.",
            conversationModeKey: "free_chat_casual",
          },
        ],
      ],
      [
        "tutor/story-mode",
        ["讲个睡前故事", undefined, { mode: "sleep_story" }],
      ],
      [
        "tutor/story-mode-idiom",
        ["讲个成语故事", undefined, { mode: "idiom_story" }],
      ],
      ["tutor/persona-polly", ["你好呀", undefined, { characterKey: "polly" }]],
      [
        "tutor/persona-unknown-fallback",
        ["你好呀", undefined, { characterKey: "nope" }],
      ],
      [
        "tutor/profile-all-null",
        [
          "你好",
          undefined,
          {
            childProfile: {
              name: null,
              birthday: null,
              englishName: null,
              gender: null,
            },
          },
        ],
      ],
      [
        "tutor/profile-male-no-birthday",
        ["你好", undefined, { childProfile: { name: "小明", gender: "male" } }],
      ],
      [
        // 生日格式非法（斜杠而非连字符）：ageFromBirthday 返回 null，
        // 故档案段只印 Birthday 原样字符串、不印 Age。用例名即由此而来。
        "tutor/bad-birthday",
        [
          "你好",
          undefined,
          { childProfile: { name: "小明", birthday: "2020/05/14" } },
        ],
      ],
      ["tutor/history-only", ["继续", HISTORY]],
      [
        "tutor/free_chat-null-profile",
        [
          "你好",
          undefined,
          {
            mode: "free_chat",
            childProfile: {
              name: null,
              birthday: null,
              englishName: null,
              gender: null,
            },
          },
        ],
      ],
    ];

    it.each(cases)("%s 与基线逐字节一致", (id, args) => {
      expect(llm.buildEnglishTutorPrompt(...args)).toStrictEqual(
        GOLDENS.cases[id],
      );
    });
  });

  describe("inline：四个业务 service 内联的小模型 prompt", () => {
    it("safety_l2_system 与基线逐字节一致", async () => {
      const sink: { messages?: GoldenMessages[] } = {};
      const safety = await compile(ChildSafetyService, [
        { provide: LlmService, useValue: makeCapturingLlm(sink) },
        REGISTRY_PROVIDER,
      ]);
      await safety.classifyL2("我讨厌我弟弟", "dev-1", "turn-1");
      expect(sink.messages).toStrictEqual(
        GOLDENS.cases["inline/safety_l2_system"],
      );
    });

    it("intent_classify_system 与基线逐字节一致", async () => {
      const sink: { messages?: GoldenMessages[] } = {};
      const session = await compile(ConversationSessionService, [
        { provide: PrismaService, useValue: {} },
        { provide: LlmService, useValue: makeCapturingLlm(sink) },
        // classify() 不读哄睡配置（门禁读配置在 readSleepConfig，由 resolveWithSource 调用），
        // 此处仅为满足上游 sleep-config-gate 之后新增的构造签名
        {
          provide: SleepConfigsService,
          useValue: { getByDeviceId: jest.fn().mockResolvedValue(null) },
        },
        REGISTRY_PROVIDER,
      ]);
      // classify 是私有方法：这里只验证它发出的 messages，不改动其可见性
      await (
        session as unknown as {
          classify: (
            asrText: string,
            deviceId?: string,
            turnId?: string,
          ) => Promise<unknown>;
        }
      ).classify("我想听睡前故事", "dev-1", "turn-1");
      expect(sink.messages).toStrictEqual(
        GOLDENS.cases["inline/intent_classify_system"],
      );
    });

    it("memory_extract_system 与基线逐字节一致", async () => {
      const sink: { messages?: GoldenMessages[] } = {};
      const memories = await compile(ChildMemoriesService, [
        {
          provide: PrismaService,
          useValue: { childMemory: { findMany: async () => [] } },
        },
        { provide: LlmService, useValue: makeCapturingLlm(sink) },
        REGISTRY_PROVIDER,
      ]);
      await memories.extractAndStore({
        deviceId: "dev-1",
        turnId: "turn-1",
        asrText: "我最喜欢恐龙",
        previousAssistant: "哇，你喜欢什么呀？",
        sourceOccurredAt: new Date("2026-11-13T00:00:00.000Z"),
      });
      expect(sink.messages).toStrictEqual(
        GOLDENS.cases["inline/memory_extract_system"],
      );
    });

    it("sleep_config_extract_system 与基线逐字节一致", async () => {
      const sink: { messages?: GoldenMessages[] } = {};
      const sleepVoice = await compile(SleepVoiceConfigService, [
        { provide: SleepConfigsService, useValue: {} },
        { provide: LlmService, useValue: makeCapturingLlm(sink) },
        REGISTRY_PROVIDER,
      ]);
      await (
        sleepVoice as unknown as {
          extract: (
            deviceInternalId: string,
            asrText: string,
          ) => Promise<unknown>;
        }
      ).extract("dev-1", "哄睡改成20分钟");
      expect(sink.messages).toStrictEqual(
        GOLDENS.cases["inline/sleep_config_extract_system"],
      );
    });
  });

  describe("story：故事意图话术（原两份重复副本）", () => {
    const registry = new PromptRegistryService(makeEmptyPrisma());
    const intents = [
      "english_story",
      "idiom_story",
      "sleep_story",
      "adventure_story",
      "free_story",
    ];

    it.each(intents)("adapter 链路 %s 与基线逐字节一致", (intent) => {
      expect(registry.getStoryPrompt(intent)).toStrictEqual(
        GOLDENS.cases[`story/adapter/${intent}`],
      );
    });

    it.each(intents)(
      "adapter 链路 %s + 最爱类型 与基线逐字节一致",
      (intent) => {
        expect(registry.getStoryPrompt(intent, "恐龙")).toStrictEqual(
          GOLDENS.cases[`story/adapter/${intent}+favorite`],
        );
      },
    );

    it.each(intents)("vendor 链路 %s 与基线逐字节一致", (intent) => {
      expect(registry.getStoryPrompt(intent)).toStrictEqual(
        GOLDENS.cases[`story/vendor/${intent}`],
      );
    });

    it("非故事意图返回 undefined（基线中该用例值为 undefined，被 JSON 丢弃）", () => {
      expect(GOLDENS.cases["story/adapter/unknown"]).toBeUndefined();
      expect(registry.getStoryPrompt("sleep_config")).toBeUndefined();
    });
  });

  describe("filler 重试指令 / 人设 / 工具函数", () => {
    const registry = new PromptRegistryService(makeEmptyPrisma());

    it("filler_retry_instruction 与基线逐字节一致", () => {
      expect(registry.getTemplate("filler_retry_instruction")).toStrictEqual(
        GOLDENS.cases["filler/retry_instruction"],
      );
    });

    it("persona_elly 与基线逐字节一致（静态表与注册表同源）", () => {
      expect(LlmService.CHARACTER_PERSONAS.elly).toStrictEqual(
        GOLDENS.cases["persona/elly"],
      );
      expect(registry.getPersona("elly")).toStrictEqual(
        GOLDENS.cases["persona/elly"],
      );
    });

    it("persona_polly 与基线逐字节一致（静态表与注册表同源）", () => {
      expect(LlmService.CHARACTER_PERSONAS.polly).toStrictEqual(
        GOLDENS.cases["persona/polly"],
      );
      expect(registry.getPersona("polly")).toStrictEqual(
        GOLDENS.cases["persona/polly"],
      );
    });

    it("buildChildBrief / ageFromBirthday 口径未变", () => {
      expect(LlmService.buildChildBrief(CHILD_PROFILE)).toStrictEqual(
        GOLDENS.cases["util/childBrief"],
      );
      expect(LlmService.buildChildBrief(null)).toStrictEqual(
        GOLDENS.cases["util/childBrief-null"],
      );
      expect(LlmService.ageFromBirthday("2020-05-14")).toStrictEqual(
        GOLDENS.cases["util/ageFromBirthday"],
      );
    });
  });
});
