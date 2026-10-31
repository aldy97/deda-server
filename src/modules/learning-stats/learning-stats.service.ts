import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DashboardDto,
  DailyTrendPoint,
  TopicBreakdownItem,
  TimelineEvent,
  UnitProgressItem,
  ActivityEventDto,
  ActivitiesPageDto,
  StatsRange,
  StatsContext,
  LearningStatsInsightDto,
  LearningStatsHealthDto,
  ParentReportDto,
  ParentReportFeedbackResultDto,
} from "./dto/learning-stats.dto";
import { ConversationMetricsCalculator } from "./calculators/conversation-metrics.calculator";
import { StreakCalculator } from "./calculators/streak.calculator";
import { TopicCoverageCalculator } from "./calculators/topic-coverage.calculator";
import { ScoreCalculator } from "./calculators/score.calculator";
import { isValidReportDate, reportDayRange } from "./parent-report-date.util";

interface ActiveConfig {
  deviceId: string;
  mode: string;
  textbookId: string | null;
  unitId: string | null;
  conversationModeKey: string | null;
}

@Injectable()
export class LearningStatsService {
  /** 教材学习族模式（自由对话之外的三个） */
  private static readonly TEXTBOOK_MODES = [
    "locked_unit",
    "textbook_learning",
    "free_textbook",
  ];

  private readonly metricsCalculator = new ConversationMetricsCalculator();
  private readonly streakCalculator = new StreakCalculator();
  private readonly topicCalculator = new TopicCoverageCalculator();
  private readonly scoreCalculator = new ScoreCalculator();

  constructor(private readonly prisma: PrismaService) {}

  async getParentReport(
    userId: string,
    deviceId: string,
    reportDate: string,
  ): Promise<ParentReportDto> {
    const { internalIds } = await this.getUserDevices(userId, deviceId);
    if (internalIds.length === 0) {
      throw new NotFoundException("Device not bound");
    }
    if (!isValidReportDate(reportDate)) {
      throw new BadRequestException("Invalid report date");
    }
    const internalId = internalIds[0];
    const device = await this.prisma.device.findUnique({
      where: { id: internalId },
      select: { timezone: true },
    });
    const { start, end } = reportDayRange(reportDate, device?.timezone);

    const [learningStat, messages, report, habitPlans] = await Promise.all([
      this.prisma.learningStat.findUnique({
        where: {
          deviceId_statDate: { deviceId: internalId, statDate: reportDate },
        },
        select: { durationSeconds: true },
      }),
      this.prisma.message.findMany({
        where: {
          deviceId: internalId,
          role: "user",
          spokeAt: { gte: start, lt: end },
        },
        select: { mode: true },
      }),
      this.prisma.parentReport.findUnique({
        where: {
          deviceId_reportDate: { deviceId: internalId, reportDate },
        },
      }),
      this.prisma.habitPlan.findMany({
        where: { deviceId: internalId, status: "active" },
        select: {
          id: true,
          title: true,
          targetDays: true,
          dailyRecords: {
            select: { recordDate: true, completed: true },
          },
        },
      }),
    ]);

    const modeCounts = new Map<string, number>();
    for (const message of messages) {
      const mode = message.mode || "unknown";
      modeCounts.set(mode, (modeCounts.get(mode) ?? 0) + 1);
    }
    const modeUsage = Array.from(modeCounts, ([mode, count]) => ({
      mode,
      count,
    })).sort((a, b) => b.count - a.count || a.mode.localeCompare(b.mode));

    return {
      deviceId,
      reportDate,
      durationMinutes: Math.round((learningStat?.durationSeconds ?? 0) / 60),
      modeUsage,
      summary: report
        ? {
            expressionObservation: report.expressionObservation,
            emotionObservation: report.emotionObservation,
            thinkingObservation: report.thinkingObservation,
            suggestion: report.suggestion,
          }
        : null,
      habits: habitPlans.map((plan) => ({
        planId: plan.id,
        title: plan.title,
        targetDays: plan.targetDays,
        completedDays: plan.dailyRecords.filter((record) => record.completed)
          .length,
        todayCompleted: plan.dailyRecords.some(
          (record) => record.recordDate === reportDate && record.completed,
        ),
      })),
      feedback: (report?.feedback as "useful" | "not_useful" | null) ?? null,
    };
  }

