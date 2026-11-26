import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { AnalyticsMetaController } from "./analytics-meta.controller";
import { PromptAdminService } from "./prompt-admin.service";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { SuperAdminGuard } from "./guards/super-admin.guard";

/**
 * `/analytics/meta` 的职责有两个，都不能退化：
 *
 * 1. 环境标签的真相源——普通 admin 也必须读得到，否则全站环境标签会变成
 *    「未知环境」并连带禁用发布按钮（fail-closed 的代价太大，不该由权限承担）。
 * 2. 前端判断「能不能进运维组」的唯一来源——superadmin 角色由它下发，
 *    前端不解析 token。
 */
describe("AnalyticsMetaController", () => {
  const promptService = {
    getWritePolicy: jest.fn().mockReturnValue({
      promptWriteEnabled: true,
      publishConfirmCode: "DEDA2025",
    }),
  };

  async function build(nodeEnv: string | null) {
    const module = await Test.createTestingModule({
      controllers: [AnalyticsMetaController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === "NODE_ENV" ? (nodeEnv ?? undefined) : undefined,
          },
        },
        { provide: PromptAdminService, useValue: promptService },
      ],
    }).compile();
    return module.get(AnalyticsMetaController);
  }

  it("下发环境、写策略与当前管理员角色", async () => {
    const controller = await build("staging");

    const result = controller.meta({
      user: {
        username: "superadmin",
        displayName: "超级管理员",
        role: "superadmin",
      },
    });

    expect(result).toEqual({
      nodeEnv: "staging",
      promptWriteEnabled: true,
      publishConfirmCode: "DEDA2025",
      admin: {
        username: "superadmin",
        displayName: "超级管理员",
        role: "superadmin",
      },
    });
  });

  it("普通 admin 读到的是 admin，不是超级管理员", async () => {
    const controller = await build("production");

    const result = controller.meta({
      user: { username: "ops", displayName: "运营", role: "admin" },
    });

    expect(result.admin).toEqual({
      username: "ops",
      displayName: "运营",
      role: "admin",
    });
  });

  it("缺 role 的上下文按 admin 下发（老 token 兼容）", async () => {
    const controller = await build("development");

    const result = controller.meta({
      user: { username: "legacy", displayName: "旧账号" },
    });

    expect(result.admin?.role).toBe("admin");
  });

  it("NODE_ENV 未配置时回落 development", async () => {
    const controller = await build(null);

    expect(
      controller.meta({
        user: { username: "legacy", displayName: "旧账号", role: "admin" },
      }).nodeEnv,
    ).toBe("development");
  });

  it("只挂基础闸，不能被 SuperAdminGuard 挡住（看板管理员也要能拿环境标签）", () => {
    const guards = Reflect.getMetadata(
      "__guards__",
      AnalyticsMetaController,
    ) as unknown[];

    expect(guards).toContain(AnalyticsAuthGuard);
    expect(guards).not.toContain(SuperAdminGuard);
  });
});
