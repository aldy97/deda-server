export interface DeviceDashboardMetrics {
  deviceId: string;
  deviceName: string;
  childName?: string | null;
  childEnglishName?: string | null;
  status: "online" | "offline" | "sleeping";
  totalDurationMinutes: number;
  totalSessions: number;
  continuousDays: number;
  topicCount: number;
  todayDurationMinutes: number;
  weekDurationMinutes: number;
}

/** 统计范围：缺省 = 全量累计（兼容旧调用方） */
export type StatsRange = "today" | "week" | "month";

export interface DashboardDto {
  totalDurationMinutes: number;
  totalSessions: number;
  activeDeviceCount: number;
  boundDeviceCount: number;
  continuousDays: number;
  /** 各设备连续天中的最大值，用于家庭总览展示 */
  maxContinuousDays?: number;
  topicCount: number;
  /** 范围内对话轮数,仅带 range 参数时返回 */
  practiceCount?: number | null;
  devices: DeviceDashboardMetrics[];
}

export interface DailyTrendPoint {
  date: string;
  durationMinutes: number;
  sessionCount: number;
}

export interface TopicBreakdownItem {
  id: string;
  mode: string;
  textbookId?: string | null;
  textbookName?: string | null;
  unitId?: string | null;
  unitName?: string | null;
  conversationModeKey?: string | null;
  conversationModeName?: string | null;
  count: number;
  lastSpokeAt: string;
  isActive: boolean;
  // 未来接入语音评测后填充
  avgScore?: number | null;
}

export interface TimelineEvent {
  id: string;
  deviceId: string;
  deviceName: string;
  mode: string;
  topicName: string;
  userText: string;
  aiText: string;
  createdAt: string;
}

export interface UnitProgressItem {
  textbookId: string;
  textbookName: string;
  unitId: string;
  unitName: string;
  conversationCount: number;
  lastSpokeAt: string;
  // 未来扩展
  masteryLevel?: number | null;
}

export interface ActivityEventDto {
  type: "study" | "streak" | "unlock";
  mode?: string | null;
  textbookId?: string | null;
  textbookName?: string | null;
  unitId?: string | null;
  unitName?: string | null;
  /** study 卡：当日该上下文对话轮数 */
  turnCount?: number;
  /** streak 卡：连续学习天数 */
  streakDays?: number;
}

export interface ActivityDayDto {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  events: ActivityEventDto[];
}

export interface ActivitiesPageDto {
  items: ActivityDayDto[];
  total: number;
  page: number;
  pageSize: number;
}

export type InsightType =
  "milestone" | "strength" | "weakness" | "alert" | "suggestion";

export interface LearningStatsInsightDto {
  id: string;
  type: InsightType;
  title: string;
  content: string;
  metricValue?: number | null;
  metricUnit?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
}

export interface LearningStatsHealthDimensionDto {
  activity: number;
  consistency: number;
  balance: number;
  engagement: number;
}

export interface LearningStatsHealthDto {
  score: number;
  level: "excellent" | "good" | "average" | "attention";
  dimensions: LearningStatsHealthDimensionDto;
  suggestion: string;
}

/**
 * 统计语境参数：显式传参优先;全部缺省时按设备当前配置的模式族
 * （教材族设备 → 教材类消息;free_chat 设备 → 自由对话消息）。
 * 契约哲学同 /conversations：只认显式传参,不读配置。
 */
export interface StatsContext {
  textbookId?: string;
  unitId?: string;
  /** 精确 mode（目前用于 free_chat） */
  mode?: string;
  conversationModeKey?: string;
}
