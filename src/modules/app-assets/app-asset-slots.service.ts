import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { AppAssetSlot } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import {
  APP_ASSET_SLOT_MAX_KEY_LENGTH,
  APP_ASSET_SLOT_MAX_LABEL_LENGTH,
  APP_ASSET_SLOT_MAX_NOTE_LENGTH,
  APP_ASSET_SLOT_MAX_PAGE_LENGTH,
  APP_ASSET_SLOT_PAGE_PATTERN,
  APP_ASSET_SLOT_SUFFIX_PATTERN,
} from "./app-assets.constants";

export interface AppAssetSlotView {
  key: string;
  label: string;
  page: string;
  note: string | null;
  enabled: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAppAssetSlotInput {
  page: string;
  suffix: string;
  label: string;
  note?: string | null;
}

export interface UpdateAppAssetSlotInput {
  key: string;
  label?: string;
  note?: string | null;
  enabled?: boolean;
}

export function toAppAssetSlotView(row: AppAssetSlot): AppAssetSlotView {
  return {
    key: row.key,
    label: row.label,
    page: row.page,
    note: row.note,
    enabled: row.enabled,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function prismaCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function normalizePage(page: string): string {
  const value = page.trim();
  if (
    value.length === 0 ||
    value.length > APP_ASSET_SLOT_MAX_PAGE_LENGTH ||
    !APP_ASSET_SLOT_PAGE_PATTERN.test(value)
  ) {
    throw new BadRequestException(
      `页面 code 必须是小写字母/数字/连字符，长度 1–${APP_ASSET_SLOT_MAX_PAGE_LENGTH}`,
    );
  }
  return value;
}

function normalizeSuffix(suffix: string): string {
  const value = suffix.trim();
  if (value.length === 0 || !APP_ASSET_SLOT_SUFFIX_PATTERN.test(value)) {
    throw new BadRequestException(
      "展示位后缀必须是小写字母/数字/连字符，段之间用 / 分隔",
    );
  }
  return value;
}

function normalizeLabel(label: string): string {
  const value = label.trim();
  if (value.length === 0 || value.length > APP_ASSET_SLOT_MAX_LABEL_LENGTH) {
    throw new BadRequestException(
      `展示位标签长度必须在 1–${APP_ASSET_SLOT_MAX_LABEL_LENGTH}`,
    );
  }
  return value;
}

function normalizeNote(
  note: string | null | undefined,
): string | null | undefined {
  if (note === undefined || note === null) return note;
  const value = note.trim();
  if (value.length > APP_ASSET_SLOT_MAX_NOTE_LENGTH) {
    throw new BadRequestException(
      `展示位备注不能超过 ${APP_ASSET_SLOT_MAX_NOTE_LENGTH} 字`,
    );
  }
  return value.length > 0 ? value : null;
}

@Injectable()
export class AppAssetSlotsService {
  constructor(private readonly prisma: PrismaService) {}

  async listAll(): Promise<AppAssetSlotView[]> {
    const rows = await this.prisma.appAssetSlot.findMany({
      orderBy: [{ page: "asc" }, { key: "asc" }],
    });
    return rows.map(toAppAssetSlotView);
  }

  async listEnabled(): Promise<AppAssetSlotView[]> {
    const rows = await this.prisma.appAssetSlot.findMany({
      where: { enabled: true },
      orderBy: [{ page: "asc" }, { key: "asc" }],
    });
    return rows.map(toAppAssetSlotView);
  }

  async enabledKeySet(): Promise<Set<string>> {
    const rows = await this.prisma.appAssetSlot.findMany({
      where: { enabled: true },
      select: { key: true },
    });
    return new Set(rows.map((row) => row.key));
  }

  async find(key: string): Promise<AppAssetSlotView | null> {
    const row = await this.prisma.appAssetSlot.findUnique({ where: { key } });
    return row ? toAppAssetSlotView(row) : null;
  }

  async assertEnabled(key: string): Promise<AppAssetSlotView> {
    const slot = await this.find(key);
    if (!slot) {
      throw new BadRequestException(`未知的素材 key：${key}`);
    }
    if (!slot.enabled) {
      throw new BadRequestException(`展示位已停用：${key}`);
    }
    return slot;
  }

  async create(
    input: CreateAppAssetSlotInput,
    actor: string | null,
  ): Promise<AppAssetSlotView> {
    const page = normalizePage(input.page);
    const suffix = normalizeSuffix(input.suffix);
    const label = normalizeLabel(input.label);
    const key = `${page}/${suffix}`;
    if (key.length > APP_ASSET_SLOT_MAX_KEY_LENGTH) {
      throw new BadRequestException(
        `展示位 key 不能超过 ${APP_ASSET_SLOT_MAX_KEY_LENGTH} 字符`,
      );
    }

    try {
      const row = await this.prisma.appAssetSlot.create({
        data: {
          key,
          page,
          label,
          note: normalizeNote(input.note) ?? null,
          createdBy: actor,
          updatedBy: actor,
        },
      });
      return toAppAssetSlotView(row);
    } catch (error) {
      if (prismaCode(error) === "P2002") {
        throw new ConflictException(`展示位已存在：${key}`);
      }
      throw error;
    }
  }

  async update(
    input: UpdateAppAssetSlotInput,
    actor: string | null,
  ): Promise<AppAssetSlotView> {
    const key = input.key.trim();
    if (key.length === 0) {
      throw new BadRequestException("缺少展示位 key");
    }
    const existing = await this.find(key);
    if (!existing) {
      throw new NotFoundException(`展示位不存在：${key}`);
    }

    const data: {
      label?: string;
      note?: string | null;
      enabled?: boolean;
      updatedBy: string | null;
    } = { updatedBy: actor };

    if (input.label !== undefined) {
      data.label = normalizeLabel(input.label);
    }
    if (input.note !== undefined) {
      const note = normalizeNote(input.note);
      data.note = note === undefined ? null : note;
    }
    if (input.enabled !== undefined) {
      if (!input.enabled && existing.enabled) {
        const published = await this.prisma.appAsset.count({
          where: { key, status: "published" },
        });
        if (published > 0) {
          throw new ConflictException("该展示位仍有线上素材，请先下架再停用");
        }
      }
      data.enabled = input.enabled;
    }

    if (Object.keys(data).length === 1) {
      throw new BadRequestException("没有需要更新的字段");
    }

    const row = await this.prisma.appAssetSlot.update({
      where: { key },
      data,
    });
    return toAppAssetSlotView(row);
  }
}
