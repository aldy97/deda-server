import { Test } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "@/common/prisma/prisma.module";
import { AppAssetsModule } from "./app-assets.module";
import { AppAssetsController } from "./app-assets.controller";
import { AppAssetsAdminController } from "./app-assets-admin.controller";
import { AssetStorage } from "./storage/asset-storage";
import { LocalAssetStorage } from "./storage/local-asset-storage";
import { AnalyticsAuthGuard } from "../analytics/guards/analytics-auth.guard";
import { SuperAdminGuard } from "../analytics/guards/super-admin.guard";

describe("AppAssetsModule 装配", () => {
  it("guard / 控制器 / 存储驱动均可解析", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        AppAssetsModule,
      ],
    }).compile();

    expect(moduleRef.get(AnalyticsAuthGuard)).toBeDefined();
    expect(moduleRef.get(SuperAdminGuard)).toBeDefined();
    expect(moduleRef.get(AppAssetsController)).toBeDefined();
    expect(moduleRef.get(AppAssetsAdminController)).toBeDefined();
    expect(moduleRef.get(AssetStorage)).toBeInstanceOf(LocalAssetStorage);
  });
});
