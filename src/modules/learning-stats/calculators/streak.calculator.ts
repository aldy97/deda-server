import {
  MetricCalculator,
  ConversationWithDevice,
} from "./metric-calculator.interface";

export class StreakCalculator implements MetricCalculator<number> {
  calculate(conversations: ConversationWithDevice[]): number {
    const dates = new Set<string>();

    for (const conv of conversations) {
      if (!conv.spokeAt) continue;
      dates.add(this.toDateString(new Date(conv.spokeAt)));
    }

    if (dates.size === 0) return 0;

    const sorted = Array.from(dates).sort().reverse();
    let streak = 0;
    const today = this.toDateString(new Date());
    const yesterday = this.toDateString(
      new Date(Date.now() - 24 * 60 * 60 * 1000),
    );

    // 如果今天或昨天没有活动，则 streak 为 0
    if (sorted[0] !== today && sorted[0] !== yesterday) {
      return 0;
    }

    let checkDate = sorted[0];
    for (const date of sorted) {
      if (date === checkDate) {
        streak++;
        checkDate = this.previousDate(checkDate);
      } else {
        break;
      }
    }

    return streak;
  }

  private toDateString(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  private previousDate(dateStr: string): string {
    const date = new Date(dateStr + "T00:00:00");
    date.setDate(date.getDate() - 1);
    return this.toDateString(date);
  }
}
