import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { WechatTokenService } from "./wechat-token.service";
import { RedisService } from "@/common/redis/redis.service";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("WechatTokenService", () => {
  let service: WechatTokenService;
  let redis: {
    getValue: jest.Mock;
    setValue: jest.Mock;
    deleteValue: jest.Mock;
  };
  let config: { get: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    redis = {
      getValue: jest.fn().mockResolvedValue(null),
      setValue: jest.fn().mockResolvedValue(undefined),
      deleteValue: jest.fn().mockResolvedValue(undefined),
    };
    config = {
      get: jest.fn((key: string) =>
        key === "WECHAT_APPID"
          ? "wx-appid"
          : key === "WECHAT_SECRET"
            ? "wx-secret-1234567890"
            : undefined,
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WechatTokenService,
        { provide: RedisService, useValue: redis },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = module.get(WechatTokenService);
  });

  it("缓存命中时直接返回，不请求微信", async () => {
    redis.getValue.mockResolvedValue("cached-token");

    const token = await service.getAccessToken();

    expect(token).toBe("cached-token");
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("缓存未命中：请求微信并写回缓存（TTL 7000s）", async () => {
    mockedAxios.get.mockResolvedValue({
      data: { access_token: "fresh-token", expires_in: 7200 },
    });

    const token = await service.getAccessToken();

    expect(token).toBe("fresh-token");
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "https://api.weixin.qq.com/cgi-bin/token",
      expect.objectContaining({
        params: expect.objectContaining({
          grant_type: "client_credential",
          appid: "wx-appid",
          secret: "wx-secret-1234567890",
        }),
      }),
    );
    expect(redis.setValue).toHaveBeenCalledWith(
      "wechat:access_token",
      "fresh-token",
      7000,
    );
  });

  it("并发调用 single-flight：只请求一次微信", async () => {
    let resolveRequest!: (v: unknown) => void;
    mockedAxios.get.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }) as never,
    );

    const p1 = service.getAccessToken();
    const p2 = service.getAccessToken();
    const p3 = service.getAccessToken();
    resolveRequest({ data: { access_token: "sf-token", expires_in: 7200 } });

    const [t1, t2, t3] = await Promise.all([p1, p2, p3]);
    expect(t1).toBe("sf-token");
    expect(t2).toBe("sf-token");
    expect(t3).toBe("sf-token");
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it("微信返回 errcode：抛出错误且不写缓存", async () => {
    mockedAxios.get.mockResolvedValue({
      data: { errcode: 40013, errmsg: "invalid appid" },
    });

    await expect(service.getAccessToken()).rejects.toThrow("40013");
    expect(redis.setValue).not.toHaveBeenCalled();
  });

  it("未配置 WECHAT_APPID/SECRET：降级返回 null 不请求", async () => {
    config.get.mockReturnValue(undefined);

    const token = await service.getAccessToken();

    expect(token).toBeNull();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it("forceRefresh：删缓存后重新拉取", async () => {
    redis.getValue.mockResolvedValue("stale-token");
    mockedAxios.get.mockResolvedValue({
      data: { access_token: "new-token", expires_in: 7200 },
    });

    const token = await service.getAccessToken({ forceRefresh: true });

    expect(redis.deleteValue).toHaveBeenCalledWith("wechat:access_token");
    expect(token).toBe("new-token");
  });
});
