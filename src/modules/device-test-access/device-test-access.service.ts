import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { ADVENTURE_TEST_ENV } from "@/modules/adventure/adventure.constants";

/**
 * 测试设备白名单：冒险测试与哄睡测试共用的设备级资格闸。
 *
 * 为什么单独成模块：它同时被三条链路消费——冒险播放引擎（触发词）、vendor
 * 对话会话（测试哄睡）、冒险管理台（下发前校验）。放在任何一条链路里都会让另外
 * 两条反向依赖，所以做成只依赖 Prisma 的叶子模块。
 *
 * 安全语义：
 * - 写操作只在任一测试开关打开时放行；prod 两个开关都不在，白名单只读。
 * - 撤销是软删除并清空该设备的测试冒险下发字段：阻断下一次触发，但不主动中断
 *   已经开始的测试会话（见 2026-11-22 方案确认）。
 * - 外键 ON DELETE CASCADE：设备被 wipe 后资格自动失效，重新入库必须重新添加。
 */

export interface TestDeviceActor {
  username: string;
  displayName: string;
}

export interface TestDeviceView {
  id: string;
  active: boolean;
  note: string | null;
  addedBy: string;
  addedAt: string;
  addedReason: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  device: {
    id: string;
    deviceId: string;
    deviceCode: string | null;
    macAddress: string | null;
    characterKey: string;
    firmwareVersion: string | null;
  };
}

export interface TestDevicesQuery {
  keyword?: string;
  includeRevoked?: boolean;
  page?: number;
  pageSize?: number;
}

export interface TestDevicesResult {
  enabled: { adventure: boolean; sleep: boolean };
  items: TestDeviceView[];
  total: number;
}

export interface AddTestDeviceInput {
  deviceId: string;
  note?: string | null;
  reason?: string | null;
}

export interface RevokeTestDeviceInput {
  deviceId: string;
  reason?: string | null;
}

/** 与 adventure 内容台同一审计口径：半年后只看理由也能看懂当时为什么放开。 */
export const MIN_TEST_DEVICE_REASON_CHARS = 8;
export const MAX_TEST_DEVICE_REASON_CHARS = 300;

/**
 * 两个测试总开关。adventure 复用既有常量；sleep 的常量定义在
 * sleep-mode.service.ts，但那个文件会引入 DeviceLink/BaiduAgent 依赖，
 * 叶子模块不直接 import，改为字面量并在 spec 里断言与真实常量逐字一致。
 */
export const TEST_DEVICE_ENV = {
  adventure: ADVENTURE_TEST_ENV.enabled,
  sleep: "SLEEP_TEST_MODE_ENABLED",
} as const;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const DEVICE_SELECT = {
  id: true,
  deviceId: true,
  deviceCode: true,
  macAddress: true,
  characterKey: true,
  firmwareVersion: true,
  testAdventureEpisodeId: true,
  testAdventureEpisodeVersionId: true,
} satisfies Prisma.DeviceSelect;

type ResolvedDevice = Prisma.DeviceGetPayload<{
  select: typeof DEVICE_SELECT;
}>;

type WhitelistRowWithDevice = Prisma.DeviceTestWhitelistGetPayload<{
  include: { device: { select: typeof DEVICE_SELECT } };
}>;

function trimToNull(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text.length > 0 ? text : null;
}

