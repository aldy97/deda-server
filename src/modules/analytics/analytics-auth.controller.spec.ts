import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test, TestingModule } from "@nestjs/testing";
import { scryptSync } from "crypto";
import {
  AnalyticsAuthService,
  normalizeScopes,
} from "./analytics-auth.service";
import { ANALYTICS_JWT_SERVICE } from "./analytics-auth.service";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { AnalyticsJwtStrategy } from "./strategies/analytics-jwt.strategy";

const SECRET = "test-analytics-secret";
const SALT = "0123456789abcdef0123456789abcdef";
const PASSWORD = "s3cret!";
const PASSWORD_HASH = scryptSync(PASSWORD, SALT, 64).toString("hex");

function buildConfig(usersJson?: string) {
  return {
    get: (key: string) => {
      const values: Record<string, string | undefined> = {
        ANALYTICS_JWT_SECRET: SECRET,
        ANALYTICS_JWT_EXPIRES_IN: "12h",
        ANALYTICS_ADMIN_USERS: usersJson,
      };
      return values[key];
    },
  } as ConfigService;
}

const VALID_USERS = JSON.stringify([
  {
    username: "admin",
    salt: SALT,
    passwordHash: PASSWORD_HASH,
    displayName: "管理员",
  },
]);

describe("AnalyticsAuthService", () => {
  let service: AnalyticsAuthService;
  const jwtService = new JwtService({ secret: SECRET });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsAuthService,
        { provide: ConfigService, useValue: buildConfig(VALID_USERS) },
        { provide: ANALYTICS_JWT_SERVICE, useValue: jwtService },
      ],
    }).compile();

    service = module.get(AnalyticsAuthService);
  });

  it("登录成功返回 token 与 adminInfo，token 带 analytics scope", async () => {
    const result = await service.login("admin", PASSWORD);

    expect(result.adminInfo).toEqual({
      username: "admin",
      displayName: "管理员",
    });

    const payload = await jwtService.verifyAsync(result.token);
    expect(payload.sub).toBe("admin");
    expect(payload.scope).toBe("analytics");
  });

  it("密码错误返回 401", async () => {
    await expect(service.login("admin", "wrong")).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("账号不存在返回 401", async () => {
    await expect(service.login("nobody", PASSWORD)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it("ANALYTICS_ADMIN_USERS 非 JSON 时报错", async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsAuthService,
        { provide: ConfigService, useValue: buildConfig("not-json") },
        {
          provide: ANALYTICS_JWT_SERVICE,
          useValue: new JwtService({ secret: SECRET }),
        },
      ],
    }).compile();
    const broken = module.get(AnalyticsAuthService);

    await expect(broken.login("admin", PASSWORD)).rejects.toThrow(
      "ANALYTICS_ADMIN_USERS is not valid JSON",
    );
  });
});

