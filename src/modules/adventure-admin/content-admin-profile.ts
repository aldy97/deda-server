import { ConfigService } from "@nestjs/config";

/**
 * 内容管理台的权限档位与作用域常量。
 *
 * 两道闸是**正交**的，缺一不可：
 * - scope（跟着人走）：这个账号有没有资格碰冒险内容。写在 ANALYTICS_ADMIN_USERS 里，
 *   签进 JWT，跨环境一致。
 * - profile（跟着环境走）：这个部署允不允许写。由 CONTENT_ADMIN_PROFILE 决定，
 *   prod 不设即只读，和账号是谁无关。
 *
 * 只有「人有权」且「环境允许」时写操作才放行。这样即使 prod 的账号白名单被
 * 误配成和 staging 一样，prod 依然写不动。
 */

/** 内容管理台作用域；不在 JWT scopes 里的管理员连读都读不到 */
export const CONTENT_ADMIN_SCOPE = "adventure-content";

export type ContentAdminProfile = "authoring" | "readonly";

export const AUTHORIZING_PROFILE: ContentAdminProfile = "authoring";

/**
 * 解析当前部署的内容管理档位。
 *
 * 缺省 readonly（fail-safe）：环境变量漏配、拼错、compose 忘了加，
 * 结果都是「写操作 403」而不是「prod 意外可写」。只有显式写了 authoring 才放开。
 */
export function resolveContentAdminProfile(
  configService: ConfigService,
): ContentAdminProfile {
  return configService.get<string>("CONTENT_ADMIN_PROFILE") ===
    AUTHORIZING_PROFILE
    ? AUTHORIZING_PROFILE
    : "readonly";
}
