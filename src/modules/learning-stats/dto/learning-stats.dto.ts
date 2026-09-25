export interface DeviceDashboardMetrics {
  deviceId: string;
  deviceName: string;
  childName?: string | null;
  status: "online" | "offline" | "sleeping";
  totalDurationMinutes: number;
  totalSessions: number;
  continuousDays: number;
  topicCount: number;
  todayDurationMinutes: number;
  weekDurationMinutes: number;
}

export interface DashboardDto {
  totalDurationMinutes: number;
  totalSessions: number;
  activeDeviceCount: number;
  boundDeviceCount: number;
  continuousDays: number;
  topicCount: number;
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
