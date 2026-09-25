import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DashboardDto,
  DailyTrendPoint,
  TopicBreakdownItem,
  TimelineEvent,
  UnitProgressItem,
} from "./dto/learning-stats.dto";
import { ConversationMetricsCalculator } from "./calculators/conversation-metrics.calculator";
import { StreakCalculator } from "./calculators/streak.calculator";
import { TopicCoverageCalculator } from "./calculators/topic-coverage.calculator";

interface ActiveConfig {
  deviceId: string;
  mode: string;
  textbookId: string | null;
  unitId: string | null;
  conversationModeKey: string | null;
}

@Injectable()
export class LearningStatsService {
  private readonly metricsCalculator = new ConversationMetricsCalculator();
  private readonly streakCalculator = new StreakCalculator();
  private readonly topicCalculator = new TopicCoverageCalculator();

  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(userId: string, deviceId?: string): Promise<DashboardDto> {
    const { deviceMap, internalIds } = await this.getUserDevices(
      userId,
      deviceId,
    );

    if (internalIds.length === 0) {
      return {
        totalDurationMinutes: 0,
        totalSessions: 0,
        activeDeviceCount: 0,
        boundDeviceCount: 0,
        continuousDays: 0,
        topicCount: 0,
        devices: [],
      };
    }

    const activeConfigs = await this.getActiveConfigs(internalIds);
    const conversations = await this.getConversations(
      internalIds,
      activeConfigs,
    );

    const allMetrics = this.metricsCalculator.calculate(conversations);
    const topicCoverage = this.topicCalculator.calculate(conversations);

    const devices: DashboardDto["devices"] = [];
    for (const [externalId, internalId] of deviceMap.entries()) {
      const deviceConversations = conversations.filter(
        (c) => c.deviceId === internalId,
      );
      const metrics = this.metricsCalculator.calculate(deviceConversations);
      const streak = this.streakCalculator.calculate(deviceConversations);
      const topics = this.topicCalculator.calculate(deviceConversations);
      const activeConfig = activeConfigs.find((c) => c.deviceId === internalId);

      devices.push({
        deviceId: externalId,
        deviceName: "DEV001", // TODO: 从 device 表读取 name
        childName: null, // TODO: 从 childProfile 读取
        status: "offline",
        totalDurationMinutes: metrics.totalDurationMinutes,
        totalSessions: metrics.totalSessions,
        continuousDays: streak,
        topicCount: topics.topicCount,
        todayDurationMinutes: metrics.todayDurationMinutes,
        weekDurationMinutes: metrics.weekDurationMinutes,
      });
    }

    return {
      totalDurationMinutes: allMetrics.totalDurationMinutes,
      totalSessions: allMetrics.totalSessions,
      activeDeviceCount: devices.filter((d) => d.status === "online").length,
      boundDeviceCount: devices.length,
      continuousDays: this.streakCalculator.calculate(conversations),
      topicCount: topicCoverage.topicCount,
      devices,
    };
  }

  async getDailyTrend(
    userId: string,
    deviceId?: string,
    days = 7,
  ): Promise<DailyTrendPoint[]> {
    const { internalIds } = await this.getUserDevices(userId, deviceId);
    const activeConfigs = await this.getActiveConfigs(internalIds);
    const conversations = await this.getConversations(
      internalIds,
      activeConfigs,
    );

    const result: DailyTrendPoint[] = [];
    const today = new Date();

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = this.toDateString(date);

      const dayConversations = conversations.filter(
        (c) => c.spokeAt && this.toDateString(new Date(c.spokeAt)) === dateStr,
      );

      const metrics = this.metricsCalculator.calculate(dayConversations);

      result.push({
        date: `${date.getMonth() + 1}/${date.getDate()}`,
        durationMinutes: metrics.totalDurationMinutes,
        sessionCount: metrics.totalSessions,
      });
    }

