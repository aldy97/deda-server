import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { SuperAdminGuard } from "./guards/super-admin.guard";
import { VoiceSpeedAdminController } from "./voice-speed-admin.controller";

/**
 * 语速是全局设备行为，改一次影响所有正在对话的设备——属于运维组，
 * 只对 superadmin 开放；GET 也一起收，避免普通 admin 从接口侧绕过菜单。
 */
describe("VoiceSpeedAdminController", () => {
  const service = {
    get: jest.fn().mockResolvedValue({ normalSpd: 0.7, sleepSpd: 0.5 }),
    update: jest.fn().mockResolvedValue({ normalSpd: 0.8, sleepSpd: 0.6 }),
  };
  const controller = new VoiceSpeedAdminController(service as never);

  it("读写都挂在 SuperAdminGuard 之下", () => {
    const guards = Reflect.getMetadata(
      "__guards__",
      VoiceSpeedAdminController,
    ) as unknown[];

    expect(guards).toContain(SuperAdminGuard);
    expect(guards).not.toContain(AnalyticsAuthGuard);
  });

  it("GET 透传给 service", async () => {
    await expect(controller.get()).resolves.toEqual({
      normalSpd: 0.7,
      sleepSpd: 0.5,
    });
  });

  it("PATCH 把 dto 原样透传", async () => {
    const dto = { normalSpd: 0.8, sleepSpd: 0.6 };

    await expect(controller.update(dto)).resolves.toEqual(dto);
    expect(service.update).toHaveBeenCalledWith(dto);
  });
});
