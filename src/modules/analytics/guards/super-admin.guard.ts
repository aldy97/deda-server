import { ForbiddenException, Injectable } from "@nestjs/common";
import { isSuperAdmin } from "../admin-role";
import { AnalyticsAuthGuard } from "./analytics-auth.guard";

/**
 * 运维组闸口：只有 `role === "superadmin"` 的账号能过。
 *
 * 继承 AnalyticsAuthGuard，所以「签名有效 + scope === analytics」这两道基础闸
 * 先原样跑一遍（失败分别是 401 / 403），本类只在其上加一层角色判定。
 *
 * 覆盖范围是全部破坏性操作：模型监控、Prompt 管理、语速设置、冒险内容管理台、
 * 设备 wipe。老 token 没有 role 字段，策略层会补成 admin，所以升级后必须重新
 * 登录才能拿到运维权限——这是刻意 fail-closed，不是故障。
 */
@Injectable()
export class SuperAdminGuard extends AnalyticsAuthGuard {
  handleRequest<TUser = any>(err: any, user: TUser): TUser {
    const resolved = super.handleRequest(err, user);
    if (!isSuperAdmin(resolved as { role?: unknown } | null)) {
      throw new ForbiddenException("需要超级管理员权限");
    }
    return resolved;
  }
}