    return result;
  }

  async getTopicBreakdown(
    userId: string,
    deviceId?: string,
  ): Promise<TopicBreakdownItem[]> {
    const { internalIds } = await this.getUserDevices(userId, deviceId);
    const activeConfigs = await this.getActiveConfigs(internalIds);
    const conversations = await this.getConversations(
      internalIds,
      activeConfigs,
    );
    const coverage = this.topicCalculator.calculate(conversations);

    return coverage.topics.map((topic) => {
      const activeConfig = activeConfigs.find(
        (c) =>
          c.deviceId ===
          conversations.find((conv) => this.buildTopicKey(conv) === topic.key)
            ?.deviceId,
      );

      const isActive =
        !!activeConfig &&
        activeConfig.mode === topic.mode &&
        activeConfig.textbookId === topic.textbookId &&
        activeConfig.unitId === topic.unitId;

      return {
        id: topic.key,
        mode: topic.mode,
        textbookId: topic.textbookId,
        textbookName: topic.textbookId ?? null,
        unitId: topic.unitId,
        unitName: topic.unitId ?? null,
        conversationModeKey: null,
        conversationModeName: null,
        count: topic.count,
        lastSpokeAt: topic.lastSpokeAt.toISOString(),
        isActive,
        avgScore: null,
      };
    });
  }

  async getTimeline(
    userId: string,
    deviceId?: string,
    page = 1,
    pageSize = 10,
  ): Promise<{
    items: TimelineEvent[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const { deviceMap, internalIds } = await this.getUserDevices(
      userId,
      deviceId,
    );
    const activeConfigs = await this.getActiveConfigs(internalIds);

    const where: any = {
      deletedAt: null,
      deviceId: { in: internalIds },
    };

    const orFilters = this.buildConversationFilters(activeConfigs);
    if (orFilters.length > 0) {
      where.OR = orFilters;
    }

    const [rows, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        orderBy: { spokeAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { device: true },
      }),
      this.prisma.conversation.count({ where }),
    ]);

    const items: TimelineEvent[] = rows.map((row: any) => ({
      id: row.id,
      deviceId: row.device?.deviceId ?? row.deviceId,
      deviceName: row.device?.name ?? "Device",
      mode: row.mode,
      topicName: this.resolveTopicName(row),
      userText: row.asrText ?? "",
      aiText: row.aiReply ?? "",
      createdAt: row.spokeAt?.toISOString() ?? row.createdAt.toISOString(),
    }));

    return { items, total, page, pageSize };
  }

  async getUnitProgress(
    userId: string,
    deviceId: string,
  ): Promise<UnitProgressItem[]> {
    const { internalIds } = await this.getUserDevices(userId, deviceId);
    if (internalIds.length === 0) return [];

    const activeConfigs = await this.getActiveConfigs(internalIds);
    const conversations = await this.getConversations(
      internalIds,
      activeConfigs,
    );
    const coverage = this.topicCalculator.calculate(
      conversations.filter(
        (c) => c.mode === "locked_unit" || c.mode === "textbook_learning",
      ),
    );

    return coverage.topics
      .filter((t) => t.textbookId && t.unitId)
      .map((topic) => ({
        textbookId: topic.textbookId!,
        textbookName: topic.textbookId!,
        unitId: topic.unitId!,
        unitName: topic.unitId!,
        conversationCount: topic.count,
        lastSpokeAt: topic.lastSpokeAt.toISOString(),
        masteryLevel: null,
      }));
  }

  private async getUserDevices(userId: string, deviceId?: string) {
    const bindings = await this.prisma.userDeviceBinding.findMany({
      where: { userId },
      include: { device: true },
    });

    const isDevFallback =
      bindings.length === 0 && process.env.NODE_ENV === "development";

    if (isDevFallback) {
      return { deviceMap: new Map<string, string>(), internalIds: [] };
    }

    const deviceMap = new Map(
      bindings.map((b: any) => [b.device.deviceId, b.device.id]),
    );

    let internalIds = Array.from(deviceMap.values());

    if (deviceId) {
      const targetId = deviceMap.get(deviceId);
      if (!targetId) {
        return { deviceMap: new Map<string, string>(), internalIds: [] };
      }
      internalIds = [targetId];
      const filteredMap = new Map<string, string>();
      filteredMap.set(deviceId, targetId);
      return { deviceMap: filteredMap, internalIds };
    }

    return { deviceMap, internalIds };
  }

  private async getActiveConfigs(
    deviceInternalIds: string[],
  ): Promise<ActiveConfig[]> {
    if (deviceInternalIds.length === 0) return [];
    return this.prisma.deviceConfig.findMany({
      where: {
        deviceId: { in: deviceInternalIds },
        isActive: true,
      },
    }) as Promise<ActiveConfig[]>;
  }

  private async getConversations(
    deviceInternalIds: string[],
    activeConfigs: ActiveConfig[],
  ) {
    if (deviceInternalIds.length === 0) return [];

    const orFilters = this.buildConversationFilters(activeConfigs);
    const where: any = {
      deletedAt: null,
      deviceId: { in: deviceInternalIds },
    };
    if (orFilters.length > 0) {
      where.OR = orFilters;
    }

    return this.prisma.conversation.findMany({
      where,
      orderBy: { spokeAt: "desc" },
    });
  }

  private buildConversationFilters(activeConfigs: ActiveConfig[]) {
    return activeConfigs.map((config) => {
      const filter: any = {
        deviceId: config.deviceId,
        mode: config.mode,
      };
      if (config.textbookId) filter.textbookId = config.textbookId;
      if (config.unitId) filter.unitId = config.unitId;
      return filter;
    });
  }

  private buildTopicKey(conv: any): string {
    return [conv.mode, conv.textbookId, conv.unitId, conv.conversationModeKey]
      .filter(Boolean)
      .join("|");
  }

  private resolveTopicName(conv: any): string {
    if (conv.mode === "free_chat" && conv.conversationModeKey) {
      return conv.conversationModeKey;
    }
    if (conv.textbookId && conv.unitId) {
      return `${conv.textbookId} · ${conv.unitId}`;
    }
    return conv.mode;
  }

  private toDateString(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
}
