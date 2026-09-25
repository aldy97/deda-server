import {
  MetricCalculator,
  ConversationWithDevice,
} from "./metric-calculator.interface";

export interface ConversationMetrics {
  totalDurationMinutes: number;
  totalSessions: number;
  todayDurationMinutes: number;
  weekDurationMinutes: number;
}

/**
 * 估算规则：
 * - 每条 user/device 对话计 0.5 分钟（30 秒）。
 * - 一个 session 定义为有对话的一天。
 * 未来接入真实音频时长后替换为实际值。
 */
const MINUTES_PER_MESSAGE = 0.5;

export class ConversationMetricsCalculator implements MetricCalculator<ConversationMetrics> {
  calculate(conversations: ConversationWithDevice[]): ConversationMetrics {
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 6);

    const sessionDates = new Set<string>();
    let totalDurationMinutes = 0;
    let todayDurationMinutes = 0;
    let weekDurationMinutes = 0;

    for (const conv of conversations) {
      if (!conv.spokeAt) continue;

      const spokeAt = new Date(conv.spokeAt);
      const duration = MINUTES_PER_MESSAGE;

      totalDurationMinutes += duration;
      sessionDates.add(this.toDateString(spokeAt));

      if (spokeAt >= todayStart) {
        todayDurationMinutes += duration;
      }
      if (spokeAt >= weekStart) {
        weekDurationMinutes += duration;
      }
    }

    return {
      totalDurationMinutes: Math.round(totalDurationMinutes),
      totalSessions: sessionDates.size,
      todayDurationMinutes: Math.round(todayDurationMinutes),
      weekDurationMinutes: Math.round(weekDurationMinutes),
    };
  }

  private toDateString(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
}
