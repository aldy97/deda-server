import { Controller, Get, Header, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { AppAssetsService } from "./app-assets.service";

@ApiTags("app-assets")
@Controller("app-assets")
export class AppAssetsController {
  constructor(private readonly service: AppAssetsService) {}

  @Get("manifest")
  // manifest 是易变快照：客户端一旦存副本，revalidate 会拿到 304，
  // 而小程序 request 层只认 2xx，会把 304 判成失败并回退旧缓存。
  // 因此禁止任何存储，保证发布后下一次请求即生效。
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "公开素材 manifest（无鉴权）" })
  async manifest(@Res({ passthrough: true }) res: Response) {
    const manifest = await this.service.getManifest();
    res.setHeader("ETag", `"${manifest.version}"`);
    return manifest;
  }
}
