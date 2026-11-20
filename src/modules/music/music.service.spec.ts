import { MusicService } from "./music.service";

describe("MusicService", () => {
  const service = new MusicService();

  it("getStatus 返回默认播放状态", async () => {
    const s = await service.getStatus("d1");
    expect(s.deviceId).toBe("d1");
    expect(s.playing).toBe(false);
    expect(s.source).toBe("netease");
  });

  it("control 返回成功回执", async () => {
    const r = await service.control({
      deviceId: "d1",
      action: "play",
    } as never);
    expect(r).toEqual({ success: true, deviceId: "d1", action: "play" });
  });

  it("bindNetease 返回绑定成功", async () => {
    const r = await service.bindNetease({
      deviceId: "d1",
      neteaseUserId: null,
    } as never);
    expect(r.bound).toBe(true);
    expect(r.neteaseUserId).toBeNull();
  });
});
