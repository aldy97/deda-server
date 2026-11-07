import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

/**
 * Dashboard 管理员鉴权守卫。
 * passport 校验签名与过期后，再确认 scope 为 analytics，否则 403。
 */
@Injectable()
export class AnalyticsAuthGuard extends AuthGuard("analytics-jwt") {
  canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }

  handleRequest<TUser = any>(err: any, user: TUser): TUser {
    const resolved = super.handleRequest(err, user, undefined, undefined!);
    if ((resolved as any)?.scope !== "analytics") {
      throw new ForbiddenException("Analytics scope required");
    }
    return resolved;
  }
}
