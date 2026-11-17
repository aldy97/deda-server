import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

export interface AnalyticsJwtPayload {
  sub: string;
  username: string;
  displayName: string;
  scope: string;
  /**
   * 能力清单。scope 是「是不是 dashboard 管理员」，scopes 是「具体能碰哪些专项模块」。
   * 本次改动之前签发的 token 没有这个字段，validate 会补成 ["analytics"]，
   * 等价于「重新登录之前拿不到任何专项权限」——向后兼容且偏保守。
   */
  scopes?: string[];
}

/**
 * Dashboard 管理员 JWT 策略。
 * 与小程序用户 JWT 物理隔离：独立 secret（ANALYTICS_JWT_SECRET）、
 * 独立策略名（analytics-jwt），payload 必须带 scope="analytics"。
 */
@Injectable()
export class AnalyticsJwtStrategy extends PassportStrategy(
  Strategy,
  "analytics-jwt",
) {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:
        configService.get<string>("ANALYTICS_JWT_SECRET") ||
        "dev-analytics-jwt-secret",
    });
  }

  async validate(payload: AnalyticsJwtPayload) {
    if (!payload.sub || payload.scope !== "analytics") {
      throw new UnauthorizedException("Invalid analytics token payload");
    }
    return {
      adminId: payload.sub,
      username: payload.username,
      displayName: payload.displayName,
      scope: payload.scope,
      scopes: Array.isArray(payload.scopes)
        ? payload.scopes.filter(
            (scope) => typeof scope === "string" && scope.trim(),
          )
        : ["analytics"],
    };
  }
}
