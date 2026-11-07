import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test, TestingModule } from "@nestjs/testing";
import { scryptSync } from "crypto";
import { AnalyticsAuthService } from "./analytics-auth.service";
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
  let jwtService: JwtService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsAuthService,
        { provide: ConfigService, useValue: buildConfig(VALID_USERS) },
        { provide: JwtService, useValue: new JwtService({ secret: SECRET }) },
      ],
    }).compile();

    service = module.get(AnalyticsAuthService);
    jwtService = module.get(JwtService);
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
        { provide: JwtService, useValue: new JwtService({ secret: SECRET }) },
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
