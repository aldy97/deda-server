import { Injectable, Logger } from "@nestjs/common";
import { LlmService } from "@/modules/llm/llm.service";

/**
 * 儿童安全分层过滤（L1 正则闸 + L2 小模型分类）。
 *
 * 分层职责：
 * - L1：零延迟确定性拦截「显式敏感词」。只收**无论如何都不适合幼儿**的露骨词
 *   （性行为、自杀/自残明示、血腥暴力明示），中英文。
 *   校准原则：孩子的情绪气话不触发 L1 —— 例如「我要杀了我的弟弟」表达的是
 *   嫉妒/愤怒等情绪，刻意不放裸「杀 / 打 / 揍 / 枪 / 刀 / 去死」等字样，
 *   这类表达交给 L2 识别为 emotional_harm，由 L3 大模型共情回应。
 * - L2：小模型安全分类，补 L1 的语义盲区（绕开字面的敏感表达），并把
 *   攻击性气话识别为 emotional_harm（不拦截，走共情引导）。
 * - L3（在 llm.service）：大模型 system prompt 常驻儿童安全硬约束，
 *   作为 L1/L2 失效时的兜底。
 *
 * 可观测性：verdict 带 source 字段，把「放行」拆成三种可区分的结论——
 * 模型明确判 safe（l2_model）、模型响应但标签不合契约（l2_invalid_label）、
 * 模型调用异常（l2_fail_open）。后两者都是静默降级，必须在看板上单独计数，
 * 否则「安全放行」与「小模型挂了裸奔」会是同一个数字。
 */

export type BlockedSafetyCategory = "sexual" | "violence" | "self_harm";
/**
 * safe = L2 明确判定安全，与 null（未能判定）严格区分。
 * 曾经 safe 被折叠成 null，导致「模型判定安全」与「模型挂了裸奔」不可分辨。
 */
export type SafetyCategory = BlockedSafetyCategory | "emotional_harm" | "safe";

/**
 * verdict 的来源，决定看板上如何解读 category：
 * - l1_regex：L1 正则闸。命中即拦截；未命中时该 verdict 不落库
 *   （编排会继续走 L2，最终 source 由 L2 决定）。
 * - l2_model：小模型给出合法标签（含 safe）。
 * - l2_invalid_label：小模型有响应但标签无法解析 → 放行。属**需要盯的静默降级**，
 *   计数升高说明 prompt 退化或模型漂移。
 * - l2_fail_open：小模型调用异常 → 放行，由 L3 大模型 prompt 兜底。
 * - not_evaluated：本轮未做 L2（如冒险状态机在编排上早于 L2 接管）。
 */
export type SafetySource =
  | "l1_regex"
  | "l2_model"
  | "l2_invalid_label"
  | "l2_fail_open"
  | "not_evaluated";

export interface SafetyVerdict {
  /** true = 不走大模型，直接用兜底话术 */
  blocked: boolean;
  category: SafetyCategory | null;
  layer: "L1" | "L2" | null;
  source: SafetySource;
  /** L1 命中词，仅用于日志与排查 */
  matched?: string;
}

/** L2 的危险标签：允许子串容错匹配（模型可能带解释文字） */
const DANGER_LABELS = [
  "self_harm",
  "emotional_harm",
  "sexual",
  "violence",
] as const;

const CN_SEXUAL = [
  "做爱",
  "性交",
  "性爱",
  "口交",
  "色情",
  "淫秽",
  "黄片",
  "毛片",
  "A片",
  "a片",
  "裸照",
  "裸体",
  "全裸",
  "阴部",
  "阴茎",
  "阴道",
  "强奸",
  "强暴",
  "性侵",
  "非礼",
];

const CN_SELF_HARM = [
  "自杀",
  "自尽",
  "自残",
  "割腕",
  "上吊",
  "跳楼",
  "跳河",
  "跳桥",
  "服毒",
  "轻生",
  "自我了断",
  "结束自己的生命",
  "不想活",
  "想死",
  "活不下去",
  "死了算了",
];

