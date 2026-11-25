import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/common/prisma/prisma.service";
import { isRegisteredAssetKey } from "./app-assets.constants";

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
  constructor(private readonly prisma: PrismaService) {}

  async getManifest(): Promise<AppAssetsManifest> {
    const rows = await this.prisma.appAsset.findMany({
      where: { status: "published" },
      orderBy: [{ key: "asc" }, { version: "desc" }],
    });

    const assets: Record<string, AppAssetsManifestItem> = {};
    let maxUpdatedAt: Date | null = null;

    for (const row of rows) {
      // 防御：注册表之外的历史/手工数据不对外暴露。
      if (!isRegisteredAssetKey(row.key)) continue;
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