function assertReason(reason: string | null | undefined): string {
  const text = (reason ?? "").trim();
  if (text.length < MIN_TEST_DEVICE_REASON_CHARS) {
    throw new BadRequestException({
      message: `变更理由不能少于 ${MIN_TEST_DEVICE_REASON_CHARS} 个字：半年后别人（包括你自己）只能靠理由看懂当时为什么放开/收回。`,
      code: "REASON_REQUIRED",
    });
  }
  if (text.length > MAX_TEST_DEVICE_REASON_CHARS) {
    throw new BadRequestException({
      message: `变更理由不能超过 ${MAX_TEST_DEVICE_REASON_CHARS} 个字。`,
      code: "REASON_TOO_LONG",
    });
  }
  return text;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function toView(row: WhitelistRowWithDevice): TestDeviceView {
  return {
    id: row.id,
    active: row.active,
    note: row.note,
    addedBy: row.addedBy,
    addedAt: row.addedAt.toISOString(),
    addedReason: row.addedReason,
    revokedBy: row.revokedBy,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revokeReason: row.revokeReason,
    device: {
      id: row.device.id,
      deviceId: row.device.deviceId,
      deviceCode: row.device.deviceCode,
      macAddress: row.device.macAddress,
      characterKey: row.device.characterKey,
      firmwareVersion: row.device.firmwareVersion,
    },
  };
}

@Injectable()
export class DeviceTestAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /** 运行时闸：只有 active=true 的行放行。调用方应先用触发词/环境开关短路。 */
  async isAllowed(deviceInternalId: string): Promise<boolean> {
    const count = await this.prisma.deviceTestWhitelist.count({
      where: { deviceId: deviceInternalId, active: true },
    });
    return count > 0;
  }

  /** 白名单列表。默认只看在册；includeRevoked=true 时连已撤销的行一起看。 */
  async list(query: TestDevicesQuery = {}): Promise<TestDevicesResult> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(query.pageSize ?? DEFAULT_PAGE_SIZE)),
    );

    const where: Prisma.DeviceTestWhitelistWhereInput = {};
    if (!query.includeRevoked) {
      where.active = true;
    }

    const keyword = trimToNull(query.keyword);
    if (keyword) {
      where.device = {
        is: {
          OR: [
            { deviceId: { contains: keyword, mode: "insensitive" } },
            { deviceCode: { contains: keyword, mode: "insensitive" } },
            { macAddress: { contains: keyword, mode: "insensitive" } },
          ],
        },
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.deviceTestWhitelist.findMany({
        where,
        include: { device: { select: DEVICE_SELECT } },
        orderBy: { addedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.deviceTestWhitelist.count({ where }),
    ]);

    return {
      enabled: this.enabledState(),
      total,
      items: rows.map(toView),
    };
  }

  /** 添加或恢复。已 active → 409；已撤销 → 原地恢复并返回 reactivated=true。 */
  async add(input: AddTestDeviceInput, actor: TestDeviceActor) {
    this.assertWriteEnabled();
    const reason = assertReason(input.reason);
    const note = trimToNull(input.note);
    const device = await this.resolveDevice(input.deviceId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.deviceTestWhitelist.findUnique({
          where: { deviceId: device.id },
        });
        if (existing?.active) {
          throw new ConflictException("这台设备已经在测试白名单里。");
        }
        if (existing) {
          const row = await tx.deviceTestWhitelist.update({
            where: { deviceId: device.id },
            data: {
              active: true,
              note,
              addedBy: actor.username,
              addedAt: new Date(),
              addedReason: reason,
              revokedBy: null,
              revokedAt: null,
              revokeReason: null,
            },
            include: { device: { select: DEVICE_SELECT } },
          });
          return { item: toView(row), reactivated: true };
        }
        const row = await tx.deviceTestWhitelist.create({
          data: {
            deviceId: device.id,
            note,
            addedBy: actor.username,
            addedReason: reason,
          },
          include: { device: { select: DEVICE_SELECT } },
        });
        return { item: toView(row), reactivated: false };
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException("这台设备已经在测试白名单里。");
      }
      throw error;
    }
  }

  /**
   * 撤销：软删除 + 清空该设备的测试冒险下发字段。
   * 不重置会话、不中断进行中的测试故事——只阻断下一次触发。
   */
  async revoke(input: RevokeTestDeviceInput, actor: TestDeviceActor) {
    this.assertWriteEnabled();
    const reason = assertReason(input.reason);
    const device = await this.resolveDevice(input.deviceId);

    const existing = await this.prisma.deviceTestWhitelist.findUnique({
      where: { deviceId: device.id },
    });
    if (!existing) {
      throw new NotFoundException("该设备不在测试白名单里。");
    }
    if (!existing.active) {
      throw new ConflictException("该设备已经在白名单撤销状态。");
    }

    const cleared = Boolean(
      device.testAdventureEpisodeId || device.testAdventureEpisodeVersionId,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.deviceTestWhitelist.update({
        where: { deviceId: device.id },
        data: {
          active: false,
          revokedBy: actor.username,
          revokedAt: new Date(),
          revokeReason: reason,
        },
      });
      if (cleared) {
        await tx.device.update({
          where: { id: device.id },
          data: {
            testAdventureEpisodeId: null,
            testAdventureEpisodeVersionId: null,
          },
        });
      }
    });

    return { ok: true as const, clearedAdventureAssignment: cleared };
  }

  private enabledState(): { adventure: boolean; sleep: boolean } {
    return {
      adventure:
        this.configService.get<string>(TEST_DEVICE_ENV.adventure) === "true",
      sleep: this.configService.get<string>(TEST_DEVICE_ENV.sleep) === "true",
    };
  }

  /** 两个开关都关（prod）时写操作 403；只读仍可查看。 */
  private assertWriteEnabled(): void {
    const enabled = this.enabledState();
    if (!enabled.adventure && !enabled.sleep) {
      throw new ForbiddenException(
        "当前环境未开启测试模式（ADVENTURE_TEST_MODE_ENABLED / SLEEP_TEST_MODE_ENABLED 都为 false），白名单只读。",
      );
    }
  }

  /**
   * 业务标识 → 内部 UUID。按 deviceId → deviceCode → macAddress 的顺序逐条查，
   * 不用 OR：同一个输入同时命中多台时，顺序必须确定，否则添加结果不可解释。
   */
  private async resolveDevice(raw: string): Promise<ResolvedDevice> {
    const key = (raw ?? "").trim();
    if (!key) {
      throw new BadRequestException("设备标识不能为空。");
    }
    const lookups: Prisma.DeviceWhereInput[] = [
      { deviceId: { equals: key, mode: "insensitive" } },
      { deviceCode: { equals: key, mode: "insensitive" } },
      { macAddress: { equals: key, mode: "insensitive" } },
    ];
    for (const where of lookups) {
      const device = await this.prisma.device.findFirst({
        where,
        select: DEVICE_SELECT,
      });
      if (device) {
        return device;
      }
    }
    throw new NotFoundException(`设备不存在：${key}`);
  }
}