describe("AnalyticsJwtStrategy", () => {
  it("payload 缺少 analytics scope 时拒绝", async () => {
    const strategy = new AnalyticsJwtStrategy(buildConfig(VALID_USERS));

    await expect(
      strategy.validate({
        sub: "admin",
        username: "admin",
        displayName: "管理员",
        scope: "wechat",
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("合法 payload 返回管理员上下文", async () => {
    const strategy = new AnalyticsJwtStrategy(buildConfig(VALID_USERS));

    await expect(
      strategy.validate({
        sub: "admin",
        username: "admin",
        displayName: "管理员",
        scope: "analytics",
      }),
    ).resolves.toEqual({
      adminId: "admin",
      username: "admin",
      displayName: "管理员",
      scope: "analytics",
      // 旧 token 没有 scopes 声明，补成只有基础作用域：拿不到任何专项权限
      scopes: ["analytics"],
    });
  });
});

describe("AnalyticsAuthGuard", () => {
  const guard = new AnalyticsAuthGuard();

  it("scope 为 analytics 时放行", () => {
    expect(
      guard.handleRequest(null, { adminId: "admin", scope: "analytics" }),
    ).toEqual({ adminId: "admin", scope: "analytics" });
  });

  it("scope 非 analytics 返回 403", () => {
    expect(() =>
      guard.handleRequest(null, { userId: "u1", scope: undefined }),
    ).toThrow(ForbiddenException);
  });

  it("未认证返回 401", () => {
    expect(() => guard.handleRequest(null, null)).toThrow(
      UnauthorizedException,
    );
  });
});

const CONTENT_ADMINS = JSON.stringify([
  {
    username: "author",
    salt: SALT,
    passwordHash: PASSWORD_HASH,
    displayName: "内容创作者",
    scopes: ["analytics", "adventure-content"],
  },
  {
    username: "plain",
    salt: SALT,
    passwordHash: PASSWORD_HASH,
    displayName: "看板管理员",
  },
]);

/**
 * scopes 是内容管理台的「人」这道闸的来源。
 * 断言的重点是：未声明 scopes 的账号拿到的能力和改动之前完全一样（只有 analytics），
 * 即新增作用域不会让任何既有账号意外获得或失去权限。
 */
describe("AnalyticsAuthService scopes", () => {
  let service: AnalyticsAuthService;
  const jwtService = new JwtService({ secret: SECRET });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsAuthService,
        { provide: ConfigService, useValue: buildConfig(CONTENT_ADMINS) },
        { provide: ANALYTICS_JWT_SERVICE, useValue: jwtService },
      ],
    }).compile();

    service = module.get(AnalyticsAuthService);
  });

  it("把账号声明的 scopes 签进 token", async () => {
    const result = await service.login("author", PASSWORD);
    const payload = await jwtService.verifyAsync(result.token);

    expect(payload.scope).toBe("analytics");
    expect(payload.scopes).toEqual(["analytics", "adventure-content"]);
  });

  it("未声明 scopes 的账号只有基础作用域", async () => {
    const result = await service.login("plain", PASSWORD);
    const payload = await jwtService.verifyAsync(result.token);

    expect(payload.scopes).toEqual(["analytics"]);
  });

  it("不因为多了 scopes 就改变 adminInfo 的既有契约", async () => {
    const result = await service.login("author", PASSWORD);

    expect(result.adminInfo).toEqual({
      username: "author",
      displayName: "内容创作者",
    });
  });
});

describe("normalizeScopes", () => {
  it("永远保留 analytics，并去重", () => {
    expect(
      normalizeScopes(["analytics", "adventure-content", "analytics"]),
    ).toEqual(["analytics", "adventure-content"]);
  });

  it("对缺省与畸形输入回落到只有 analytics", () => {
    expect(normalizeScopes()).toEqual(["analytics"]);
    expect(normalizeScopes(null)).toEqual(["analytics"]);
    expect(normalizeScopes([])).toEqual(["analytics"]);
    expect(
      normalizeScopes(["", "  ", "adventure-content"] as string[]),
    ).toEqual(["analytics", "adventure-content"]);
  });
});

describe("AnalyticsJwtStrategy scopes", () => {
  it("透传 token 里声明的 scopes", async () => {
    const strategy = new AnalyticsJwtStrategy(buildConfig(VALID_USERS));

    await expect(
      strategy.validate({
        sub: "admin",
        username: "admin",
        displayName: "管理员",
        scope: "analytics",
        scopes: ["analytics", "adventure-content"],
      }),
    ).resolves.toMatchObject({ scopes: ["analytics", "adventure-content"] });
  });

  it("过滤掉畸形的 scope 项", async () => {
    const strategy = new AnalyticsJwtStrategy(buildConfig(VALID_USERS));

    await expect(
      strategy.validate({
        sub: "admin",
        username: "admin",
        displayName: "管理员",
        scope: "analytics",
        scopes: ["", "adventure-content", null as unknown as string],
      }),
    ).resolves.toMatchObject({ scopes: ["adventure-content"] });
  });
});
