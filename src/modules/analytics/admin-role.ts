/**
 * Dashboard 管理员角色。
 *
 * `scope` 回答「是不是 dashboard 管理员」，`scopes` 回答「能碰哪些专项模块」，
 * `role` 回答「是不是能做破坏性操作的人」——运维组（模型监控 / 冒险内容 /
 * Prompt 管理 / 语速设置 / 设备 wipe）只看 role。
 *
 * 兼容口径与 scopes 一致：未声明或配错一律回落 `admin`（fail-closed），
 * 老 token 因此等价于「重新登录之前没有运维权限」。
 */
export type AdminRole = "superadmin" | "admin";

export const SUPER_ADMIN_ROLE: AdminRole = "superadmin";

export function normalizeAdminRole(raw?: unknown): AdminRole {
  return raw === SUPER_ADMIN_ROLE ? SUPER_ADMIN_ROLE : "admin";
}

export function isSuperAdmin(
  user?: { role?: unknown } | null | undefined,
): boolean {
  return normalizeAdminRole(user?.role) === SUPER_ADMIN_ROLE;
}
