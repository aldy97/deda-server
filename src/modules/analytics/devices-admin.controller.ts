import {
  Controller,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { PrismaService } from "@/common/prisma/prisma.service";
import { DeviceLinkService } from "../device-link/device-link.service";
import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";

/**
 * Dashboard 设备运维接口（管理员）
 *
 * wipe 用于退货/流转场景：admin 拿到机芯后手动触发，先下发 recover
 * 恢复出厂指令，再删除 Device 记录（schema 中 12 个关联均为 onDelete:
 * Cascade，绑定、对话、档案、记忆等随设备行一并清除）。设备之后重新
 * 配网上报 loginMac 时，将作为全新设备入库。
 *
 * 家长小程序侧解绑（DELETE /devices/:id）不触发本流程，仅删除绑定关系。
 */
@ApiTags("analytics-devices")
@ApiBearerAuth()
@UseGuards(AnalyticsAuthGuard)
@Controller("analytics/devices")
export class DevicesAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deviceLink: DeviceLinkService,
  ) {}

  @Post(":deviceId/wipe")
  @ApiOperation({
    summary:
      "退货设备数据清除：下发恢复出厂指令并删除设备全部数据（绑定/对话/档案/记忆级联删除）",
  })
  async wipe(@Param("deviceId") deviceId: string) {
    const device = await this.prisma.device.findUnique({
      where: { deviceId },
    });
    if (!device) {
      throw new NotFoundException(`Device ${deviceId} not found`);
    }

    const mac = device.macAddress ?? device.deviceId;
    const link = await this.deviceLink.getStatus(mac);

    // 先发 recover 再删数据：设备离线时 recover 可能送达不到（QoS1 仅对
    // 持久会话排队），照常删数据并返回 deviceOnline=false，提示 admin
    // 到手后需手动复位设备。
    this.deviceLink.factoryReset(mac);
    await this.prisma.device.delete({ where: { id: device.id } });

    return { success: true, deviceId, deviceOnline: link.online };
  }
}
