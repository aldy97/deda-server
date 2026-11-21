import { AnalyticsAuthGuard } from "./guards/analytics-auth.guard";
import { SuperAdminGuard } from "./guards/super-admin.guard";
import { DevicesAdminController } from "./devices-admin.controller";

/**
 * `POST /analytics/devices/:deviceId/wipe` 是 dashboard 侧唯一的设备数据清除入口：
 * 下发恢复出厂后级联删除设备全部数据。它虽然不在运维组菜单里（入口在设备舰队），
 * 但性质是最重的破坏性操作，必须与运维组同口径——只有 superadmin 能打。
 */
describe("DevicesAdminController", () => {
  const prisma = {
    device: {
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
  };
  const deviceLink = {
    getStatus: jest.fn(),
    factoryReset: jest.fn(),
  };
  const controller = new DevicesAdminController(
    prisma as never,
    deviceLink as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("wipe 挂在 SuperAdminGuard 之下", () => {
    const guards = Reflect.getMetadata(
      "__guards__",
      DevicesAdminController,
    ) as unknown[];

    expect(guards).toContain(SuperAdminGuard);
    expect(guards).not.toContain(AnalyticsAuthGuard);
  });

  it("先下发 recover 再删设备，并回报设备是否在线", async () => {
    prisma.device.findUnique.mockResolvedValue({
      id: "db-1",
      deviceId: "dev-001",
      macAddress: "AA:BB",
    });
    prisma.device.delete.mockResolvedValue({});
    deviceLink.getStatus.mockResolvedValue({ online: true });

    await expect(controller.wipe("dev-001")).resolves.toEqual({
      success: true,
      deviceId: "dev-001",
      deviceOnline: true,
    });
    expect(deviceLink.factoryReset).toHaveBeenCalledWith("AA:BB");
    expect(prisma.device.delete).toHaveBeenCalledWith({
      where: { id: "db-1" },
    });
  });

  it("设备离线时照常删数据，但把 online=false 告诉调用方", async () => {
    prisma.device.findUnique.mockResolvedValue({
      id: "db-1",
      deviceId: "dev-001",
      macAddress: null,
    });
    prisma.device.delete.mockResolvedValue({});
    deviceLink.getStatus.mockResolvedValue({ online: false });

    await expect(controller.wipe("dev-001")).resolves.toEqual({
      success: true,
      deviceId: "dev-001",
      deviceOnline: false,
    });
    // macAddress 为空时用 deviceId 作为机芯标识
    expect(deviceLink.factoryReset).toHaveBeenCalledWith("dev-001");
  });

  it("设备不存在返回 404 且不删任何东西", async () => {
    prisma.device.findUnique.mockResolvedValue(null);

    await expect(controller.wipe("dev-404")).rejects.toMatchObject({
      status: 404,
    });
    expect(prisma.device.delete).not.toHaveBeenCalled();
    expect(deviceLink.factoryReset).not.toHaveBeenCalled();
  });
});
