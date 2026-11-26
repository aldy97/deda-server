import { Controller, Get, NotFoundException, Param, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, statSync } from "fs";
import { resolve, sep } from "path";
import { Response } from "express";
import { resolveAssetLocalDir } from "./app-assets.constants";

/**
 * 本地素材静态文件出口。
 *
 * 不用 ServeStaticModule：AppModule 给 dashboard dist 已经注册了一个
 * ServeStaticModule，同一个模块类再次 forRootAsync 会与其共享动态模块 token，
 * 存在配置被覆盖/不注册的风险。这里用显式 controller，路径可测、缓存头可控。
 */
@Controller("app-assets/files")
export class AppAssetsFilesController {
  constructor(private readonly configService: ConfigService) {}

  @Get(":path(*)")
  get(@Param("path") rawPath: string, @Res() res: Response): void {
    const root = resolve(
      resolveAssetLocalDir(
        this.configService.get<string>("APP_ASSET_LOCAL_DIR"),
      ),
    );
    const segments = decodeURIComponent(rawPath)
      .split("/")
      .filter((segment) => segment.length > 0);
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw new NotFoundException();
    }
    const absolutePath = resolve(root, ...segments);
    if (
      !absolutePath.startsWith(`${root}${sep}`) ||
      !existsSync(absolutePath) ||
      !statSync(absolutePath).isFile()
    ) {
      throw new NotFoundException();
    }

    // 文件名含内容哈希，可长缓存；换图必然换文件名。
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(absolutePath);
  }
}
