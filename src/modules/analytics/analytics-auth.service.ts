import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { scryptSync, timingSafeEqual } from "crypto";

/**
 * 管理员 JWT 签发服务的注入 token。
 * 不走 JwtModule 全局注册：避免根模块出现多个 JwtService 实例，
 * 导致 app.get(JwtService) 二义性（e2e 与小程序链路共用同一个实例）。
 */
export const ANALYTICS_JWT_SERVICE = "ANALYTICS_JWT_SERVICE";

interface AdminAccount {
  username: string;
  salt: string;
  passwordHash: string;
  displayName: string;
}

export interface AdminInfo {
  username: string;
  displayName: string;
}

/**
 * Dashboard 管理员鉴权服务。
 * 一期账号来源为环境变量白名单 ANALYTICS_ADMIN_USERS（JSON 数组），
 * 密码以 scrypt(salt) 哈希存储；二期将替换为 admin_users 表。
 */
@Injectable()
export class AnalyticsAuthService {
  constructor(
    private readonly configService: ConfigService,
    @Inject(ANALYTICS_JWT_SERVICE)
    private readonly jwtService: JwtService,
  ) {}

  async login(
    username: string,
    password: string,
  ): Promise<{ token: string; adminInfo: AdminInfo }> {
    const account = this.findAccount(username);
    if (!account || !this.verifyPassword(account, password)) {
      throw new UnauthorizedException("Invalid username or password");
    }

    const token = await this.jwtService.signAsync({
      sub: account.username,
      username: account.username,
      displayName: account.displayName,
      scope: "analytics",
    });

    return {
      token,
      adminInfo: {
        username: account.username,
        displayName: account.displayName,
      },
    };
  }

  private findAccount(username: string): AdminAccount | null {
    const accounts = this.parseAccounts();
    return accounts.find((account) => account.username === username) ?? null;
  }

  private parseAccounts(): AdminAccount[] {
    const raw = this.configService.get<string>("ANALYTICS_ADMIN_USERS");
    if (!raw) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("ANALYTICS_ADMIN_USERS is not valid JSON");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("ANALYTICS_ADMIN_USERS must be a JSON array");
    }
    return parsed as AdminAccount[];
  }

  private verifyPassword(account: AdminAccount, password: string): boolean {
    const expected = Buffer.from(account.passwordHash, "hex");
    const actual = scryptSync(password, account.salt, expected.length);
    return expected.length > 0 && timingSafeEqual(expected, actual);
  }
}
