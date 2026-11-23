import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SuperAdminGuard } from "@/modules/analytics/guards/super-admin.guard";
import {
  AddTestDeviceDto,
  ListTestDevicesQueryDto,
  RevokeTestDeviceDto,
} from "./dto/test-device-access.dto";
import {
  DeviceTestAccessService,
  TestDeviceActor,
} from "./device-test-access.service";

interface RequestWithAdmin {
  user?: {
    adminId?: string;
    username?: string;
    displayName?: string;
    role?: string;
  };
}

function trimToNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * 测试设备白名单 HTTP 入口。
 *
 * 独立挂 `/analytics/test-devices` 而不是塞进 adventure-admin：这份名单同时管
 * 冒险测试与哄睡测试，塞进冒险内容台会让哄睡运维找不到入口，也会让「内容权限」
 * 与「设备测试权限」变成同一个闸。这里只挂 SuperAdminGuard，环境写闸在服务层
 * （两个测试开关都关 → 写操作 403，只读仍可看）。
 */
@ApiTags("analytics-test-devices")
@ApiBearerAuth()
@UseGuards(SuperAdminGuard)
@Controller("analytics/test-devices")
export class DeviceTestAccessController {
  constructor(private readonly access: DeviceTestAccessService) {}

  @Get()
  @ApiOperation({
    summary: "测试设备白名单列表（默认只看在册；includeRevoked 可看撤销记录）",
  })
  async list(@Query() dto: ListTestDevicesQueryDto) {
    return this.access.list({
      keyword: dto.keyword,
      includeRevoked: dto.includeRevoked,
      page: dto.page,
      pageSize: dto.pageSize,
    });
  }

  @Post()
  @ApiOperation({
    summary: "添加测试设备（已撤销则原地恢复；写操作，理由 >= 8 字）",
  })
  async add(@Body() dto: AddTestDeviceDto, @Req() req: RequestWithAdmin) {
    return this.access.add(
      { deviceId: dto.deviceId, note: dto.note, reason: dto.reason },
      this.actor(req),
    );
  }

  @Post(":deviceId/revoke")
  @ApiOperation({
    summary: "撤销测试设备资格（软删除，并清空该设备的测试冒险下发）",
  })
  async revoke(
    @Param("deviceId") deviceId: string,
    @Body() dto: RevokeTestDeviceDto,
    @Req() req: RequestWithAdmin,
  ) {
    return this.access.revoke(
      { deviceId, reason: dto.reason },
      this.actor(req),
    );
  }

  /** 白名单不是匿名配置：缺 username 直接拒，避免留下无法追责的放行记录。 */
  private actor(req: RequestWithAdmin): TestDeviceActor {
    const user = req?.user;
    const username = trimToNull(user?.username);
    if (!username) {
      throw new UnauthorizedException(
        "管理员身份缺少 username，拒绝修改测试白名单：放行记录必须能追到具体的人。",
      );
    }
    return {
      username,
      displayName: trimToNull(user?.displayName) ?? username,
    };
  }
}
