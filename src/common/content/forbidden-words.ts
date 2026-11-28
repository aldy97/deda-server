/**
 * 儿童内容的禁用词底线。
 *
 * 唯一真相源：adventure-admin 的内容 lint 与 adventure-video 的分镜扫描
 * 都从这里取，避免两份词表漂移。
 *
 * 环境变量 ADVENTURE_LINT_FORBIDDEN_WORDS 只能**追加**（并集），
 * 不能删除或替换本表——安全下限不允许靠一次误配置清空。
 *
 * 匹配是子串（String.includes），所以一律用 ≥2 字的词；
 * 放单字会误伤正常表达（如「血」命中「血型」）。
 */
export const DEFAULT_FORBIDDEN_WORDS: readonly string[] = [
  // 血腥与伤害
  "血腥",
  "血迹",
  "鲜血",
  "流血",
  "尸体",
  // 死亡与自伤
  "死亡",
  "砍死",
  "打死",
  "虐待",
  "自杀",
  "割腕",
  "上吊",
  "服毒",
  // 恐怖
  "恐怖",
  "鬼魂",
  "厉鬼",
  // 成人 / 违法
  "色情",
  "毒品",
  "赌博",
  "裸体",
];

/** 解析 env 追加项：中英文逗号与换行都认，trim、去空。 */
export function parseForbiddenWordsOverride(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 默认表 + env 追加项（去重，默认项顺序优先）。env 永远删不掉默认项。 */
export function resolveForbiddenWords(raw?: string): string[] {
  const merged = [...DEFAULT_FORBIDDEN_WORDS];
  for (const word of parseForbiddenWordsOverride(raw)) {
    if (!merged.includes(word)) {
      merged.push(word);
    }
  }
  return merged;
}
