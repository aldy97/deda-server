import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  DEFAULT_REPORT_TIMEZONE,
  isValidReportDate,
  reportDateInTimezone,
  reportDayRange,
} from "../learning-stats/parent-report-date.util";

export interface UsersSummaryQuery {
  startDate?: string;
  endDate?: string;
}

const AGE_RANGES = [
  { range: "0-3", min: 0, max: 3 },
  { range: "3-6", min: 3, max: 6 },
  { range: "6-9", min: 6, max: 9 },
  { range: "9+", min: 9, max: Infinity },
] as const;

/** 周岁年龄（按 Asia/Shanghai 当日），birthday 非法返回 null */
function ageFromBirthday(birthday: string | null): number | null {
  if (!birthday || !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return null;
  const today = reportDateInTimezone(new Date(), DEFAULT_REPORT_TIMEZONE);
  const [by, bm, bd] = birthday.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  if (Number.isNaN(by) || by > ty) return null;
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age >= 0 ? age : null;
}

@Injectable()
export class UsersAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(query: UsersSummaryQuery) {
    if (
      (query.startDate && !isValidReportDate(query.startDate)) ||
      (query.endDate && !isValidReportDate(query.endDate)) ||
      (query.startDate && query.endDate && query.startDate > query.endDate)
    ) {
      throw new BadRequestException("Invalid date range");
    }

    const [totalUsers, bindings, childProfiles] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.userDeviceBinding.findMany({
        select: { userId: true, deviceId: true },
      }),
      this.prisma.childProfile.groupBy({
        by: ["userId"],
        _count: { _all: true },
      }),
    ]);

    let newUsersInRange: number | null = null;
    if (query.startDate && query.endDate) {
      const { start } = reportDayRange(
        query.startDate,
        DEFAULT_REPORT_TIMEZONE,
      );
      const { end } = reportDayRange(query.endDate, DEFAULT_REPORT_TIMEZONE);
      newUsersInRange = await this.prisma.user.count({
        where: { createdAt: { gte: start, lt: end } },
      });
    }

    const usersWithBoundDevice = new Set(bindings.map((b) => b.userId)).size;
    const multiChildFamilies = childProfiles.filter(
      (group) => group._count._all >= 2,
    ).length;

    return {
      totalUsers,
      newUsersInRange,
      usersWithBoundDevice,
      avgDevicesPerUser:
        usersWithBoundDevice > 0
          ? Math.round((bindings.length / usersWithBoundDevice) * 100) / 100
          : 0,
      multiChildFamilies,
    };
  }

  async getDemographics() {
    const [profiles, devices, bindings] = await Promise.all([
      this.prisma.childProfile.findMany({
        where: { deviceId: { not: null } },
        select: { deviceId: true, birthday: true, gender: true },
      }),
      this.prisma.device.findMany({
        select: { id: true, characterKey: true },
      }),
      this.prisma.userDeviceBinding.findMany({
        select: { deviceId: true },
      }),
    ]);

    const ageDistribution: { range: string; devices: number }[] =
      AGE_RANGES.map(({ range }) => ({
        range,
        devices: 0,
      }));
    let unknown = 0;
    for (const profile of profiles) {
      const age = ageFromBirthday(profile.birthday);
      const index =
        age === null
          ? -1
          : AGE_RANGES.findIndex(({ min, max }) => age >= min && age < max);
      if (index === -1) {
        unknown += 1;
      } else {
        ageDistribution[index].devices += 1;
      }
    }
    ageDistribution.push({ range: "unknown", devices: unknown });

    const genderSplit = { male: 0, female: 0, unset: 0 };
    for (const profile of profiles) {
      if (profile.gender === "male") genderSplit.male += 1;
      else if (profile.gender === "female") genderSplit.female += 1;
      else genderSplit.unset += 1;
    }

    const characterKeyCount = new Map<string, number>();
    for (const device of devices) {
      characterKeyCount.set(
        device.characterKey,
        (characterKeyCount.get(device.characterKey) ?? 0) + 1,
      );
    }
    const characterKeySplit = Array.from(characterKeyCount.entries())
      .map(([characterKey, count]) => ({ characterKey, devices: count }))
      .sort((a, b) => b.devices - a.devices);

    const bindingCountByDevice = new Map<string, number>();
    for (const binding of bindings) {
      bindingCountByDevice.set(
        binding.deviceId,
        (bindingCountByDevice.get(binding.deviceId) ?? 0) + 1,
      );
    }
    const bindingsPerDevice = [
      { count: 1 as number | string, devices: 0 },
      { count: 2 as number | string, devices: 0 },
      { count: "3+" as number | string, devices: 0 },
    ];
    for (const count of bindingCountByDevice.values()) {
      if (count <= 1) bindingsPerDevice[0].devices += 1;
      else if (count === 2) bindingsPerDevice[1].devices += 1;
      else bindingsPerDevice[2].devices += 1;
    }

    return {
      ageDistribution,
      genderSplit,
      characterKeySplit,
      bindingsPerDevice,
    };
  }
}