  async submitParentReportFeedback(
    userId: string,
    deviceId: string,
    reportDate: string,
    useful: boolean,
  ): Promise<ParentReportFeedbackResultDto> {
    const { internalIds } = await this.getUserDevices(userId, deviceId);
    if (internalIds.length === 0) {
      throw new NotFoundException("Device not bound");
    }
    const report = await this.prisma.parentReport.findUnique({
      where: {
        deviceId_reportDate: {
          deviceId: internalIds[0],
          reportDate,
        },
      },
      select: { id: true },
    });
    if (!report) {
      throw new NotFoundException("Parent report not found");
    }

    const feedback = useful ? "useful" : "not_useful";
    await this.prisma.parentReport.update({
      where: { id: report.id },
      data: { feedback, feedbackAt: new Date(), feedbackUserId: userId },
    });
    return { reportDate, feedback };
  }

  async getDashboard(
    userId: string,
    deviceId?: string,
    range?: StatsRange,
    ctx: StatsContext = {},
  ): Promise<DashboardDto> {
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
    const childProfiles = await this.getChildProfiles(internalIds);
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
      const childProfile = childProfiles.get(internalId);

      devices.push({
        deviceId: externalId,
        deviceName: "DEV001", // TODO: 从 device 表读取 name
        childName: childProfile?.name ?? null,
        childEnglishName: childProfile?.englishName ?? null,
        status: "offline",
        totalDurationMinutes: metrics.totalDurationMinutes,
        totalSessions: metrics.totalSessions,
        continuousDays: streak,
        topicCount: topics.topicCount,
        todayDurationMinutes: metrics.todayDurationMinutes,
        weekDurationMinutes: metrics.weekDurationMinutes,
      });
    }

    const result: DashboardDto = {
      totalDurationMinutes: allMetrics.totalDurationMinutes,
      totalSessions: allMetrics.totalSessions,
      activeDeviceCount: devices.filter((d) => d.status === "online").length,
      boundDeviceCount: devices.length,
      continuousDays: this.streakCalculator.calculate(conversations),
      maxContinuousDays: Math.max(0, ...devices.map((d) => d.continuousDays)),
      topicCount: topicCoverage.topicCount,
      devices,
    };

    // 带 range 时,顶部指标按自然历时间窗统计（不按 active config 过滤,
    // 回答的是「这段时间学了多少」而非「当前单元学了多少」）;
    // continuousDays 与 devices 保持全量语义
    if (range) {
      const since = this.rangeStart(range);
      const ctxWhere = await this.buildContextWhere(internalIds, ctx);

      const scoped = await this.prisma.message.findMany({
        where: { ...ctxWhere, spokeAt: { gte: since } },
      });

      const practiceCount = scoped.length;
      const topicKeys = new Set(
        scoped.map((m) => `${m.mode}|${m.textbookId ?? ""}|${m.unitId ?? ""}`),
      );

      result.totalDurationMinutes = Math.round(practiceCount * 0.5);
      result.practiceCount = practiceCount;
      result.topicCount = topicKeys.size;
    }

