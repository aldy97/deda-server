import {
  MetricCalculator,
  ConversationWithDevice,
} from "./metric-calculator.interface";

export interface TopicCoverage {
  topicCount: number;
  topics: Array<{
    key: string;
    mode: string;
    textbookId: string | null;
    unitId: string | null;
    conversationModeKey: string | null;
    count: number;
    lastSpokeAt: Date;
  }>;
}

export class TopicCoverageCalculator implements MetricCalculator<TopicCoverage> {
  calculate(conversations: ConversationWithDevice[]): TopicCoverage {
    const map = new Map<
      string,
      {
        mode: string;
        textbookId: string | null;
        unitId: string | null;
        conversationModeKey: string | null;
        count: number;
        lastSpokeAt: Date;
      }
    >();

    for (const conv of conversations) {
      if (!conv.spokeAt) continue;

      const key = this.buildKey(conv);
      const existing = map.get(key);
      if (existing) {
        existing.count++;
        if (new Date(conv.spokeAt) > existing.lastSpokeAt) {
          existing.lastSpokeAt = new Date(conv.spokeAt);
        }
      } else {
        map.set(key, {
          mode: conv.mode ?? "unknown",
          textbookId: conv.textbookId ?? null,
          unitId: conv.unitId ?? null,
          conversationModeKey: conv.conversationModeKey ?? null,
          count: 1,
          lastSpokeAt: new Date(conv.spokeAt),
        });
      }
    }

    const topics = Array.from(map.entries()).map(([key, value]) => ({
      key,
      ...value,
    }));

    topics.sort((a, b) => b.lastSpokeAt.getTime() - a.lastSpokeAt.getTime());

    return {
      topicCount: topics.length,
      topics,
    };
  }

  private buildKey(conv: ConversationWithDevice): string {
    // free_chat 按子模式分组;教材族按教材+单元分组
    return [conv.mode, conv.textbookId, conv.unitId, conv.conversationModeKey]
      .filter(Boolean)
      .join("|");
  }
}
