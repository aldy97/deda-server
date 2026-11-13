import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  PublishPromptDto,
  ResetPromptToDefaultDto,
  RollbackPromptDto,
  SavePromptDraftDto,
} from "./dto/prompt-admin.dto";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { PromptAdminService, type PromptAuthor } from "./prompt-admin.service";

/** analytics-jwt 策略挂在 req.user 上的载荷（与 analytics-auth.controller 同口径） */
export interface AnalyticsRequest {
  user: { username: string; displayName: string };
}

function toAuthor(req: AnalyticsRequest): PromptAuthor {
  return { username: req.user.username, displayName: req.user.displayName };
}

/**
 * Dashboard Prompt 管理接口（管理员）。
 *
 * 路径必须挂在 `analytics/` 前缀下：dashboard 的 vite dev proxy 与生产 nginx
 * 都只转发 `/analytics`，换前缀就要改部署配置。
 *
 * 写操作的确认码在服务端校验（见 PromptAdminService.assertConfirmCode），
 * 前端弹窗只是提醒，不构成安全边界。
 */
@ApiTags("analytics-prompts")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/prompts")
export class PromptAdminController {
  constructor(private readonly promptAdmin: PromptAdminService) {}

  @Get()
  @ApiOperation({
    summary:
      "Prompt catalog：全部可编辑 prompt 的分类、变量契约、当前生效值与草稿/发布状态",
  })
  list() {
    return this.promptAdmin.list();
  }

  @Get(":key")
  @ApiOperation({
    summary:
      "单个 prompt 详情：代码默认值 / 运行时生效值 / 草稿正文 / 已发布正文",
  })
  get(@Param("key") key: string) {
    return this.promptAdmin.get(key);
  }

  @Get(":key/versions")
  @ApiOperation({ summary: "版本历史（审计链，按版本号倒序）" })
  versions(@Param("key") key: string) {
    return this.promptAdmin.listVersions(key);
  }

  @Patch(":key/draft")
  @ApiOperation({
    summary:
      "保存草稿：expectedRevision 乐观锁，与他人并发编辑时返回 409。草稿不影响线上",
  })
  saveDraft(
    @Param("key") key: string,
    @Body() dto: SavePromptDraftDto,
    @Req() req: AnalyticsRequest,
  ) {
    return this.promptAdmin.saveDraft(key, dto, toAuthor(req));
  }

  @Post(":key/publish")
  @HttpCode(200)
  @ApiOperation({
    summary: "发布草稿：立即改变线上所有设备的模型行为，需确认码（服务端校验）",
  })
  publish(
    @Param("key") key: string,
    @Body() dto: PublishPromptDto,
    @Req() req: AnalyticsRequest,
  ) {
    return this.promptAdmin.publish(key, dto, toAuthor(req));
  }

  @Post(":key/rollback")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "回滚到历史版本：以目标版本正文新建 revision 并发布（git revert 语义），需确认码",
  })
  rollback(
    @Param("key") key: string,
    @Body() dto: RollbackPromptDto,
    @Req() req: AnalyticsRequest,
  ) {
    return this.promptAdmin.rollback(key, dto, toAuthor(req));
  }

  @Post(":key/reset-to-default")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "恢复代码默认值：以默认正文新建 revision 并发布（不删模板行），需确认码",
  })
  resetToDefault(
    @Param("key") key: string,
    @Body() dto: ResetPromptToDefaultDto,
    @Req() req: AnalyticsRequest,
  ) {
    return this.promptAdmin.resetToDefault(key, dto, toAuthor(req));
  }
}
