export interface ChildMemoryRule {
  topics: string[];
  maxLength: number;
}

/** 代码即白名单：模型不能创造新槽位，也不能写入敏感档案。 */
export const CHILD_MEMORY_RULES = {
  favorite_color: {
    topics: ["颜色", "colour", "color", "画画"],
    maxLength: 30,
  },
  favorite_animal: {
    topics: ["动物", "恐龙", "小象", "小马", "animal"],
    maxLength: 30,
  },
  favorite_story_type: {
    topics: ["故事", "冒险", "成语", "story"],
    maxLength: 30,
  },
  preferred_interaction: {
    topics: ["聊天", "讲故事", "问答", "陪练", "互动"],
    maxLength: 30,
  },
  interest_topic: {
    topics: ["兴趣", "喜欢", "恐龙", "太空", "story"],
    maxLength: 30,
  },
} satisfies Record<string, ChildMemoryRule>;

export type ChildMemoryKey = keyof typeof CHILD_MEMORY_RULES;

export function isChildMemoryKey(key: string): key is ChildMemoryKey {
  return key in CHILD_MEMORY_RULES;
}

export const MAX_MEMORY_EXTRACTIONS_PER_TURN = 3;