// 暴力 L1 只收露骨/血腥明示词；「杀了我弟弟」「打死你」等气话刻意不收
const CN_VIOLENCE = [
  "杀人",
  "谋杀",
  "凶杀",
  "砍人",
  "砍死",
  "捅人",
  "捅死",
  "分尸",
  "碎尸",
  "屠杀",
  "血洗",
  "炸弹",
  "炸药",
  "恐怖袭击",
  "枪击",
  "扫射",
  "枪杀",
  "绑架",
  "劫持",
  "虐待",
  "虐杀",
  "下毒",
  "投毒",
  "纵火",
];

// 英文一律按词边界匹配，避免 Essex/assistant 之类的子串误伤
const EN_SEXUAL = [
  "sex",
  "sexual",
  "porn",
  "pornography",
  "naked",
  "nude",
  "nudity",
  "penis",
  "vagina",
  "vulva",
  "orgasm",
  "masturbate",
  "masturbation",
  "fuck",
  "fucking",
  "dick",
  "pussy",
  "boobs",
  "tits",
  "rape",
  "rapist",
  "molest",
  "molestation",
];

const EN_SELF_HARM = [
  "suicide",
  "suicidal",
  "kill myself",
  "killing myself",
  "want to die",
  "wanna die",
  "self-harm",
  "self harm",
  "cut myself",
  "cutting myself",
  "end my life",
  "end my own life",
];

const EN_VIOLENCE = [
  "murder",
  "manslaughter",
  "homicide",
  "massacre",
  "bomb",
  "bombing",
  "terrorist",
  "terrorism",
  "behead",
  "decapitate",
  "kidnap",
  "kidnapping",
  "hostage",
  "arson",
  "torture",
  "kill people",
  "kill someone",
  "shoot people",
  "school shooting",
];

function buildCnRegex(words: string[]): RegExp {
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("|"));
}

