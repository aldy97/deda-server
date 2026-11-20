import axios from "axios";
import { UsersService } from "./users.service";

jest.mock("axios");

describe("UsersService", () => {
  let service: UsersService;
  let prisma: { user: { upsert: jest.Mock; findUnique: jest.Mock } };
  let configService: { get: jest.Mock };
  let jwtService: { sign: jest.Mock };

  beforeEach(() => {
    prisma = {
      user: { upsert: jest.fn(), findUnique: jest.fn() },
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

  it("bindPhone / getProfile / updateProfile", async () => {
    expect(await service.bindPhone({})).toEqual({ phone: "mock-phone" });
    prisma.user.findUnique.mockResolvedValue({ id: "u1" });
    expect(await service.getProfile("u1")).toEqual({ id: "u1" });
    expect(await service.updateProfile("u1", { name: "x" })).toEqual({
      userId: "u1",
      dto: { name: "x" },
    });
  });
});
