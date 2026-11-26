import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { AppAssetSlotsService } from "./app-asset-slots.service";
import {
  AppAssetVersionsQueryDto,
  CreateAppAssetSlotDto,
  UpdateAppAssetSlotDto,
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
  constructor(
    private readonly service: AppAssetsAdminService,
    private readonly slots: AppAssetSlotsService,
  ) {}

  @Get("keys")
  @ApiOperation({ summary: "展示位注册表（含停用项）" })
  keys() {
    return this.slots.listAll();
  }

  @Post("keys")
  @ApiOperation({ summary: "新建展示位（key = page/suffix）" })
  create(@Body() dto: CreateAppAssetSlotDto, @Req() req: AppAssetsRequest) {
    return this.slots.create(dto, req.user?.username ?? null);
  }

  @Patch("keys")
  @ApiOperation({ summary: "编辑展示位标签/备注，或停用（有线上素材时禁止）" })
  update(@Body() dto: UpdateAppAssetSlotDto, @Req() req: AppAssetsRequest) {
    return this.slots.update(dto, req.user?.username ?? null);
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