function buildEnRegex(words: string[]): RegExp {
  const escaped = words
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    // 按字母数降序，保证 "kill myself" 先于 "kill" 类短词被尝试
    .sort((a, b) => b.length - a.length);
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

const L1_RULES: Array<{
  category: BlockedSafetyCategory;
  pattern: RegExp;
}> = [
  { category: "sexual", pattern: buildCnRegex(CN_SEXUAL) },
  { category: "self_harm", pattern: buildCnRegex(CN_SELF_HARM) },
  { category: "violence", pattern: buildCnRegex(CN_VIOLENCE) },
  { category: "sexual", pattern: buildEnRegex(EN_SEXUAL) },
  { category: "self_harm", pattern: buildEnRegex(EN_SELF_HARM) },
  { category: "violence", pattern: buildEnRegex(EN_VIOLENCE) },
];

const BLOCKED_CATEGORIES: BlockedSafetyCategory[] = [
  "sexual",
  "violence",
  "self_harm",
];

const CANNED_REPLIES: Record<BlockedSafetyCategory, string> = {
  self_harm:
    "听到你这么说，我有点担心你。不管发生了什么，都可以告诉爸爸妈妈或者你身边信任的大人，他们会帮助你的。我也会一直在这里陪着你。",
  sexual:
    "这个问题呀，等你长大一点，让爸爸妈妈慢慢告诉你，他们会讲得比我好。我们来聊点别的吧，你今天玩了什么好玩的呀？",
  violence:
    "这个话题不适合小朋友聊哦。如果你有生气或者难过的事，可以告诉我发生了什么，也可以告诉爸爸妈妈。我们聊点开心的吧？",
};

@Injectable()
export class ChildSafetyService {
  /**
   * emotional_harm 不拦截，注入大模型 system 引导：
   * 先共情、温和询问发生了什么，绝不附和伤害性内容。
   */
  static readonly EMOTIONAL_HARM_GUIDANCE =
    "孩子刚才的话带有攻击性或负面情绪（例如和家人、同伴发生冲突后的气话）。" +
    "请先共情孩子的感受，温和地询问发生了什么" +
    "（例如「是不是和弟弟吵架了呀？」「是不是有人欺负你了呀？」），" +
    "绝不附和、鼓励或复述任何伤害性内容，不批评、不说教；" +
    "等孩子情绪平复后，自然引导到积极的话题。";

  private readonly logger = new Logger(ChildSafetyService.name);

  constructor(private readonly llmService: LlmService) {}

  /** L1：显式敏感词正则闸，零延迟、确定性 */
  checkL1(text: string): SafetyVerdict {
    for (const rule of L1_RULES) {
      const match = rule.pattern.exec(text);
      if (match) {
        return {
          blocked: true,
          category: rule.category,
          layer: "L1",
          source: "l1_regex",
          matched: match[0],
        };
      }
    }
    // 未命中：source 仍标 l1_regex（本层已评估）。该 verdict 不落库——
    // 编排会继续走 L2，最终入库的 source 由 L2 决定。
    return {
      blocked: false,
      category: null,
      layer: null,
      source: "l1_regex",
    };
  }

  /**
   * L2：小模型安全分类，补 L1 的语义盲区。
   * 失败时放行（fail-open）：L3 大模型 prompt 常驻安全规则是兜底。
   */
  async classifyL2(
    asrText: string,
    deviceId?: string,
    turnId?: string,
  ): Promise<SafetyVerdict> {
    try {
      const result = await this.llmService.complete({
        scene: "safety_l2",
        deviceId,
        turnId,
        model: this.llmService.smallModelName,
        temperature: 0,
        maxTokens: 10,
        messages: [
          {
            role: "system",
            content:
              "你是儿童语音产品的安全分类器。只输出一个标签，禁止解释：" +
              "safe（安全内容）；" +
              "sexual（性、色情、隐私部位相关的话题或提问）；" +
              "violence（真实暴力话题、暴力方法、血腥内容，或索要伤害他人的方法）；" +
              "self_harm（自杀、自残、轻生、不想活等自我伤害信号）；" +
              "emotional_harm（孩子因愤怒、嫉妒、委屈等情绪说出的攻击性气话，" +
              "例如「我要杀了我弟弟」「我打死你」，重点是情绪宣泄而非真实暴力意图）。" +
              "判断原则：气话和情绪宣泄一律归为 emotional_harm；" +
              "只有真正涉及暴力内容本身才归 violence。" +
              "孩子表达含糊时按字面选择最接近的标签。",
          },
          { role: "user", content: `孩子的话：${asrText}` },
        ],
      });
      const text = result.text.trim().toLowerCase();
      // safe 只接受精确匹配：子串匹配会把 "unsafe" / "not safe" 读成放行，
      // 方向恰好错反。prompt 要求「只输出一个标签」且 temperature=0，
      // 精确匹配是主流形态。
      if (text === "safe") {
        return {
          blocked: false,
          category: "safe",
          layer: "L2",
          source: "l2_model",
        };
      }
      // 危险标签允许子串容错（模型可能带「标签：」前缀或句号）
      const danger = DANGER_LABELS.find((label) => text.includes(label));
      if (danger) {
        return {
          blocked: (BLOCKED_CATEGORIES as readonly string[]).includes(danger),
          category: danger,
          layer: "L2",
          source: "l2_model",
        };
      }
      // 有响应但标签不合契约（含否定式、乱码）：放行但标记为可观测的静默降级。
      // 只记标签不记 asrText——孩子的话属 PII，不得进日志。
      this.logger.warn(
        `Child safety L2 returned unparsable label, passing through: ${text.slice(0, 40)}`,
      );
      return {
        blocked: false,
        category: null,
        layer: "L2",
        source: "l2_invalid_label",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Child safety L2 classification failed, fail-open to safe: ${message}`,
      );
      return {
        blocked: false,
        category: null,
        layer: null,
        source: "l2_fail_open",
      };
    }
  }

  cannedReply(category: BlockedSafetyCategory): string {
    return CANNED_REPLIES[category];
  }
}
