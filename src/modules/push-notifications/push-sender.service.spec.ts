import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { PushSenderService } from "./push-sender.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { WechatTokenService } from "@/common/wechat/wechat-token.service";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const TMPL = "tmpl-sleep-reminder";
const INPUT = {
  deviceInternalId: "dev-internal-1",
  deviceId: "elly-001",
  sleepTime: "21:30",
};

interface PrismaMock {
  userDeviceBinding: { findMany: jest.Mock };
  childProfile: { findUnique: jest.Mock };
  pushSubscription: { findUnique: jest.Mock; updateMany: jest.Mock };
}

describe("PushSenderService", () => {
  let service: PushSenderService;
  let prisma: PrismaMock;
  let wechatToken: { getAccessToken: jest.Mock };
  let configValues: Record<string, string | undefined>;

  const bindingOf = (userId: string, openid: string | null) => ({
    userId,
    deviceId: INPUT.deviceInternalId,
    user: { id: userId, openid },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      userDeviceBinding: { findMany: jest.fn() },
      childProfile: { findUnique: jest.fn() },
      pushSubscription: { findUnique: jest.fn(), updateMany: jest.fn() },
    };
    wechatToken = { getAccessToken: jest.fn().mockResolvedValue("token-1") };
    configValues = {
      PUSH_NOTIFICATIONS_ENABLED: "true",
      WECHAT_TMPL_SLEEP_REMINDER: TMPL,
    };
    const configService = {
      get: jest.fn((key: string) => configValues[key]),
    };
    service = new PushSenderService(
      prisma as unknown as PrismaService,
      wechatToken as unknown as WechatTokenService,
      configService as unknown as ConfigService,
    );

    prisma.userDeviceBinding.findMany.mockResolvedValue([
      bindingOf("u1", "openid-1"),
      bindingOf("u2", "openid-2"),
    ]);
    prisma.childProfile.findUnique.mockResolvedValue({
      name: "熊熊",
      englishName: null,
    });
    prisma.pushSubscription.findUnique.mockResolvedValue({
      quota: 5,
      status: "active",
    });
    mockedAxios.post.mockResolvedValue({ data: { errcode: 0 } });
  });

  it("未开启 PUSH_NOTIFICATIONS_ENABLED 时不查库、不发送", async () => {
    configValues.PUSH_NOTIFICATIONS_ENABLED = undefined;

    const res = await service.sendSleepReminder(INPUT);

    expect(res).toEqual({ sent: 0, skipped: 0 });
    expect(prisma.userDeviceBinding.findMany).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("未配置模板 ID 时不发送", async () => {
    configValues.WECHAT_TMPL_SLEEP_REMINDER = undefined;

    await service.sendSleepReminder(INPUT);

    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("access_token 不可用（未配 appid）时不发送", async () => {
    wechatToken.getAccessToken.mockResolvedValue(null);

    await service.sendSleepReminder(INPUT);

    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it("多家长绑定同一台设备时全推，成功后各扣 1 点额度", async () => {
    const res = await service.sendSleepReminder(INPUT);

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    expect(prisma.pushSubscription.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.pushSubscription.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", templateId: TMPL, quota: { gt: 0 } },
      data: { quota: { decrement: 1 } },
    });
    expect(prisma.pushSubscription.updateMany).toHaveBeenCalledWith({
      where: { userId: "u2", templateId: TMPL, quota: { gt: 0 } },
      data: { quota: { decrement: 1 } },
    });
    expect(res).toEqual({ sent: 2, skipped: 0 });
  });

  it("发送体包含 touser/template/page/data，page 带设备业务 ID", async () => {
    await service.sendSleepReminder(INPUT);

    const [url, body] = mockedAxios.post.mock.calls[0] as [string, any];
    expect(url).toContain(
      "https://api.weixin.qq.com/cgi-bin/message/subscribe/send",
    );
    expect(url).toContain("access_token=token-1");
    expect(body).toMatchObject({
      touser: "openid-1",
      template_id: TMPL,
      page: "/pages/sleep-manage/sleep-manage?id=elly-001",
      data: {
        thing1: { value: "熊熊的哄睡时间到啦" },
        time2: { value: "21:30" },
      },
    });
    expect(body.data.phrase3.value).toBeTruthy();
  });

  it("孩子名超长时 thing 字段截断到 20 字符", async () => {
    prisma.childProfile.findUnique.mockResolvedValue({
      name: "一个特别特别长的孩子名字超过二十个字符的名字",
      englishName: null,
    });

    await service.sendSleepReminder(INPUT);

    const body = mockedAxios.post.mock.calls[0][1] as any;
    expect(body.data.thing1.value.length).toBeLessThanOrEqual(20);
  });

  it("无孩子档案时称呼降级为「宝贝」", async () => {
    prisma.childProfile.findUnique.mockResolvedValue(null);

    await service.sendSleepReminder(INPUT);

    const body = mockedAxios.post.mock.calls[0][1] as any;
    expect(body.data.thing1.value).toBe("宝贝的哄睡时间到啦");
  });

  it.each([
    ["无订阅记录", null],
    ["额度为 0", { quota: 0, status: "active" }],
    ["状态 rejected", { quota: 3, status: "rejected" }],
    ["状态 exhausted", { quota: 3, status: "exhausted" }],
  ])("%s 的家长跳过发送", async (_label, subscription) => {
    prisma.pushSubscription.findUnique.mockResolvedValue(subscription);

    const res = await service.sendSleepReminder(INPUT);

    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(res).toEqual({ sent: 0, skipped: 2 });
  });

  it("用户缺 openid 时跳过", async () => {
    prisma.userDeviceBinding.findMany.mockResolvedValue([
      bindingOf("u1", null),
    ]);

    const res = await service.sendSleepReminder(INPUT);

    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(res).toEqual({ sent: 0, skipped: 1 });
  });

  it("设备无任何绑定时不发送", async () => {
    prisma.userDeviceBinding.findMany.mockResolvedValue([]);

    const res = await service.sendSleepReminder(INPUT);

    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(res).toEqual({ sent: 0, skipped: 0 });
  });

  it("errcode 43101（额度耗尽）时清零并标记 exhausted，不再扣减", async () => {
    mockedAxios.post.mockResolvedValue({ data: { errcode: 43101 } });

    const res = await service.sendSleepReminder(INPUT);

    expect(prisma.pushSubscription.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", templateId: TMPL },
      data: { quota: 0, status: "exhausted" },
    });
    expect(prisma.pushSubscription.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { quota: { decrement: 1 } } }),
    );
    expect(res).toEqual({ sent: 0, skipped: 2 });
  });

  it("errcode 40001（token 失效）时强制刷新 token 重试一次，成功则扣额度", async () => {
    mockedAxios.post
      .mockResolvedValueOnce({ data: { errcode: 40001 } })
      .mockResolvedValue({ data: { errcode: 0 } });
    wechatToken.getAccessToken
      .mockResolvedValueOnce("token-1")
      .mockResolvedValue("token-2");

    const res = await service.sendSleepReminder(INPUT);

    expect(wechatToken.getAccessToken).toHaveBeenCalledWith({
      forceRefresh: true,
    });
    expect(mockedAxios.post.mock.calls[1][0]).toContain("access_token=token-2");
    expect(res.sent).toBeGreaterThan(0);
  });

  it("刷新 token 后重试仍失败时不扣额度、不抛错", async () => {
    mockedAxios.post.mockResolvedValue({ data: { errcode: 40001 } });
    wechatToken.getAccessToken.mockResolvedValue("token-x");

    const res = await service.sendSleepReminder(INPUT);

    expect(prisma.pushSubscription.updateMany).not.toHaveBeenCalled();
    expect(res).toEqual({ sent: 0, skipped: 2 });
  });

  it("其他 errcode 时 warn 跳过、不扣额度、不抛错", async () => {
    mockedAxios.post.mockResolvedValue({
      data: { errcode: 47003, errmsg: "template_id 不正确" },
    });

    const res = await service.sendSleepReminder(INPUT);

    expect(prisma.pushSubscription.updateMany).not.toHaveBeenCalled();
    expect(res).toEqual({ sent: 0, skipped: 2 });
  });

  it("微信接口网络异常时跳过该用户、不抛错、不影响其他家长", async () => {
    mockedAxios.post
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue({ data: { errcode: 0 } });

    const res = await service.sendSleepReminder(INPUT);

    expect(res).toEqual({ sent: 1, skipped: 1 });
  });
});
