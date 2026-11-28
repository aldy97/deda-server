import { createHash } from "crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OSS = require("ali-oss");
import type { VideoStudioConfig } from "@/config/video.config";
import type { AssetStore, PutResult } from "../ports/media.ports";

export class AssetStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AssetStoreError";
  }
}

/**
 * OSS 私有桶存储。
 *
 * 刻意不把 objectKey 拼成公网 URL 落库：签名会过期，存下来的只会是死链。
 * 读路径一律由调用方现签（dashboard 播放、给 wan3.0 当参考图）。
 */
@Injectable()
export class OssAssetStore implements AssetStore {
  private client: OSS | null = null;

  constructor(private readonly configService: ConfigService) {}

  async put(
    objectKey: string,
    body: Buffer,
    contentType: string,
  ): Promise<PutResult> {
    await this.oss().put(objectKey, body, { mime: contentType });
    return {
      objectKey,
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  }

  signedUrl(objectKey: string, ttlSec?: number): string {
    const config = this.videoConfig();
    return this.oss().signatureUrl(objectKey, {
      expires: ttlSec ?? config.oss.signedUrlTtlSec,
    });
  }

  private oss(): OSS {
    if (this.client) return this.client;
    const config = this.videoConfig();
    const { region, bucket, accessKeyId, accessKeySecret, endpoint } =
      config.oss;
    if (!region || !bucket || !accessKeyId || !accessKeySecret) {
      throw new AssetStoreError(
        "OSS_NOT_CONFIGURED",
        "OSS 未配置：需要 OSS_REGION / OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET",
      );
    }
    this.client = new OSS({
      region,
      bucket,
      accessKeyId,
      accessKeySecret,
      ...(endpoint ? { endpoint } : {}),
      secure: true,
    });
    return this.client;
  }

  private videoConfig(): VideoStudioConfig {
    const config = this.configService.get<VideoStudioConfig>("video");
    if (!config) {
      throw new AssetStoreError("CONFIG_MISSING", "video 配置未加载");
    }
    return config;
  }
}
