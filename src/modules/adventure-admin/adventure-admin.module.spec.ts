import "reflect-metadata";
import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AdventureAdminController } from "./adventure-admin.controller";
import { AdventureAdminModule } from "./adventure-admin.module";
import { AdventureAuditService } from "./adventure-audit.service";
import { AdventureContentQueryService } from "./adventure-content-query.service";
import { AdventureContentService } from "./adventure-content.service";
import { AdventureTransferService } from "./adventure-transfer.service";
import { ContentAdminGuard } from "./guards/content-admin.guard";

/**
 * 装配测试：只验证「依赖图是完整的」，不碰数据库。
 *
 * 值得单独一个 spec 的原因：漏注册 ContentAdminGuard 或某个 service 不会让
 * tsc / lint / 单测变红，只会在 staging 上让每一条路由 500。这类错误必须在
 * 本地就被拦住。
 */

@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: {} }, Reflector],
  exports: [PrismaService, Reflector],
})
class FakeInfrastructureModule {}

describe("AdventureAdminModule", () => {
  it("resolves the controller, the guard and every content service without a database", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        FakeInfrastructureModule,
        AdventureAdminModule,
      ],
    }).compile();

    expect(moduleRef.get(AdventureAdminController)).toBeInstanceOf(
      AdventureAdminController,
    );
    expect(moduleRef.get(ContentAdminGuard)).toBeInstanceOf(ContentAdminGuard);
    for (const token of [
      AdventureAuditService,
      AdventureContentQueryService,
      AdventureContentService,
      AdventureTransferService,
    ]) {
      expect(moduleRef.get(token)).toBeInstanceOf(token as never);
    }
  });

  it("boots fail-safe: no CONTENT_ADMIN_PROFILE means the guard reports readonly", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        FakeInfrastructureModule,
        AdventureAdminModule,
      ],
    }).compile();

    const profile = moduleRef
      .get(AdventureContentQueryService)
      .capabilities().profile;

    expect(profile).toBe("readonly");
  });

  it("exports nothing, so the play engine cannot inject the authoring services", () => {
    const exported = Reflect.getMetadata("exports", AdventureAdminModule);

    expect(exported ?? []).toEqual([]);
  });

  it("keeps the guard in providers so @UseGuards(ContentAdminGuard) resolves by class", () => {
    const providers = Reflect.getMetadata("providers", AdventureAdminModule);

    expect(providers).toContain(ContentAdminGuard);
  });
});
