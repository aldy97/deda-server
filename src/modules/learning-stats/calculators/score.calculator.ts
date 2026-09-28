/**
 * 启发式英文开口分（0-100）。
 * 现阶段无发音/语法评分管线,用可观测代理指标估算：
 * - 英文占比 = 英文消息数 / 总消息数（拉丁字母占非空白字符 ≥60% 判为英文）,权重 70
 * - 英文丰富度 = min(英文消息平均词数 / 8, 1),权重 30
 * 无任何 user 内容时返回 null（前端不显示分数）。
 * TODO: 接入真实发音/语法评分后替换本实现。
 */
export class ScoreCalculator {
  private static readonly ENGLISH_CHAR_RATIO = 0.6;
  private static readonly WORD_COUNT_TARGET = 8;

  calculate(messages: Array<{ content: string }>): number | null {
    if (messages.length === 0) return null;

    let englishTurns = 0;
    let englishWords = 0;

    for (const m of messages) {
      const words = m.content.match(/[A-Za-z]+/g) ?? [];
      const nonSpace = m.content.replace(/\s/g, "");
      const latinChars = (m.content.match(/[A-Za-z]/g) ?? []).length;
      const isEnglish =
        nonSpace.length > 0 &&
        latinChars / nonSpace.length >= ScoreCalculator.ENGLISH_CHAR_RATIO;

      if (isEnglish) {
        englishTurns += 1;
        englishWords += words.length;
      }
    }

    const englishRatio = englishTurns / messages.length;
    const avgWords = englishTurns > 0 ? englishWords / englishTurns : 0;
    const wordScore = Math.min(avgWords / ScoreCalculator.WORD_COUNT_TARGET, 1);

    return Math.round(englishRatio * 70 + wordScore * 30);
  }
}
