import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AnalyticsAuthGuard } from "@/modules/analytics/guards/analytics-auth.guard";
import {
  CONTENT_ADMIN_SCOPE,
  resolveContentAdminProfile,
} from "../content-admin-profile";

/**
 * 冒险内容管理台守卫。继承 AnalyticsAuthGuard，所以 passport 校验与
 * scope==="analytics" 的基础闸**一字不改**地先跑一遍，本类只在其之上加两道：
 *
 * 1. **人的闸**：JWT 的 scopes 必须含 adventure-content。看板管理员默认没有，
 *    所以内容管理台对他们连读都是 403。旧 token 没有 scopes 字段，
 *    策略层会补成 ["analytics"]，等价于「重新登录前拿不到内容权限」。
 * 2. **环境的闸**：写操作要求 CONTENT_ADMIN_PROFILE=authoring。
 *    prod 不配这个变量 → 只读。
 *
 * 判定「是不是写操作」按 HTTP 方法，**默认非 GET/HEAD 一律视为写**（fail-safe）：
 * 新增一个 POST 路由时忘记标 @ContentReadOnly()，后果是只读环境里它被挡住，
 * 而不是 prod 上多出一个能改内容的口子。确实不写库的 POST（试播、校验、
 * 导入预览）用 @ContentReadOnly() 显式豁免。
 */

export const CONTENT_READ_ONLY_METADATA_KEY = "adventure-content:read-only";

/** 标在「方法不是 GET 但确实不写库」的路由上，使其在只读环境也可用。 */
export const ContentReadOnly = () =>
  SetMetadata(CONTENT_READ_ONLY_METADATA_KEY, true);

const READ_METHODS = ["GET", "HEAD", "OPTIONS"];

@Injectable()
export class ContentAdminGuard extends AnalyticsAuthGuard {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 父类里包含 passport 校验 + scope==="analytics"；不通过会直接抛 401/403
    await super.canActivate(context);

    const request = context.switchToHttp().getRequest();
    const scopes = Array.isArray(request?.user?.scopes)
      ? request.user.scopes
      : [];
    if (!scopes.includes(CONTENT_ADMIN_SCOPE)) {
      throw new ForbiddenException("Adventure content scope required");
    }

    if (this.isMutation(context, request) && !this.canAuthor()) {
      throw new ForbiddenException(
        "本环境未开放内容写入（CONTENT_ADMIN_PROFILE 不是 authoring）。" +
          "prod 只读是设计如此：内容请先在 staging 改好、验证过，再用导入搬过来。",
      );
    }
    return true;
  }

  private isMutation(context: ExecutionContext, request: unknown): boolean {
    const readOnly =
      this.reflector.getAllAndOverride<boolean>(
        CONTENT_READ_ONLY_METADATA_KEY,
        [context.getHandler(), context.getClass()],
      ) === true;
    if (readOnly) {
      return false;
    }
    const method = String(
      (request as { method?: string })?.method ?? "",
    ).toUpperCase();
    return !READ_METHODS.includes(method);
  }

  private canAuthor(): boolean {
    return resolveContentAdminProfile(this.configService) === "authoring";
  }
}
