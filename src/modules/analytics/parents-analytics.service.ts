import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { resolvePhoneMaker } from "./phone-brand.util";

export interface ParentDetail {
  user: {
    id: string;
    nickname: string | null;
    phone: string | null;
    registeredAt: string;
    phoneMaker: string | null;
  };
  summary: {
    deviceCount: number;
    childCount: number;
    feedbackCount: number;
  };
  devices: Array<{
    deviceId: string;
    deviceCode: string | null;
    characterKey: string;
    firmwareVersion: string | null;
    networkType: string | null;
    isOwner: boolean;
    boundAt: string;
    boundUserCount: number;
    lastPresenceDate: string | null;
    childProfile: {
      name: string | null;
      englishName: string | null;
      gender: string | null;
      birthday: string | null;
    } | null;
  }>;
}

/**
 * 家长视角详情（dashboard 用户详情页）。
 * 这是**按 userId 精确取单条**的 PII 面：昵称/手机号只允许出现在这里，
 * 不得进入列表/搜索/聚合/导出接口；openid 永不下发。
 */
@Injectable()
export class ParentsAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getParentDetail(userId: string): Promise<ParentDetail | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        nickname: true,
        phone: true,
        phoneBrand: true,
        createdAt: true,
      },
    });
    if (!user) {
      return null;
    }

    const [bindings, feedbackCount] = await Promise.all([
      this.prisma.userDeviceBinding.findMany({
        where: { userId },
        select: {
          isOwner: true,
          createdAt: true,
          device: {
            select: {
              id: true,
              deviceId: true,
              deviceCode: true,
              characterKey: true,
              firmwareVersion: true,
              networkType: true,
              childProfile: {
                select: {
                  name: true,
                  englishName: true,
                  gender: true,
                  birthday: true,
                },
              },
              // 共享设备识别：该设备上的绑定总数（不限于当前家长）
              bindings: { select: { userId: true } },
            },
          },
        },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      }),
      this.prisma.feedback.count({ where: { userId } }),
    ]);

    const internalDeviceIds = bindings.map((binding) => binding.device.id);
    const presenceRows = internalDeviceIds.length
      ? await this.prisma.devicePresenceDaily.groupBy({
          by: ["deviceId"],
          where: { deviceId: { in: internalDeviceIds } },
          _max: { date: true },
        })
      : [];
    const lastPresenceByDevice = new Map(
      presenceRows.map((row) => [row.deviceId, row._max.date ?? null]),
    );

    const devices = bindings.map((binding) => ({
      deviceId: binding.device.deviceId,
      deviceCode: binding.device.deviceCode,
      characterKey: binding.device.characterKey,
      firmwareVersion: binding.device.firmwareVersion,
      networkType: binding.device.networkType,
      isOwner: binding.isOwner,
      boundAt: binding.createdAt.toISOString(),
      boundUserCount: binding.device.bindings.length,
      lastPresenceDate: lastPresenceByDevice.get(binding.device.id) ?? null,
      childProfile: binding.device.childProfile
        ? {
            name: binding.device.childProfile.name,
            englishName: binding.device.childProfile.englishName,
            gender: binding.device.childProfile.gender,
            birthday: binding.device.childProfile.birthday,
          }
        : null,
    }));

    return {
      user: {
        id: user.id,
        nickname: user.nickname ?? null,
        phone: user.phone ?? null,
        registeredAt: user.createdAt.toISOString(),
        // 与 /analytics/users/phone-brands、设备详情 boundUsers 同一口径：只下发展示名
        phoneMaker: resolvePhoneMaker(user.phoneBrand)?.makerLabel ?? null,
      },
      summary: {
        deviceCount: devices.length,
        // 小结口同一口径：有孩子档案的设备数
        childCount: devices.filter((device) => device.childProfile !== null)
          .length,
        feedbackCount,
      },
      devices,
    };
  }
}
