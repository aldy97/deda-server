import "reflect-metadata";
import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { PrismaService } from "@/common/prisma/prisma.service";
import { RedisService } from "@/common/redis/redis.service";
import { AdventureModule } from "@/modules/adventure/adventure.module";
import { AdventureRecoveryService } from "@/modules/adventure/adventure-recovery.service";
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

/**
 * RedisService 也在假基建里：AdventureModule 现在被管理台导入，
 * 而 AdventureCircuitBreaker 依赖 RedisService（真身由 @Global 的 RedisModule 提供，
 * 这里不加载它，所以必须自己塞一个空壳，否则依赖图不完整、compile 直接失败）。
 */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: RedisService, useValue: {} },
    Reflector,
  ],
  exports: [PrismaService, RedisService, Reflector],
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
    expect(moduleRef.get(AdventureRecoveryService)).toBeInstanceOf(
      AdventureRecoveryService,
    );
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

  /**
   * 依赖方向是这条测试要钉住的安全事实：管理台可以调引擎的自愈能力，
   * 引擎永远不知道管理台存在。反过来一旦成立，内容生产线上的任何报错
   * 都有可能把孩子正在走的播放链路一起拖下水。
   */
  it("imports AdventureModule one-way: the console may trigger recovery, the engine may not see the console", () => {
    const adminImports: unknown[] =
      Reflect.getMetadata("imports", AdventureAdminModule) ?? [];
    const engineImports: unknown[] =
      Reflect.getMetadata("imports", AdventureModule) ?? [];
    const engineExports: unknown[] =
      Reflect.getMetadata("exports", AdventureModule) ?? [];

    expect(adminImports).toContain(AdventureModule);
    expect(engineImports).not.toContain(AdventureAdminModule);
    expect(engineExports).toContain(AdventureRecoveryService);
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
