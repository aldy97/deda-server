/**
 * 二选一确定性匹配与 LLM 判定结果解析：纯函数，无副作用，不依赖 Nest/DB/LLM。
 *
 * matchChoiceDeterministic 规则：
 * 1. 只看选项文案 `text`；`key` 是内容作者填的内部标识，**绝不参与识别**。
 * 2. 零命中或多命中（孩子同时提到两个选项）→ 放弃确定性结论，交上层 LLM 判定。
 * 3. 唯一命中时做否定守卫：若命中词前 4 字窗口内出现「不/别/甭/勿」任一否定字
 *    → 放弃结论（确定性层无法可靠区分"去河边"与"不去河边"）。
 *
 * parseChoiceVerdict 解析小模型判定结果：第一行必须严格为 "0" / "1" / "NONE"；
 * 其余行作为引回话术（redirectText）。越界数字视为不可信，与垃圾输入同等处理。
 *
 * 歧义与否定场景判定失败后返回 null，由上层决定走跑题引回还是 LLM 兜底。
 */

export interface MatchableChoice {
  text: string;
  reply?: string;
  /** 内部标识，本函数绝不读取。 */
  key?: string;
}

export interface ChoiceVerdict {
  index: number | null;
  redirectText: string;
}

const NEGATION_LOOKBEHIND_CHARS = 4;

const NEGATION_MARKERS = ["不", "别", "甭", "勿"];

/**
 * 确定性匹配：只在「唯一命中且无否定」时给出结论，其余一律返回 null。
 *
 * @returns 唯一命中的选项下标，或 null 表示无法确定性判定。
 */
export function matchChoiceDeterministic(
  choices: readonly MatchableChoice[],
  asrText: string,
): number | null {
  if (typeof asrText !== "string" || asrText.trim().length === 0) {
    return null;
  }

  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const hitIndices: number[] = [];

  for (let i = 0; i < choices.length; i++) {
    const choiceText = choices[i].text?.trim();
    if (!choiceText) {
      // 空文案选项跳过，避免 "任何话".includes("") 恒真
      continue;
    }
    if (asrText.indexOf(choiceText) !== -1) {
      hitIndices.push(i);
    }
  }

  if (hitIndices.length !== 1) {
    // 0 命中 = 听不懂；≥2 命中 = 歧义；都不取第一个
    return null;
  }

  const hitIndex = hitIndices[0];
  const choiceText = choices[hitIndex].text.trim();
  const matchPos = asrText.indexOf(choiceText);

  // 否定守卫：检查命中位置前 4 个字符的窗口
  const lookStart = Math.max(0, matchPos - NEGATION_LOOKBEHIND_CHARS);
  const lookWindow = asrText.slice(lookStart, matchPos);

  for (const marker of NEGATION_MARKERS) {
    if (lookWindow.includes(marker)) {
      return null;
    }
  }

  return hitIndex;
}

/**
 * 解析小模型二选一判定结果。
 *
 * 契约（fail-safe 优先，判不准一律 null）：
 * - 第一行 trim 后严格等于 "0" 或 "1" 且在 [0, choiceCount) 内 → index = 该数字，
 *   redirectText = 第一行之后的内容（\\n 连接后 trim）
 * - 第一行为 "NONE"（大小写不敏感）→ index = null，redirectText = 第一行之后的内容
 * - 其他任何值（越界数字、乱码、空行开头）→ index = null，redirectText = ""（丢弃原始文本，上层落到 fallbackText）
 * - 入参非字符串或全空白 → index = null, redirectText = ""
 *
 * @param raw 小模型原始输出文本
 * @param choiceCount 选项数量，用于越界防御
 */
export function parseChoiceVerdict(
  raw: unknown,
  choiceCount: number,
): ChoiceVerdict {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { index: null, redirectText: "" };
  }

  const lines = raw.split("\n");
  const firstLine = (lines[0] ?? "").trim();

  if (firstLine === "0" || firstLine === "1") {
    const parsed = Number(firstLine);
    if (parsed >= 0 && parsed < choiceCount) {
      const rest = lines.slice(1).join("\n").trim();
      return { index: parsed, redirectText: rest };
    }
  }

  if (firstLine.toUpperCase() === "NONE") {
    const rest = lines.slice(1).join("\n").trim();
    return { index: null, redirectText: rest };
  }

  return { index: null, redirectText: "" };
}
