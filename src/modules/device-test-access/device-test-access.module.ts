import { Module } from "@nestjs/common";
import { SuperAdminGuard } from "@/modules/analytics/guards/super-admin.guard";
import { DeviceTestAccessController } from "./device-test-access.controller";
import { DeviceTestAccessService } from "./device-test-access.service";

/**
 * 测试设备白名单叶子模块。
 *
 * 只依赖全局 PrismaService / ConfigService；被 AdventureModule（触发词）、
 * VendorModule（测试哄睡）和 AdventureAdminModule（下发前校验）导入。
 * 反向依赖一律没有：播放链路不应该知道管理台或内容生产线的存在。
 *
 * SuperAdminGuard 在 providers 里显式注册，因为 @UseGuards(Class) 需要按类解析；
 * 它继承的 "analytics-jwt" passport 策略由 AppModule 里的 AnalyticsModule 注册。
 */
@Module({
  controllers: [DeviceTestAccessController],
  providers: [DeviceTestAccessService, SuperAdminGuard],
  exports: [DeviceTestAccessService],
})
export class DeviceTestAccessModule {}
