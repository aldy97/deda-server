import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import {
  APP_ASSET_PUBLIC_BASE_URL_DEFAULT,
  isValidAssetKey,
  resolveAllowedHosts,
  resolveAssetLocalDir,
  sha256Hex,
  validateAssetUrl,
} from "../app-assets.constants";
import { AssetStorage } from "./asset-storage";

export interface LocalAssetStorageOptions {
  localDir: string;
  publicBaseUrl: string;
  hosts: string[];
  isProduction: boolean;
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function resolveLocalAssetStorageOptions(
  get: (key: string) => string | undefined,
): LocalAssetStorageOptions {
  const publicBaseUrl =
    (get("APP_ASSET_PUBLIC_BASE_URL") || "").trim() ||
    APP_ASSET_PUBLIC_BASE_URL_DEFAULT;
  return {
    localDir: resolveAssetLocalDir(get("APP_ASSET_LOCAL_DIR")),
    publicBaseUrl,
    hosts: resolveAllowedHosts(publicBaseUrl, get("APP_ASSET_HOSTS")),
    isProduction: (get("NODE_ENV") || "").trim() === "production",
  };
}

@Injectable()
export class LocalAssetStorage extends AssetStorage {
  private readonly options: LocalAssetStorageOptions;

  constructor(configService: ConfigService) {
    super();
    const driver = (
      configService.get<string>("APP_ASSET_STORAGE_DRIVER") || "local"
    )
      .trim()
      .toLowerCase();
    if (driver !== "local") {
      throw new Error(
        `APP_ASSET_STORAGE_DRIVER=${driver} 暂不支持：本期仅实现 local 驱动`,
      );
    }
    this.options = resolveLocalAssetStorageOptions((key) =>
      configService.get<string>(key),
    );
  }

  async save(input: {
    key: string;
    version: number;
    mimeType: string;
    buffer: Buffer;
  }): Promise<{ url: string; relativePath: string }> {
    if (!isValidAssetKey(input.key)) {
      throw new Error(`素材 key 非法：${input.key}`);
    }
    const ext = MIME_EXT[input.mimeType];
    if (!ext) {
      throw new Error(`不支持的 mimeType：${input.mimeType}`);
    }
    const sha = sha256Hex(input.buffer).slice(0, 16);
    const filename = `v${input.version}-${sha}.${ext}`;
    const relativePath = `${input.key}/${filename}`;
    const absolutePath = resolve(
      this.options.localDir,
      ...relativePath.split("/"),
    );
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, input.buffer);
    const url = this.buildPublicUrl(relativePath);
    this.assertValidPublicUrl(url);
    return { url, relativePath };
  }

  buildPublicUrl(relativePath: string): string {
    const base = this.options.publicBaseUrl.replace(/\/+$/, "");
    return `${base}/${relativePath}`;
  }

  assertValidPublicUrl(url: string): void {
    try {
      validateAssetUrl(url, {
        publicBaseUrl: this.options.publicBaseUrl,
        hostsEnv: this.options.hosts.join(","),
        isProduction: this.options.isProduction,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(message);
    }
  }
}
