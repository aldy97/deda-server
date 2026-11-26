import { Controller, Get, Header, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { AppAssetsService } from "./app-assets.service";

@ApiTags("app-assets")
@Controller("app-assets")
export class AppAssetsController {
  constructor(private readonly service: AppAssetsService) {}

  @Get("manifest")
  @Header("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
  @ApiOperation({ summary: "公开素材 manifest（无鉴权）" })
  async manifest(@Res({ passthrough: true }) res: Response) {
    const manifest = await this.service.getManifest();
    res.setHeader("ETag", `"${manifest.version}"`);
    return manifest;
  }
}
