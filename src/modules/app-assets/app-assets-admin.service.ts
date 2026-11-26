import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppAsset } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AssetStorage } from "./storage/asset-storage";
import {
  APP_ASSET_MAX_BYTES_DEFAULT,
  APP_ASSET_MAX_DIMENSION_DEFAULT,
  detectImageType,
} from "./app-assets.constants";
import { AppAssetSlotsService } from "./app-asset-slots.service";
import type { UploadAppAssetDto } from "./dto/app-assets-admin.dto";

export interface AppAssetView {
  id: string;
  key: string;
  version: number;
  url: string;
  width: number;
  height: number;
  mimeType: string;
  bytes: number;
  note: string | null;
  status: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface AppAssetsAdminListItem {
  key: string;
  label: string;
  page: string;
  enabled: boolean;
  orphan?: boolean;
  published: AppAssetView | null;
  latestDraft: AppAssetView | null;
  versions: AppAssetView[];
}

export interface UploadedAssetFile {
  buffer: Buffer;
}

export function toAppAssetView(row: AppAsset): AppAssetView {
  return {
    id: row.id,
    key: row.key,
    version: row.version,
    url: row.url,
    width: row.width,
    height: row.height,
    mimeType: row.mimeType,
    bytes: row.bytes,
    note: row.note,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}

const prismaCode = (error: unknown): string | undefined =>
  (error as { code?: string } | null)?.code;

interface GroupBase {
  key: string;
  label: string;
  page: string;
  enabled: boolean;
  orphan?: boolean;
}

@Injectable()
export class AppAssetsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: AssetStorage,
    private readonly configService: ConfigService,
    private readonly slots: AppAssetSlotsService,
  ) {}

  async list(): Promise<AppAssetsAdminListItem[]> {
    const rows = await this.prisma.appAsset.findMany();
    const byKey = new Map<string, AppAsset[]>();
    for (const row of rows) {
      const bucket = byKey.get(row.key) ?? [];
      bucket.push(row);
      byKey.set(row.key, bucket);
    }

    const slots = await this.slots.listAll();
    const known = new Set(slots.map((slot) => slot.key));
    const result: AppAssetsAdminListItem[] = slots.map((slot) =>
      this.buildGroup(
        {
          key: slot.key,
          label: slot.label,
          page: slot.page,
          enabled: slot.enabled,
        },
        byKey.get(slot.key) ?? [],
      ),
    );

    // 注册表里已经没有、但库里仍有历史版本的 key：保留为只读孤儿行，
    // 避免素材管理页把历史素材“弄丢”。
    for (const [key, versions] of byKey) {
      if (known.has(key)) continue;
      result.push(
        this.buildGroup(
          { key, label: key, page: "", enabled: false, orphan: true },
          versions,
        ),
      );
    }

    return result;
  }

  async versions(key: string): Promise<AppAssetView[]> {
    const rows = await this.prisma.appAsset.findMany({
      where: { key },
      orderBy: { version: "desc" },
    });
    if (rows.length === 0) {
      const slot = await this.slots.find(key);
      if (!slot) {
        throw new BadRequestException(`未知的素材 key：${key}`);
      }
    }
    return rows.map(toAppAssetView);
  }

  async upload(
    dto: UploadAppAssetDto,
    file: UploadedAssetFile | undefined,
    createdBy: string | null,
  ): Promise<AppAssetView> {
    await this.slots.assertEnabled(dto.key);
    if (!file || !file.buffer) {
      throw new BadRequestException("缺少素材文件");
    }
    if (file.buffer.length > this.maxBytes()) {
      throw new BadRequestException(
        `素材文件不能超过 ${Math.floor(this.maxBytes() / 1024 / 1024)}MB`,
      );
    }
    const image = detectImageType(file.buffer);
    if (!image) {
      throw new BadRequestException("仅支持 PNG / JPEG / WebP 格式");
    }
    this.assertDimensions(dto.width, dto.height);

    const version = await this.nextVersion(dto.key);
    const { url } = await this.storage.save({
      key: dto.key,
      version,
      mimeType: image.mimeType,
      buffer: file.buffer,
    });

    try {
      const row = await this.prisma.appAsset.create({
        data: {
          key: dto.key,
          version,
          url,
          width: dto.width,
          height: dto.height,
          mimeType: image.mimeType,
          bytes: file.buffer.length,
          note: dto.note ?? null,
          status: "draft",
          createdBy,
        },
      });
      return toAppAssetView(row);
    } catch (error) {
      if (prismaCode(error) === "P2002") {
        throw new ConflictException("素材版本冲突，请重试");
      }
      throw error;
    }
  }

  async publish(id: string): Promise<AppAssetView> {
    let published: AppAsset;
    try {
      published = await this.prisma.$transaction(async (tx) => {
        const target = await tx.appAsset.findUnique({ where: { id } });
        if (!target) {
          throw new NotFoundException("素材不存在");
        }
        if (target.status === "published") {
          return target;
        }
        this.storage.assertValidPublicUrl(target.url);

        // 归档旧 published（同一 key 最多一条 published，partial unique index 兜底并发）
        await tx.appAsset.updateMany({
          where: {
            key: target.key,
            status: "published",
            id: { not: target.id },
          },
          data: { status: "archived" },
        });

        return await tx.appAsset.update({
          where: { id: target.id },
          data: { status: "published", publishedAt: new Date() },
        });
      });
    } catch (error) {
      if (prismaCode(error) === "P2002") {
        throw new ConflictException("并发冲突：同一 key 已存在发布版本");
      }
      throw error;
    }
    return toAppAssetView(published);
  }

  async archive(id: string): Promise<AppAssetView> {
    const target = await this.prisma.appAsset.findUnique({ where: { id } });
    if (!target) {
      throw new NotFoundException("素材不存在");
    }
    const updated = await this.prisma.appAsset.update({
      where: { id },
      data: { status: "archived" },
    });
    return toAppAssetView(updated);
  }

  private buildGroup(
    base: GroupBase,
    rows: AppAsset[],
  ): AppAssetsAdminListItem {
    const versions = [...rows].sort((a, b) => b.version - a.version);
    const published = versions.find((v) => v.status === "published") ?? null;
    const latestDraft = versions.find((v) => v.status === "draft") ?? null;
    return {
      key: base.key,
      label: base.label,
      page: base.page,
      enabled: base.enabled,
      ...(base.orphan ? { orphan: true } : {}),
      published: published ? toAppAssetView(published) : null,
      latestDraft: latestDraft ? toAppAssetView(latestDraft) : null,
      versions: versions.map(toAppAssetView),
    };
  }

  private async nextVersion(key: string): Promise<number> {
    const last = await this.prisma.appAsset.findFirst({
      where: { key },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    return (last?.version ?? 0) + 1;
  }

  private maxBytes(): number {
    const raw = this.configService.get<string>("APP_ASSET_MAX_BYTES");
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0
      ? parsed
      : APP_ASSET_MAX_BYTES_DEFAULT;
  }

  private maxDimension(): number {
    const raw = this.configService.get<string>("APP_ASSET_MAX_DIMENSION");
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0
      ? parsed
      : APP_ASSET_MAX_DIMENSION_DEFAULT;
  }

  private assertDimensions(width: number, height: number): void {
    const max = this.maxDimension();
    if (width < 1 || width > max || height < 1 || height > max) {
      throw new BadRequestException(`素材宽高必须在 1–${max} 之间`);
    }
  }
}
