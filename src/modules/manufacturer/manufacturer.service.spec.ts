import { ManufacturerService } from "./manufacturer.service";

describe("ManufacturerService", () => {
  const service = new ManufacturerService(
    {} as never,
    { get: jest.fn(() => "") } as never,
  );

  it("switchConversationMode 返回成功", async () => {
    expect(await service.switchConversationMode("d1", {})).toEqual({
      success: true,
    });
  });

  it("syncModeConfig 回显设备与配置", async () => {
    expect(await service.syncModeConfig("d1", { mode: "english" })).toEqual({
      success: true,
      deviceId: "d1",
    });
  });

  it("getDeviceInfo / getNetworkStatus 返回 null", async () => {
    expect(await service.getDeviceInfo("d1")).toBeNull();
    expect(await service.getNetworkStatus("d1")).toBeNull();
  });

  it("controlVolume / controlBrightness 回显参数", async () => {
    expect(await service.controlVolume("d1", 50)).toEqual({
      success: true,
      deviceId: "d1",
      volume: 50,
    });
    expect(await service.controlBrightness("d1", 80)).toEqual({
      success: true,
      deviceId: "d1",
      brightness: 80,
    });
  });

  it("controlPower / controlInterrupt 回显开关", async () => {
    expect(await service.controlPower("d1", true)).toEqual({
      success: true,
      deviceId: "d1",
      powerOn: true,
    });
    expect(await service.controlInterrupt("d1", false)).toEqual({
      success: true,
      deviceId: "d1",
      interruptEnabled: false,
    });
  });

  it("setSleep / setAutoShutdown 回显参数", async () => {
    expect(await service.setSleep("d1", true, 20)).toEqual({
      success: true,
      deviceId: "d1",
      enabled: true,
      timeoutMinutes: 20,
    });
    expect(await service.setAutoShutdown("d1", false)).toEqual({
      success: true,
      deviceId: "d1",
      enabled: false,
      timeoutMinutes: undefined,
    });
  });

  it("applyWifi 回显 ssid（不回显 password）", async () => {
    expect(await service.applyWifi("d1", "wifi-ssid", "secret")).toEqual({
      success: true,
      deviceId: "d1",
      ssid: "wifi-ssid",
    });
  });

  it("controlMusic 回显参数", async () => {
    expect(await service.controlMusic("d1", "play", "s1", 40)).toEqual({
      success: true,
      deviceId: "d1",
      action: "play",
      songId: "s1",
      volume: 40,
    });
  });

  it("bindNeteaseMusic 回显设备", async () => {
    expect(await service.bindNeteaseMusic("d1", "code")).toEqual({
      success: true,
      deviceId: "d1",
    });
  });

  it("reboot 回显 factoryReset", async () => {
    expect(await service.reboot("d1", true)).toEqual({
      success: true,
      deviceId: "d1",
      factoryReset: true,
    });
  });

  it("ota 回显固件信息", async () => {
    expect(await service.ota("d1", "1.0.0", "http://fw")).toEqual({
      success: true,
      deviceId: "d1",
      firmwareVersion: "1.0.0",
      firmwareUrl: "http://fw",
    });
  });
});
