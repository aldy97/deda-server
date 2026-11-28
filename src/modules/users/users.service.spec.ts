import axios from "axios";
import { UsersService } from "./users.service";

jest.mock("axios");

describe("UsersService", () => {
  let service: UsersService;
  let prisma: {
    user: {
      upsert: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    userDeviceBinding: { count: jest.Mock };
    childProfile: { count: jest.Mock };
  };
  let configService: { get: jest.Mock };
  let jwtService: { sign: jest.Mock };

  beforeEach(() => {
    prisma = {
      user: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      userDeviceBinding: { count: jest.fn().mockResolvedValue(0) },
      childProfile: { count: jest.fn().mockResolvedValue(0) },
    };
    configService = { get: jest.fn() };
    jwtService = { sign: jest.fn().mockReturnValue("signed-token") };
    service = new UsersService(
      prisma as never,
      configService as never,
      jwtService as never,
    );
    (axios.get as jest.Mock).mockReset();
  });

  it("开发环境（未配 AppSecret）模拟 jscode2session 返回稳定 openid", async () => {
    configService.get.mockReturnValue("");
    prisma.user.upsert.mockResolvedValue({
      id: "u1",
      openid: "dev-openid-stable",
      phone: null,
    });

    const r = await service.wechatLogin({ code: "c" });

    expect(r.token).toBe("signed-token");
    expect(r.userInfo.openid).toBe("dev-openid-stable");
    expect(r.userInfo.phone).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("真实微信登录：code 换 openid 后 upsert 并签发", async () => {
    configService.get.mockImplementation((k: string) =>
      k === "WECHAT_APPID" ? "appid" : "secret-with-16-chars-ok",
    );
    (axios.get as jest.Mock).mockResolvedValue({
      data: { openid: "real-openid" },
    });
    prisma.user.upsert.mockResolvedValue({
      id: "u2",
      openid: "real-openid",
      phone: "13800000000",
    });

    const r = await service.wechatLogin({ code: "c" });

    expect(axios.get).toHaveBeenCalledWith(
      "https://api.weixin.qq.com/sns/jscode2session",
      expect.objectContaining({
        params: expect.objectContaining({ js_code: "c" }),
      }),
    );
    expect(r.userInfo.openid).toBe("real-openid");
    expect(r.userInfo.phone).toBe("13800000000");
  });

  it("真实微信登录微信侧返回 errcode 时抛错", async () => {
    configService.get.mockImplementation((k: string) =>
      k === "WECHAT_APPID" ? "appid" : "secret-with-16-chars-ok",
    );
    (axios.get as jest.Mock).mockResolvedValue({
      data: { errcode: 40029, errmsg: "invalid code" },
    });

    await expect(service.wechatLogin({ code: "bad" })).rejects.toThrow(
      "WeChat login failed",
    );
  });

  it("bindPhone 保持原样回显 mock 手机号", async () => {
    expect(await service.bindPhone({})).toEqual({ phone: "mock-phone" });
  });

  describe("getProfile", () => {
    it("只读档案字段 + 两个计数，响应不含 openid", async () => {
      const createdAt = new Date("2026-11-01T02:00:00Z");
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        nickname: "熊熊妈妈",
        phone: "13800000000",
        gender: "female",
        birthday: "1990-05-20",
        createdAt,
      });
      prisma.userDeviceBinding.count.mockResolvedValue(2);
      prisma.childProfile.count.mockResolvedValue(2);

      const result = await service.getProfile("u1");

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: "u1" },
        select: {
          id: true,
          nickname: true,
          phone: true,
          gender: true,
          birthday: true,
          createdAt: true,
        },
      });
      expect(prisma.userDeviceBinding.count).toHaveBeenCalledWith({
        where: { userId: "u1" },
      });
      // 孩子数以「绑定设备上的孩子档案」口径统计，不按 childProfile.userId
      expect(prisma.childProfile.count).toHaveBeenCalledWith({
        where: { device: { bindings: { some: { userId: "u1" } } } },
      });
      expect(result).toEqual({
        id: "u1",
        nickname: "熊熊妈妈",
        phone: "13800000000",
        gender: "female",
        birthday: "1990-05-20",
        createdAt,
        deviceCount: 2,
        childCount: 2,
      });
      expect(result).not.toHaveProperty("openid");
      expect(Object.keys(result as object).sort()).toEqual([
        "birthday",
        "childCount",
        "createdAt",
        "deviceCount",
        "gender",
        "id",
        "nickname",
        "phone",
      ]);
    });

    it("用户不存在时返回 null，不做计数", async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getProfile("missing")).resolves.toBeNull();
      expect(prisma.userDeviceBinding.count).not.toHaveBeenCalled();
      expect(prisma.childProfile.count).not.toHaveBeenCalled();
    });
  });

  describe("updateProfile", () => {
    it("只写传入的字段并回读最新档案", async () => {
      prisma.user.update.mockResolvedValue({ id: "u1" });
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        nickname: "小熊妈妈",
        phone: null,
        gender: "female",
        birthday: "1990-05-20",
        createdAt: new Date("2026-11-01T02:00:00Z"),
      });

      const result = await service.updateProfile("u1", {
        nickname: "小熊妈妈",
        gender: "female",
        birthday: "1990-05-20",
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: {
          nickname: "小熊妈妈",
          gender: "female",
          birthday: "1990-05-20",
        },
      });
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: "u1" },
        select: {
          id: true,
          nickname: true,
          phone: true,
          gender: true,
          birthday: true,
          createdAt: true,
        },
      });
      expect(result).toMatchObject({
        id: "u1",
        nickname: "小熊妈妈",
        gender: "female",
        birthday: "1990-05-20",
      });
      expect(result).not.toHaveProperty("openid");
    });

    it("只传性别时昵称不被覆盖", async () => {
      prisma.user.update.mockResolvedValue({ id: "u1" });
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        nickname: "熊爸爸",
        phone: null,
        gender: "male",
        birthday: null,
        createdAt: new Date("2026-11-01T02:00:00Z"),
      });

      await service.updateProfile("u1", { gender: "male" });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: {
          nickname: undefined,
          gender: "male",
          birthday: undefined,
        },
      });
    });

    it("null 表示清空性别与生日", async () => {
      prisma.user.update.mockResolvedValue({ id: "u1" });
      prisma.user.findUnique.mockResolvedValue({
        id: "u1",
        nickname: "熊爸爸",
        phone: null,
        gender: null,
        birthday: null,
        createdAt: new Date("2026-11-01T02:00:00Z"),
      });

      await service.updateProfile("u1", { gender: null, birthday: null });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: {
          nickname: undefined,
          gender: null,
          birthday: null,
        },
      });
    });

    it("空更新直接 400，不写库", async () => {
      await expect(service.updateProfile("u1", {})).rejects.toThrow(
        "至少提供一个要更新的档案字段",
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe("reportClientInfo", () => {
    it("trim 后更新品牌与上报时间", async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.reportClientInfo("u1", {
        brand: "  Apple  ",
      });

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: {
          phoneBrand: "Apple",
          phoneBrandReportedAt: expect.any(Date),
        },
      });
      expect(result).toEqual({ success: true, skipped: false });
    });

    it("空品牌不写库，避免覆盖旧值", async () => {
      const result = await service.reportClientInfo("u1", { brand: "   " });

      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, skipped: true });
    });

    it("用户不存在时 updateMany 返回 0，按 skipped 处理", async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.reportClientInfo("missing", {
        brand: "HUAWEI",
      });

      expect(result).toEqual({ success: true, skipped: true });
    });
  });
});
