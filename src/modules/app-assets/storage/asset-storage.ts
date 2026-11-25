export interface StoredAsset {
  url: string;
  relativePath: string;
}

/**
 * 素材存储抽象：本期只有 local 驱动，接口保留给后续对象存储驱动。
 */
export abstract class AssetStorage {
  abstract save(input: {
    key: string;
    version: number;
    mimeType: string;
    buffer: Buffer;
  }): Promise<StoredAsset>;

  abstract buildPublicUrl(relativePath: string): string;

  /** 校验 URL host 在有效白名单；非法时抛 BadRequestException。 */
  abstract assertValidPublicUrl(url: string): void;
}
