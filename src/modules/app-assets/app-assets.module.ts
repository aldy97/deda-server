import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { AppAssetsController } from "./app-assets.controller";
import { AppAssetsFilesController } from "./app-assets-files.controller";
import { AppAssetsService } from "./app-assets.service";
import { AppAssetsAdminController } from "./app-assets-admin.controller";
import { AppAssetsAdminService } from "./app-assets-admin.service";
import { AssetStorage } from "./storage/asset-storage";
import { LocalAssetStorage } from "./storage/local-asset-storage";
import { AnalyticsAuthGuard } from "../analytics/guards/analytics-auth.guard";
import { SuperAdminGuard } from "../analytics/guards/super-admin.guard";

@Module({
  imports: [PassportModule],
  controllers: [
    AppAssetsController,
    AppAssetsFilesController,
    AppAssetsAdminController,
  ],
  providers: [
    AppAssetsService,
    AppAssetsAdminService,
    { provide: AssetStorage, useClass: LocalAssetStorage },
    AnalyticsAuthGuard,
    SuperAdminGuard,
  ],
})
export class AppAssetsModule {}
