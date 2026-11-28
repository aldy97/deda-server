import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { SuperAdminGuard } from "@/modules/analytics/guards/super-admin.guard";
import {
  ContentAdminGuard,
  ContentReadOnly,
  VideoReviewWrite,
} from "@/modules/adventure-admin/guards/content-admin.guard";
import { ContentAdminExceptionFilter } from "@/modules/adventure-admin/filters/content-admin-exception.filter";
import { resolveContentAdminProfile } from "@/modules/adventure-admin/content-admin-profile";
import type { AuditActor } from "@/modules/adventure-admin/adventure-audit.service";
import { AdventureVideoService } from "./adventure-video.service";
import {
  ApproveStoryboardDto,
  CreateVideoJobDto,
  StoryboardDraftDto,
  StoryboardRevoiceDto,
  StoryboardValidateDto,
  VideoJobActionDto,
  VideoJobQueryDto,
} from "./dto/video-job.dto";

interface RequestWithContentAdmin extends Request {
  user?: {
    adminId?: string;
    username?: string;
    displayName?: string;
    scope?: string;
    scopes?: string[];
  };
}

function trimToNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * 冒险短视频工作台接口。
 *
 * 与 adventure-admin 的关系：**只读它已经发布的快照**，不参与编辑/发布事务。
 * 单独一个控制器、单独一个 guard 组合，是为了让「内容改写」与「花钱出片」
 * 两条权限边界在代码上就分开——以后即使视频接口要单独放开给运营，
 * 也不必动内容管理台的鉴权。
 */
@ApiTags("analytics-adventure-video")
@ApiBearerAuth()
@UseGuards(SuperAdminGuard, ContentAdminGuard)
@UseFilters(ContentAdminExceptionFilter)
@Controller("analytics/adventure-video")
export class AdventureVideoController {
  constructor(
    private readonly service: AdventureVideoService,
    private readonly configService: ConfigService,
  ) {}

  @Get("capabilities")
  @ApiOperation({ summary: "短视频能力：开关、音色模式、画幅、分辨率、预算" })
  capabilities() {
    return this.service.capabilities();
  }

  @Post("jobs")
  @ApiOperation({ summary: "对当前发布版本创建一支故事短片（幂等）" })
  async create(
    @Body() dto: CreateVideoJobDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    return this.service.create(dto.episodeId, dto, this.actor(req));
  }

  @Get("jobs")
  @ApiOperation({ summary: "作业列表：按集筛选，最新在前" })
  list(@Query() query: VideoJobQueryDto) {
    return this.service.list(query);
  }

  @Get("jobs/:jobId")
  @ApiOperation({ summary: "作业详情：阶段、分段、产物与错误" })
  get(@Param("jobId") jobId: string) {
    return this.service.get(jobId);
  }

  @Post("jobs/:jobId/storyboard/validate")
  @ContentReadOnly()
  @ApiOperation({ summary: "校验分镜编辑稿（不写库，只读环境也可用）" })
  validateStoryboard(
    @Param("jobId") jobId: string,
    @Body() dto: StoryboardValidateDto,
  ) {
    return this.service.validateStoryboardDraft(jobId, dto);
  }

  @Put("jobs/:jobId/storyboard")
  @VideoReviewWrite()
  @ApiOperation({ summary: "保存分镜编辑稿（乐观锁 + 审计）" })
  saveStoryboard(
    @Param("jobId") jobId: string,
    @Body() dto: StoryboardDraftDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    return this.service.saveStoryboard(jobId, dto, this.actor(req));
  }

  @Post("jobs/:jobId/storyboard/revoice")
  @VideoReviewWrite()
  @ApiOperation({ summary: "按当前分镜重新配音，回到待审核" })
  revoiceStoryboard(
    @Param("jobId") jobId: string,
    @Body() dto: StoryboardRevoiceDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    return this.service.revoiceStoryboard(jobId, dto, this.actor(req));
  }

  @Post("jobs/:jobId/storyboard/regenerate")
  @VideoReviewWrite()
  @ApiOperation({ summary: "重新生成分镜（结构不对时使用）" })
  regenerateStoryboard(
    @Param("jobId") jobId: string,
    @Body() dto: StoryboardRevoiceDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    return this.service.regenerateStoryboard(jobId, dto, this.actor(req));
  }

  @Post("jobs/:jobId/storyboard/approve")
  @VideoReviewWrite()
  @ApiOperation({ summary: "审批分镜：实测 54–58 秒后进入视频生成" })
  approveStoryboard(
    @Param("jobId") jobId: string,
    @Body() dto: ApproveStoryboardDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    return this.service.approveStoryboard(jobId, dto, this.actor(req));
  }

  @Get("jobs/:jobId/preview-url")
  @ApiOperation({
    summary: "成片播放地址（私有桶现签，过期时间以 expiresInSec 为准）",
  })
  previewUrl(@Param("jobId") jobId: string) {
    return this.service.previewUrl(jobId);
  }

  @Get("jobs/:jobId/download-url")
  @ApiOperation({ summary: "成片下载地址（OSS attachment，点击时现签）" })
  downloadUrl(@Param("jobId") jobId: string) {
    return this.service.downloadUrl(jobId);
  }

  @Post("jobs/:jobId/retry")
  @ApiOperation({ summary: "重试失败/已取消的作业（同一行，不新建）" })
  retry(
    @Param("jobId") jobId: string,
    @Body() dto: VideoJobActionDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    return this.service.retry(jobId, this.actor(req), dto?.reason);
  }

  @Post("jobs/:jobId/cancel")
  @ApiOperation({ summary: "取消排队中/运行中的作业" })
  cancel(
    @Param("jobId") jobId: string,
    @Body() dto: VideoJobActionDto,
    @Req() req: RequestWithContentAdmin,
  ) {
    return this.service.cancel(jobId, this.actor(req), dto?.reason);
  }

  /** 审计必须能追到具体的人：缺 username 直接拒绝，不回落成 "anonymous"。 */
  private actor(req: RequestWithContentAdmin): AuditActor {
    const user = req?.user;
    const username = trimToNull(user?.username);
    if (!username) {
      throw new UnauthorizedException(
        "管理员身份缺少 username，拒绝执行视频生成：审计必须能追到具体的人。",
      );
    }
    return {
      username,
      displayName: trimToNull(user?.displayName) ?? username,
      profile: resolveContentAdminProfile(this.configService),
    };
  }
}
