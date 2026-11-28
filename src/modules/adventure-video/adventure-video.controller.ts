import {
  Body,
  Controller,
  Get,
  Param,
  Post,
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
import { ContentAdminGuard } from "@/modules/adventure-admin/guards/content-admin.guard";
import { ContentAdminExceptionFilter } from "@/modules/adventure-admin/filters/content-admin-exception.filter";
import { resolveContentAdminProfile } from "@/modules/adventure-admin/content-admin-profile";
import type { AuditActor } from "@/modules/adventure-admin/adventure-audit.service";
import { AdventureVideoService } from "./adventure-video.service";
import {
  CreateVideoJobDto,
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
  @ApiOperation({ summary: "对当前发布版本创建一支 60 秒故事短片（幂等）" })
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

  @Get("jobs/:jobId/preview-url")
  @ApiOperation({ summary: "成片播放地址（私有桶现签，1 小时有效）" })
  previewUrl(@Param("jobId") jobId: string) {
    return this.service.previewUrl(jobId);
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