    return result;
  }

  async getDailyTrend(
    userId: string,
    deviceId?: string,
    days = 7,
    ctx: StatsContext = {},
  ): Promise<DailyTrendPoint[]> {
    const { internalIds } = await this.getUserDevices(userId, deviceId);
    // 显式语境 > 设备当前配置模式族;不再按单元隔离（跨教材跨单元计入）
    const where = await this.buildContextWhere(internalIds, ctx);
    const conversations = await this.prisma.message.findMany({
      where,
      orderBy: { spokeAt: "desc" },
    });

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
    // 主题分布展示全部学过的语境;isActive 仍按当前配置比对
    const conversations = await this.getConversations(
      internalIds,
      activeConfigs,
      false,
    );
    const coverage = this.topicCalculator.calculate(conversations);

    // 每个主题语境的 user 消息分组,用于启发式开口分
    const msgsByTopicKey = new Map<string, { content: string }[]>();
    for (const conv of conversations) {
      const key = this.buildTopicKey(conv);
      const list = msgsByTopicKey.get(key) ?? [];
      list.push({ content: conv.content });
      msgsByTopicKey.set(key, list);
    }

    // 名称联查：教材、单元、free_chat 子模式
    const bizTextbookIds = Array.from(
      new Set(conversations.map((c) => c.textbookId).filter(Boolean)),
    ) as string[];
    const textbooks = bizTextbookIds.length
      ? await this.prisma.textbook.findMany({
          where: { textbookId: { in: bizTextbookIds } },
          select: { id: true, textbookId: true, name: true },
        })
      : [];
    const textbookByBizId = new Map(textbooks.map((t) => [t.textbookId, t]));
    const units = textbooks.length
      ? await this.prisma.unit.findMany({
          where: { textbookId: { in: textbooks.map((t) => t.id) } },
          select: { textbookId: true, unitId: true, name: true },
        })
      : [];
    const unitNameByKey = new Map(
      units.map((u) => [`${u.textbookId}|${u.unitId}`, u.name]),
    );
    const modeKeys = Array.from(
      new Set(conversations.map((c) => c.conversationModeKey).filter(Boolean)),
    ) as string[];
    const convModes = modeKeys.length
      ? await this.prisma.conversationMode.findMany({
          where: { key: { in: modeKeys } },
          select: { key: true, name: true },
        })
      : [];
    const modeNameByKey = new Map(convModes.map((m) => [m.key, m.name]));

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
        activeConfig.unitId === topic.unitId &&
        // free_chat 主题还要匹配到子模式
        (topic.mode !== "free_chat" ||
          activeConfig.conversationModeKey === topic.conversationModeKey);

      const tb = topic.textbookId
        ? textbookByBizId.get(topic.textbookId)
        : undefined;

      return {
        id: topic.key,
        mode: topic.mode,
        textbookId: topic.textbookId,
        textbookName: tb?.name ?? null,
        unitId: topic.unitId,
        unitName:
          tb && topic.unitId
            ? (unitNameByKey.get(`${tb.id}|${topic.unitId}`) ?? null)
            : null,
        conversationModeKey: topic.conversationModeKey,
        conversationModeName: topic.conversationModeKey
          ? (modeNameByKey.get(topic.conversationModeKey) ?? null)
          : null,
        count: topic.count,
        lastSpokeAt: topic.lastSpokeAt.toISOString(),
        isActive,
        // 启发式英文开口分仅对教材语境计算;自由对话不评分,前端隐藏
        avgScore:
          topic.mode === "free_chat"
            ? null
            : this.scoreCalculator.calculate(
                msgsByTopicKey.get(topic.key) ?? [],
              ),
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
      role: "user",
      deviceId: { in: internalIds },
    };

    const orFilters = this.buildConversationFilters(activeConfigs);
    if (orFilters.length > 0) {
      where.OR = orFilters;
    }

    // 分页主查询只数 user 消息（一条 = 一轮）
    const [rows, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        orderBy: { spokeAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { device: true },
      }),
      this.prisma.message.count({ where }),
    ]);

    // 按 turnId 关联 assistant 回复；LLM 失败/缺失时 aiText 为空
    const turnIds = rows.map((row: any) => row.turnId);
    const assistants =
      turnIds.length > 0
        ? await this.prisma.message.findMany({
            where: { role: "assistant", turnId: { in: turnIds } },
            select: { turnId: true, content: true, status: true },
          })
        : [];
    const replyByTurn = new Map(
      assistants.map((a: any) => [a.turnId, a] as const),
    );

    const items: TimelineEvent[] = rows.map((row: any) => ({
      id: row.id,
      deviceId: row.device?.deviceId ?? row.deviceId,
      deviceName: row.device?.name ?? "Device",
      mode: row.mode,
      topicName: this.resolveTopicName(row),
      userText: row.content ?? "",
      aiText: replyByTurn.get(row.turnId)?.content ?? "",
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
    // 单元进度覆盖全部练过的单元,不限于当前在学单元
    const conversations = await this.getConversations(
      internalIds,
      activeConfigs,
      false,
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

  /**
   * 生成 AI 学习洞察（家庭维度或单设备维度）
   * 基于 dashboard / daily / topics 实时计算，后端未接入 LLM 时提供规则兜底。
   */
  async getInsights(
    userId: string,
    deviceId?: string,
    range?: StatsRange,
  ): Promise<LearningStatsInsightDto[]> {
    const dashboard = await this.getDashboard(userId, deviceId, range);
    const topics = await this.getTopicBreakdown(userId, deviceId);
    const days = range === "today" ? 1 : range === "week" ? 7 : 30;
    const trend = await this.getDailyTrend(userId, deviceId, days);

    const insights: LearningStatsInsightDto[] = [];

    // 1. 里程碑：连续学习
    if (dashboard.continuousDays >= 3) {
      insights.push({
        id: "milestone-streak",
        type: "milestone",
        title: "坚持学习",
        content: `家庭已连续学习 ${dashboard.continuousDays} 天，再坚持一下就能养成好习惯！`,
        metricValue: dashboard.continuousDays,
        metricUnit: "天",
      });
    }

    // 2. 活跃度
    if (dashboard.totalDurationMinutes > 0) {
      const rangeText =
        range === "today" ? "今天" : range === "week" ? "本周" : "本月";
      insights.push({
        id: "strength-activity",
        type: "strength",
        title: "学习活跃",
        content: `${rangeText}累计学习 ${dashboard.totalDurationMinutes} 分钟，共完成 ${dashboard.totalSessions} 次练习。`,
        metricValue: dashboard.totalDurationMinutes,
        metricUnit: "分钟",
      });
    }

    // 3. 设备级洞察
    for (const device of dashboard.devices) {
      if (device.status === "offline") {
        insights.push({
          id: `alert-offline-${device.deviceId}`,
          type: "alert",
          title: "设备离线",
          content: `${device.childName || device.deviceName} 的设备当前离线，请检查网络连接。`,
          deviceId: device.deviceId,
          deviceName: device.childName || device.deviceName,
        });
      }

      if (device.todayDurationMinutes === 0 && device.status !== "offline") {
        insights.push({
          id: `alert-no-today-${device.deviceId}`,
          type: "alert",
          title: "今日未学习",
          content: `${device.childName || device.deviceName} 今天还没有学习记录。`,
          deviceId: device.deviceId,
          deviceName: device.childName || device.deviceName,
        });
      }
    }

    // 4. 内容均衡度
    const balance = this.calculateBalanceScore(topics);
    if (topics.length > 1 && balance < 50) {
      const dominant = topics.reduce(
        (max, t) => (t.count > max.count ? t : max),
        topics[0],
      );
      insights.push({
        id: "weakness-balance",
        type: "weakness",
        title: "内容偏科",
        content: `${this.formatTopicName(dominant)} 占比过高，建议适当补充其他主题内容。`,
        metricValue: balance,
        metricUnit: "分",
      });
    }

    // 5. 趋势对比
    if (trend.length >= 7) {
      const mid = Math.floor(trend.length / 2);
      const firstHalf = trend.slice(0, mid);
      const secondHalf = trend.slice(mid);
      const firstSum = firstHalf.reduce((s, p) => s + p.durationMinutes, 0);
      const secondSum = secondHalf.reduce((s, p) => s + p.durationMinutes, 0);

      if (firstSum > 0) {
        const change = Math.round(((secondSum - firstSum) / firstSum) * 100);
        if (Math.abs(change) >= 20) {
          insights.push({
            id: "suggestion-trend",
            type: change > 0 ? "strength" : "suggestion",
            title: "趋势变化",
            content:
              change > 0
                ? `学习时长较上半段增长 ${change}%，势头不错，继续保持。`
                : `学习时长较上半段下降 ${Math.abs(change)}%，建议关注学习安排。`,
            metricValue: change,
            metricUnit: "%",
          });
        }
      }
    }

    return insights.slice(0, 3);
  }

  /**
   * 计算学习健康度（家庭维度或单设备维度）
   */
  async getHealth(
    userId: string,
    deviceId?: string,
    range?: StatsRange,
  ): Promise<LearningStatsHealthDto> {
    const dashboard = await this.getDashboard(userId, deviceId, range);
    const topics = await this.getTopicBreakdown(userId, deviceId);
    const days = range === "today" ? 1 : range === "week" ? 7 : 30;
    const trend = await this.getDailyTrend(userId, deviceId, days);

    const referenceDuration =
      range === "today" ? 30 : range === "week" ? 180 : 600;
    const activity = Math.min(
      100,
      Math.round((dashboard.totalDurationMinutes / referenceDuration) * 100),
    );

    const todayMinutes = dashboard.devices.reduce(
      (sum, d) => sum + (d.todayDurationMinutes || 0),
      0,
    );
    const consistency = Math.min(
      100,
      Math.round(
        (Math.min(dashboard.continuousDays, 7) / 7) * 70 +
          (todayMinutes > 0 ? 30 : 0),
      ),
    );

    const balance = this.calculateBalanceScore(topics);

    const avgSessionDuration =
      dashboard.totalSessions > 0
        ? dashboard.totalDurationMinutes / dashboard.totalSessions
        : 0;
    const engagement = Math.min(
      100,
      Math.round((avgSessionDuration / 20) * 100),
    );

    let score = Math.round(
      activity * 0.3 + consistency * 0.3 + balance * 0.2 + engagement * 0.2,
    );

    if (todayMinutes === 0) {
      score = Math.min(score, 54);
    }

    const level = this.getHealthLevel(score);
    const suggestion = this.buildHealthSuggestion(
      level,
      todayMinutes,
      dashboard.continuousDays,
    );

    return {
      score,
      level,
      dimensions: { activity, consistency, balance, engagement },
      suggestion,
    };
  }

  private getHealthLevel(score: number): LearningStatsHealthDto["level"] {
    const normalized = Math.max(0, Math.min(100, score));
    if (normalized >= 85) return "excellent";
    if (normalized >= 70) return "good";
    if (normalized >= 55) return "average";
    return "attention";
  }

  private calculateBalanceScore(topics: TopicBreakdownItem[]): number {
    if (topics.length <= 1) return 100;

    const total = topics.reduce((sum, t) => sum + t.count, 0);
    if (total === 0) return 100;

    const entropy = topics.reduce((sum, t) => {
      const p = t.count / total;
      return p > 0 ? sum - p * Math.log(p) : sum;
    }, 0);

    const maxEntropy = Math.log(topics.length);
    const ratio = maxEntropy > 0 ? entropy / maxEntropy : 1;
    return Math.round(ratio * 100);
  }

  private buildHealthSuggestion(
    level: LearningStatsHealthDto["level"],
    todayMinutes: number,
    continuousDays: number,
  ): string {
    if (todayMinutes === 0) {
      return "今天还没有学习记录，建议提醒孩子开始今天的练习。";
    }
    if (level === "excellent") {
      return `学习状态很棒，已连续学习 ${continuousDays} 天，继续保持！`;
    }
    if (level === "good") {
      return "学习状态良好，可以适当增加练习频次或尝试新主题。";
    }
    if (level === "average") {
      return "学习状态一般，建议制定固定学习计划，提升连续性。";
    }
    return "学习投入不足，建议关注孩子的学习时间和内容分布。";
  }

  private formatTopicName(topic: TopicBreakdownItem): string {
    return (
      topic.conversationModeName ||
      [topic.textbookName, topic.unitName].filter(Boolean).join(" · ") ||
      topic.mode
    );
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

  private async getChildProfiles(
    deviceInternalIds: string[],
  ): Promise<Map<string, { name: string | null; englishName: string | null }>> {
    const result = new Map<
      string,
      { name: string | null; englishName: string | null }
    >();
    if (deviceInternalIds.length === 0) return result;

    const profiles = await this.prisma.childProfile.findMany({
      where: { deviceId: { in: deviceInternalIds } },
      select: { deviceId: true, name: true, englishName: true },
    });

    for (const profile of profiles) {
      result.set(profile.deviceId, {
        name: profile.name,
        englishName: profile.englishName,
      });
    }
    return result;
  }

  private async getConversations(
    deviceInternalIds: string[],
    activeConfigs: ActiveConfig[],
    scopeToConfig = true,
  ) {
    if (deviceInternalIds.length === 0) return [];

    // 统计口径：role='user' 的消息,一条 = 一轮（与原 conversation 行等价）
    // scopeToConfig=false 时返回全量学习语境（topics/unit-progress 用）
    const where: any = {
      role: "user",
      deviceId: { in: deviceInternalIds },
    };
    if (scopeToConfig) {
      const orFilters = this.buildConversationFilters(activeConfigs);
      if (orFilters.length > 0) {
        where.OR = orFilters;
      }
    }

    return this.prisma.message.findMany({
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

  /** 设备当前配置的模式族（缺省统计语境）：全 free_chat → 自由对话;否则教材族 */
  private async resolveModeFamily(
    deviceInternalIds: string[],
  ): Promise<string[]> {
    const configs = await this.getActiveConfigs(deviceInternalIds);
    if (configs.length === 0) return LearningStatsService.TEXTBOOK_MODES;
    return configs.every((c) => c.mode === "free_chat")
      ? ["free_chat"]
      : LearningStatsService.TEXTBOOK_MODES;
  }

  /**
   * 统一构造统计 where：显式语境参数优先,缺省=配置模式族。
   * 查看任何教材/单元都是只读操作,不需要改动设备配置。
   */
  private async buildContextWhere(
    deviceInternalIds: string[],
    ctx: StatsContext,
  ): Promise<any> {
    const where: any = { role: "user", deviceId: { in: deviceInternalIds } };

    if (ctx.textbookId || ctx.unitId) {
      // 教材族:unitId 单独出现也蕴含教材语境
      where.mode = { in: LearningStatsService.TEXTBOOK_MODES };
      if (ctx.textbookId) where.textbookId = ctx.textbookId;
      if (ctx.unitId) where.unitId = ctx.unitId;
      return where;
    }

    if (ctx.mode) {
      where.mode = ctx.mode;
      if (ctx.conversationModeKey) {
        where.conversationModeKey = ctx.conversationModeKey;
      }
      return where;
    }

    where.mode = { in: await this.resolveModeFamily(deviceInternalIds) };
    return where;
  }

  /**
   * 自然历范围起点（本地时间）：
   * today=今日 0 点;week=本周一 0 点;month=本月 1 号 0 点
   */
  private rangeStart(range: StatsRange): Date {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (range === "week") {
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      return start;
    }
    if (range === "month") {
      start.setDate(1);
    }
    return start;
  }

  /**
   * 学习动态：事件型卡片流（按日倒序分页）
   * - study：某日某教材/单元（或 free_chat）的练习卡,轮数 = 当日 user 消息数
   * - streak：连续学习 ≥2 天时,卡在该连续段的最后一天
   * - unlock：某单元的首次练习日
   * 动态是全量历史,不按当前 active config 过滤
   */
  async getActivities(
    userId: string,
    deviceId?: string,
    options: {
      page?: number;
      pageSize?: number;
      range?: StatsRange;
    } & StatsContext = {},
  ): Promise<ActivitiesPageDto> {
    const {
      page = 1,
      pageSize = 10,
      range,
      textbookId,
      unitId,
      mode,
      conversationModeKey,
    } = options;
    const { internalIds } = await this.getUserDevices(userId, deviceId);
    if (internalIds.length === 0) {
      return { items: [], total: 0, page, pageSize };
    }

    // 缺省按配置模式族过滤;显式语境参数优先（只读查看,不改设备配置）
    const where = await this.buildContextWhere(internalIds, {
      textbookId,
      unitId,
      mode,
      conversationModeKey,
    });
    const messages = await this.prisma.message.findMany({
      where,
      orderBy: { spokeAt: "desc" },
    });

    if (messages.length === 0) {
      return { items: [], total: 0, page, pageSize };
    }

    // 名称联查
    const bizTextbookIds = Array.from(
      new Set(messages.map((m) => m.textbookId).filter(Boolean)),
    ) as string[];
    const textbooks = bizTextbookIds.length
      ? await this.prisma.textbook.findMany({
          where: { textbookId: { in: bizTextbookIds } },
          select: { id: true, textbookId: true, name: true },
        })
      : [];
    const textbookByBizId = new Map(textbooks.map((t) => [t.textbookId, t]));
    const units = textbooks.length
      ? await this.prisma.unit.findMany({
          where: { textbookId: { in: textbooks.map((t) => t.id) } },
          select: { textbookId: true, unitId: true, name: true },
        })
      : [];
    const unitNameByKey = new Map(
      units.map((u) => [`${u.textbookId}|${u.unitId}`, u.name]),
    );

    // 按日分组（本地日期）
    const dayMap = new Map<string, typeof messages>();
    for (const m of messages) {
      const day = this.toDateString(new Date(m.spokeAt));
      const list = dayMap.get(day) ?? [];
      list.push(m);
      dayMap.set(day, list);
    }
    const daysDesc = Array.from(dayMap.keys()).sort().reverse();

    // 连续段（升序扫描,差一天为连续）
    const streakByDay = new Map<string, number>();
    const daysAsc = [...daysDesc].sort();
    let runStart = 0;
    for (let i = 1; i <= daysAsc.length; i++) {
      const prev = new Date(daysAsc[i - 1]).getTime();
      const curr = daysAsc[i] ? new Date(daysAsc[i]).getTime() : NaN;
      if (curr - prev !== 24 * 60 * 60 * 1000) {
        const runLen = i - runStart;
        if (runLen >= 2) {
          streakByDay.set(daysAsc[i - 1], runLen);
        }
        runStart = i;
      }
    }

    // 每个单元的首练日
    const firstDayByUnit = new Map<string, string>();
    const byTimeAsc = [...messages].sort(
      (a, b) => a.spokeAt.getTime() - b.spokeAt.getTime(),
    );
    for (const m of byTimeAsc) {
      if (!m.textbookId || !m.unitId) continue;
      const key = `${m.textbookId}|${m.unitId}`;
      if (!firstDayByUnit.has(key)) {
        firstDayByUnit.set(key, this.toDateString(new Date(m.spokeAt)));
      }
    }

    // range 过滤日组;streak/unlock 已在全量历史上算完,语义不受窗口影响
    const scopedDays = range
      ? daysDesc.filter(
          (day) => day >= this.toDateString(this.rangeStart(range)),
        )
      : daysDesc;

    const total = scopedDays.length;
    const pageDays = scopedDays.slice((page - 1) * pageSize, page * pageSize);

    const items = pageDays.map((day) => {
      const dayMsgs = dayMap.get(day)!;
      const events: ActivityEventDto[] = [];

      // study 卡：按 mode/textbook/unit 分组
      const byCtx = new Map<string, typeof dayMsgs>();
      for (const m of dayMsgs) {
        const key = `${m.mode}|${m.textbookId ?? ""}|${m.unitId ?? ""}`;
        const list = byCtx.get(key) ?? [];
        list.push(m);
        byCtx.set(key, list);
      }
      for (const ctxMsgs of byCtx.values()) {
        const first = ctxMsgs[0];
        const tb = first.textbookId
          ? textbookByBizId.get(first.textbookId)
          : undefined;
        events.push({
          type: "study",
          mode: first.mode,
          textbookId: first.textbookId,
          textbookName: tb?.name ?? null,
          unitId: first.unitId,
          unitName:
            tb && first.unitId
              ? (unitNameByKey.get(`${tb.id}|${first.unitId}`) ?? null)
              : null,
          turnCount: ctxMsgs.length,
        });
      }

      const streak = streakByDay.get(day);
      if (streak) {
        events.push({ type: "streak", streakDays: streak });
      }

      for (const [key, firstDay] of firstDayByUnit) {
        if (firstDay !== day) continue;
        const [textbookId, unitId] = key.split("|");
        const tb = textbookByBizId.get(textbookId);
        events.push({
          type: "unlock",
          textbookId,
          textbookName: tb?.name ?? null,
          unitId,
          unitName: tb
            ? (unitNameByKey.get(`${tb.id}|${unitId}`) ?? null)
            : null,
        });
      }

      return { date: day, events };
    });

    return { items, total, page, pageSize };
  }
}
