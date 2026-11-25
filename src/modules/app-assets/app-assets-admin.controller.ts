import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { APP_ASSET_MAX_BYTES_DEFAULT } from "./app-assets.constants";
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { SuperAdminGuard } from "../analytics/guards/super-admin.guard";
import {
  AppAssetsAdminService,
  type UploadedAssetFile,
} from "./app-assets-admin.service";
import {
  AppAssetVersionsQueryDto,
  UploadAppAssetDto,
} from "./dto/app-assets-admin.dto";
import { createMemoryStorage } from "./storage/memory-storage";

interface AppAssetsRequest {
  user?: { username?: string } | null;
}

@ApiTags("analytics-app-assets")
@ApiBearerAuth()
@UseGuards(SuperAdminGuard)
@Controller("analytics/app-assets")
export class AppAssetsAdminController {
  constructor(private readonly service: AppAssetsAdminService) {}

  @Get("keys")
  @ApiOperation({ summary: "展示位注册表" })
  keys() {
    return this.service.keys();
  }

  @Get()
  @ApiOperation({ summary: "素材目录（每 key 的 published/draft/全部版本）" })
  list() {
    return this.service.list();
  }

  @Get("versions")
  @ApiOperation({ summary: "某 key 的版本历史（降序）" })
  versions(@Query() dto: AppAssetVersionsQueryDto) {
    return this.service.versions(dto.key);
  }

  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: createMemoryStorage() as never,
      limits: { fileSize: APP_ASSET_MAX_BYTES_DEFAULT, files: 1 },
    }),
  )
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "上传素材草稿" })
  upload(
    @Body() dto: UploadAppAssetDto,
    @UploadedFile() file: UploadedAssetFile,
    @Req() req: AppAssetsRequest,
  ) {
    return this.service.upload(dto, file, req.user?.username ?? null);
  }

  @Post(":id/publish")
  @ApiOperation({ summary: "发布素材（事务内归档旧 published）" })
  publish(@Param("id") id: string) {
    return this.service.publish(id);
  }

  @Post(":id/archive")
  @ApiOperation({ summary: "下架素材" })
  archive(@Param("id") id: string) {
    return this.service.archive(id);
  }
}
