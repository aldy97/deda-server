import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { SuperAdminGuard } from "./super-admin.guard";

/**
 * 运维组（模型监控 / 冒险内容 / Prompt 管理 / 语速设置 / 设备 wipe）的闸口。
 *
 * 三个必须钉住的方向：
 * 1. superadmin 放行；
 * 2. 普通 admin、以及没有 role 的老 token 一律 403——老 token 保守回落成 admin，
 *    否则「重新登录前拿不到新角色」这条兼容约定会被绕过；
 * 3. 未认证仍然走父类的 401，不能被本守卫包装成 403。
 */
describe("SuperAdminGuard", () => {
  const guard = new SuperAdminGuard();

  const user = (extra: Record<string, unknown> = {}) => ({
    adminId: "superadmin",
    username: "superadmin",
    displayName: "超级管理员",
    scope: "analytics",
    scopes: ["analytics"],
    role: "superadmin",
    ...extra,
  });

  it("superadmin 放行并原样返回上下文", () => {
    expect(guard.handleRequest(null, user())).toMatchObject({
      username: "superadmin",
      role: "superadmin",
    });
  });

  it("普通 admin 返回 403", () => {
    expect(() => guard.handleRequest(null, user({ role: "admin" }))).toThrow(
      ForbiddenException,
    );
  });

  it("没有 role 的老 token 按 admin 处理，返回 403", () => {
    expect(() => guard.handleRequest(null, user({ role: undefined }))).toThrow(
      ForbiddenException,
    );
  });

  it("非法 role 值不被当成 superadmin", () => {
    expect(() => guard.handleRequest(null, user({ role: "root" }))).toThrow(
      ForbiddenException,
    );
  });

  it("scope 不是 analytics 时仍由父类拒绝", () => {
    expect(() => guard.handleRequest(null, user({ scope: "wechat" }))).toThrow(
      ForbiddenException,
    );
  });

  it("未认证返回 401 而不是 403", () => {
    expect(() => guard.handleRequest(null, null)).toThrow(
      UnauthorizedException,
    );
  });
});
