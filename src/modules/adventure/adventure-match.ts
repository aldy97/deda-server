/**
 * 二选一确定性匹配：纯函数，无副作用，不依赖 Nest/DB/LLM。
 *
 * 规则：
 * 1. 只看选项文案 `text`；`key` 是内容作者填的内部标识，**绝不参与识别**。
 * 2. 零命中或多命中（孩子同时提到两个选项）→ 放弃确定性结论，交上层 LLM 判定。
 * 3. 唯一命中时做否定守卫：若命中词前 4 字窗口内出现「不/别/甭/勿」任一否定字
 *    → 放弃结论（确定性层无法可靠区分"去河边"与"不去河边"）。
 *
 * 歧义与否定场景判定失败后返回 null，由上层决定走跑题引回还是 LLM 兜底。
 */

export interface MatchableChoice {
  text: string;
  reply?: string;
  /** 内部标识，本函数绝不读取。 */
  key?: string;
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
