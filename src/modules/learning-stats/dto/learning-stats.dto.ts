import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from "class-validator";

export class ParentReportQueryDto {
  @IsString()
  deviceId!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "date must use YYYY-MM-DD format",
  })
  date!: string;
}

export class ParentReportFeedbackDto {
  @IsString()
  @IsNotEmpty()
  deviceId!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "reportDate must use YYYY-MM-DD format",
  })
  reportDate!: string;

  @IsBoolean()
  useful!: boolean;
}

export class ModeUsageQueryDto {
  @IsString()
  @IsNotEmpty()
  deviceId!: string;

  @IsOptional()
  @Matches(/^\d+$/, { message: "days must be a positive integer" })
  days?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "endDate must use YYYY-MM-DD format",
  })
  endDate?: string;
}

export interface ModeUsageItemDto {
  mode: string;
  count: number;
}

export interface ModeUsageResultDto {
  deviceId: string;
  /** 实际统计起点 YYYY-MM-DD；窗口内无任何可统计数据时为 null */
  startDate: string | null;
  /** 实际统计截止日 YYYY-MM-DD；窗口内无任何可统计数据时为 null */
  endDate: string | null;
  /** 实际纳入统计的自然日数（含 0 次互动的天） */
  actualDays: number;
  totalCount: number;
  modeUsage: ModeUsageItemDto[];
}

export interface ParentReportModeUsageDto {
  mode: string;
  label: string;
  count: number;
}

export interface ParentReportHabitDto {
  planId: string;
  title: string;
  targetDays: number;
  completedDays: number;
  todayCompleted: boolean;
}

export interface ParentReportDto {
  deviceId: string;
  reportDate: string;
  durationMinutes: number;
  generationStatus: "pending" | "generating" | "completed" | "failed";
  modeUsage: ParentReportModeUsageDto[];
  summary: {
    expressionObservation: string | null;
    emotionObservation: string | null;
    thinkingObservation: string | null;
    suggestion: string | null;
  } | null;
  habits: ParentReportHabitDto[];
  feedback: "useful" | "not_useful" | null;
}

export interface ParentReportFeedbackResultDto {
  reportDate: string;
  feedback: "useful" | "not_useful";
}

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

export interface ActivityEventDto {
  type: "study" | "streak";
  mode?: string | null;
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
 * 统计语境参数：显式传参优先；全部缺省时按设备当前顶层配置过滤。
 * scope=all 时不过滤，供家长报告统计全部用户交互。
 */
export interface StatsContext {
  /** 精确顶层 mode */
  mode?: string;
  conversationModeKey?: string;
  /** 家长报告口径：不按设备当前配置过滤，统计全部用户交互 */
  scope?: "all";
}
