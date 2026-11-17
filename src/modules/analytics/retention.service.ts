import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  isValidReportDate,
  reportDateInTimezone,
  shiftReportDate,
} from "../learning-stats/parent-report-date.util";
import {
  AnalyticsCohortsQueryDto,
  AnalyticsCurveQueryDto,
  AnalyticsDateRangeQueryDto,
} from "./dto/analytics-query.dto";

export const CURVE_DAYS = [1, 3, 7, 14, 30, 60, 90] as const;

const DAY_MS = 86400000;

function dayDiff(fromKey: string, toKey: string): number {
  return Math.round(
    (Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) /
      DAY_MS,
  );
}

/** ISO 周标签，如 2026-W41（周一为一周起点） */
function isoWeekLabel(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  const dayNum = (date.getUTCDay() + 6) % 7; // 周一=0
  const thursday = new Date(date);
  thursday.setUTCDate(thursday.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week =
    1 +
    Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

@Injectable()
export class RetentionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 每台设备的 cohort 日期（Asia/Shanghai）。
   * activation=首次绑定（user_device_bindings 最早 createdAt）；
   * firstUse=首次 user 消息（messages 最早 spokeAt，解绑后仍冻结可追溯）。
   */
  private async getCohortDates(
    basis: "activation" | "firstUse",
  ): Promise<Map<string, string>> {
    const cohortDates = new Map<string, string>();
    if (basis === "activation") {
      const bindings = await this.prisma.userDeviceBinding.findMany({
        select: { deviceId: true, createdAt: true },
      });
      for (const binding of bindings) {
        const dateKey = reportDateInTimezone(
          binding.createdAt,
          DEFAULT_REPORT_TIMEZONE,
        );
        const current = cohortDates.get(binding.deviceId);
        if (!current || dateKey < current) {
          cohortDates.set(binding.deviceId, dateKey);
        }
      }
      return cohortDates;
    }

    const messages = await this.prisma.message.findMany({
      where: { role: "user" },
      select: { deviceId: true, spokeAt: true },
    });
    for (const message of messages) {
      const dateKey = reportDateInTimezone(
        message.spokeAt,
        DEFAULT_REPORT_TIMEZONE,
      );
      const current = cohortDates.get(message.deviceId);
      if (!current || dateKey < current) {
        cohortDates.set(message.deviceId, dateKey);
      }
    }
    return cohortDates;
  }

  /** 每台设备的活跃日期集合（有 ≥1 条 role=user 消息的日期，Asia/Shanghai） */
  private async getActiveDateSets(): Promise<Map<string, Set<string>>> {
    const messages = await this.prisma.message.findMany({
      where: { role: "user" },
      select: { deviceId: true, spokeAt: true },
    });
    const activeSets = new Map<string, Set<string>>();
    for (const message of messages) {
      const dateKey = reportDateInTimezone(
        message.spokeAt,
        DEFAULT_REPORT_TIMEZONE,
      );
      let set = activeSets.get(message.deviceId);
      if (!set) {
        set = new Set<string>();
        activeSets.set(message.deviceId, set);
      }
      set.add(dateKey);
    }
    return activeSets;
  }

  private assertValidRange(startDate: string, endDate: string) {
    if (!isValidReportDate(startDate) || !isValidReportDate(endDate)) {
      throw new BadRequestException("Invalid date");
    }
    if (startDate > endDate) {
      throw new BadRequestException("startDate must be <= endDate");
    }
  }

  async getCohorts(query: AnalyticsCohortsQueryDto) {
    const granularity = query.granularity ?? "week";
    const basis = query.basis ?? "activation";
    this.assertValidRange(query.startDate, query.endDate);

    const [cohortDates, activeSets] = await Promise.all([
      this.getCohortDates(basis),
      this.getActiveDateSets(),
    ]);

    // cohortLabel -> deviceIds
    const cohorts = new Map<string, string[]>();
    for (const [deviceId, cohortDate] of cohortDates) {
      if (cohortDate < query.startDate || cohortDate > query.endDate) {
        continue;
      }
      const label =
        granularity === "day" ? cohortDate : isoWeekLabel(cohortDate);
      const list = cohorts.get(label);
      if (list) {
        list.push(deviceId);
      } else {
        cohorts.set(label, [deviceId]);
      }
    }

    const periodDays = granularity === "day" ? 1 : 7;
    const result = Array.from(cohorts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cohort, deviceIds]) => {
        // 该 cohort 已完整经过的最大周期数
        const minCohortDate = deviceIds
          .map((id) => cohortDates.get(id)!)
          .sort()[0];
        const maxN = Math.max(
          0,
          Math.floor(dayDiff(minCohortDate, query.endDate) / periodDays),
        );
        const retention: { n: number; rate: number }[] = [];
        for (let n = 0; n <= maxN; n++) {
          if (n === 0) {
            retention.push({ n: 0, rate: 1 });
            continue;
          }
          const retained = deviceIds.filter((deviceId) => {
            const cohortDate = cohortDates.get(deviceId)!;
            const active = activeSets.get(deviceId);
            if (!active) return false;
            for (const dateKey of active) {
              const period = Math.floor(
                dayDiff(cohortDate, dateKey) / periodDays,
              );
              if (period === n) return true;
            }
            return false;
          }).length;
          retention.push({
            n,
            rate:
              deviceIds.length > 0
                ? Math.round((retained / deviceIds.length) * 10000) / 10000
                : 0,
          });
        }
        return { cohort, size: deviceIds.length, retention };
      });

    return { basis, granularity, cohorts: result };
  }

  async getCurve(query: AnalyticsCurveQueryDto) {
    if (
      (query.cohortStartDate && !isValidReportDate(query.cohortStartDate)) ||
      (query.cohortEndDate && !isValidReportDate(query.cohortEndDate))
    ) {
      throw new BadRequestException("Invalid date");
    }

    const [cohortDates, activeSets] = await Promise.all([
      this.getCohortDates("activation"),
      this.getActiveDateSets(),
    ]);

    const today = reportDateInTimezone(new Date(), DEFAULT_REPORT_TIMEZONE);
    const members = Array.from(cohortDates.entries()).filter(
      ([, cohortDate]) =>
        (!query.cohortStartDate || cohortDate >= query.cohortStartDate) &&
        (!query.cohortEndDate || cohortDate <= query.cohortEndDate),
    );

    const points = CURVE_DAYS.map((day) => {
      // 只有激活已满 day 天的设备才计入该点分母
      const eligible = members.filter(
        ([, cohortDate]) => dayDiff(cohortDate, today) >= day,
      );
      if (eligible.length === 0) {
        return { day, rate: null };
      }
      const retained = eligible.filter(([deviceId, cohortDate]) =>
        activeSets.get(deviceId)?.has(shiftReportDate(cohortDate, day)),
      ).length;
      return {
        day,
        rate: Math.round((retained / eligible.length) * 10000) / 10000,
      };
    });

    return { points, cohortSize: members.length };
  }

  async getActivationFunnel(query: AnalyticsDateRangeQueryDto) {
    this.assertValidRange(query.startDate, query.endDate);

    const [cohortDates, activeSets] = await Promise.all([
      this.getCohortDates("activation"),
      this.getActiveDateSets(),
    ]);

    const cohort = Array.from(cohortDates.entries()).filter(
      ([, cohortDate]) =>
        cohortDate >= query.startDate && cohortDate <= query.endDate,
    );

    const activated = cohort.length;
    const firstConversation = cohort.filter(([deviceId]) =>
      activeSets.has(deviceId),
    ).length;
    const activeDn = (n: number) =>
      cohort.filter(
        ([deviceId, cohortDate]) =>
          dayDiff(cohortDate, query.endDate) >= n &&
          activeSets.get(deviceId)?.has(shiftReportDate(cohortDate, n)),
      ).length;

    const steps = [
      { key: "shipped", label: "出货", value: null as number | null },
      { key: "activated", label: "绑定激活", value: activated },
      {
        key: "first_conversation",
        label: "首次对话",
        value: firstConversation,
      },
      { key: "active_d7", label: "7日留存", value: activeDn(7) },
      { key: "active_d30", label: "30日留存", value: activeDn(30) },
    ];

    const conversionRates = steps.slice(1).map((step, index) => {
      const from = steps[index];
      return {
        from: from.key,
        to: step.key,
        rate:
          from.value && from.value > 0
            ? Math.round((step.value / from.value) * 10000) / 10000
            : null,
      };
    });

    return { steps, conversionRates };
  }

  /**
   * 截至 date 最新可算 cohort 的 D1/D7/D30 使用率：
   * cohort = 激活日恰好为 date-N 的设备，分子 = 这些设备在 date 当天有 user 消息。
   * 分母为 0 时返回 null。
   */
  async getLatestRetention(
    date: string,
  ): Promise<{ d1: number | null; d7: number | null; d30: number | null }> {
    const [cohortDates, activeSets] = await Promise.all([
      this.getCohortDates("activation"),
      this.getActiveDateSets(),
    ]);

    const rate = (n: number): number | null => {
      const cohortDate = shiftReportDate(date, -n);
      const members = Array.from(cohortDates.entries()).filter(
        ([, value]) => value === cohortDate,
      );
      if (members.length === 0) return null;
      const retained = members.filter(([deviceId]) =>
        activeSets.get(deviceId)?.has(date),
      ).length;
      return Math.round((retained / members.length) * 10000) / 10000;
    };

    return { d1: rate(1), d7: rate(7), d30: rate(30) };
  }
}
