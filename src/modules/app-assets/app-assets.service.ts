import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AppAssetSlotsService } from "./app-asset-slots.service";

export interface AppAssetsManifestItem {
  url: string;
  width: number;
  height: number;
  version: number;
  updatedAt: string;
}

export interface AppAssetsManifest {
  version: string;
  assets: Record<string, AppAssetsManifestItem>;
}

@Injectable()
export class AppAssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slots: AppAssetSlotsService,
  ) {}

  async getManifest(): Promise<AppAssetsManifest> {
    const enabled = await this.slots.enabledKeySet();
    const rows = await this.prisma.appAsset.findMany({
      where: { status: "published" },
      orderBy: [{ key: "asc" }, { version: "desc" }],
    });

    const assets: Record<string, AppAssetsManifestItem> = {};
    let maxUpdatedAt: Date | null = null;

    for (const row of rows) {
      // 只下发已注册且启用的展示位；停用后小程序回退包内图。
      if (!enabled.has(row.key)) continue;
      // 每 key 只取最新一条（version 降序后的首条）。
      if (!(row.key in assets)) {
        assets[row.key] = {
          url: row.url,
          width: row.width,
          height: row.height,
          version: row.version,
          updatedAt: row.updatedAt.toISOString(),
        };
      }
      if (!maxUpdatedAt || row.updatedAt > maxUpdatedAt) {
        maxUpdatedAt = row.updatedAt;
      }
    }

    return {
      version: maxUpdatedAt ? maxUpdatedAt.toISOString() : "",
      assets,
    };
  }
}
