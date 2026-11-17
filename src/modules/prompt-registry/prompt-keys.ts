/** Prompt 注册表的 key 与分类枚举：新增可编辑 prompt 必须先在这里登记 */
export const PROMPT_KEYS = [
  // 小模型：分类与抽取
  "safety_l2_system",
  "intent_classify_system",
  "memory_extract_system",
  "sleep_config_extract_system",
  // 小模型：首响承接与冒险接话
  "filler_system",
  "filler_retry_instruction",
  "adventure_interaction_system",
  // 主模型规则段。以下两类刻意不在此列、永久硬编码：
  // - childSafetyRules（L3 儿童安全兜底，恒定追加在规则段之后）
  // - personaSection 身份包装文本（防身份漂移 guardrail，性质同 L3）
  "main_english_tutor_rules",
  "main_free_chat_rules",
  "main_story_mode_rules",
  // 故事话术
  "story_prompt_english",
  "story_prompt_idiom",
  "story_prompt_sleep",
  "story_prompt_free",
  "story_favorite_type_suffix",
  // 角色人设（主链路；冒险接话层的本地人设副本刻意不进注册表）
  "persona_elly",
  "persona_polly",
] as const;

export type PromptKey = (typeof PROMPT_KEYS)[number];

export const PROMPT_CATEGORIES = [
  "small_model",
  "main_rules",
  "story",
  "persona",
] as const;

export type PromptCategory = (typeof PROMPT_CATEGORIES)[number];

/** 变量契约：由代码定义，DB 里的 renderSchema 仅供 dashboard 展示，渲染时一律以代码为准 */
export interface PromptVariableSpec {
  name: string;
  /** true = 必须提供且非空；false = 缺省渲染为空串（用于可选拼接段） */
  required: boolean;
  description: string;
}
