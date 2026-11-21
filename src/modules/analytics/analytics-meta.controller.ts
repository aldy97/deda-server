import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { PromptAdminService } from "./prompt-admin.service";
import { normalizeAdminRole } from "./admin-role";

/**
 * 运行时元信息。
 *
 * dashboard 左上角的环境标签（本地 / 测试 / 生产）据此渲染：
 * 前端只拿到 nodeEnv 字符串，配色与中文标签由前端决定，
 * 避免把展示逻辑塞进后端；**取不到该接口时前端必须 fail-closed**，
 * 按「未知环境」处理并禁用所有发布按钮。
 *
 * publishConfirmCode 一并通过这个已鉴权的管理员通道下发，
 * 目的是让前端提示文案与 env 配置保持一致（ops 改码后 UI 不会给错提示）。
 * 它不是访问凭据——真正的闸口是服务端 timingSafeEqual 校验；
 * 前端拿到后**只能用于展示提示，禁止预填输入框**，否则「手动输入」这道
 * 防误操作的闸就形同虚设。
 */
@ApiTags("analytics-meta")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/meta")
export class AnalyticsMetaController {
  constructor(
    private readonly configService: ConfigService,
    private readonly promptAdmin: PromptAdminService,
  ) {}

  @Get()
  @ApiOperation({ summary: "环境标识、prompt 写策略与当前管理员角色" })
  meta(
    @Req()
    req: {
      user: { username: string; displayName: string; role?: string };
    },
  ) {
    return {
      nodeEnv: this.configService.get<string>("NODE_ENV") || "development",
      ...this.promptAdmin.getWritePolicy(),
      // 前端判断能不能进运维组的唯一来源：不解析 token，只信服务端结论。
      admin: {
        username: req.user.username,
        displayName: req.user.displayName,
        role: normalizeAdminRole(req.user.role),
      },
    };
  }
}
