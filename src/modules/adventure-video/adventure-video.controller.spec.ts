import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AdventureVideoController } from "./adventure-video.controller";

function makeController() {
  const service = {
    capabilities: jest.fn(),
    create: jest.fn(),
    list: jest.fn(),
    get: jest.fn(),
    retry: jest.fn(),
    cancel: jest.fn(),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === "CONTENT_ADMIN_PROFILE" ? "authoring" : undefined,
    ),
  } as unknown as ConfigService;
  const controller = new AdventureVideoController(
    service as never,
    config as never,
  );
  return { controller, service };
}

const REQ = {
  user: { username: "xiong", displayName: "熊总" },
} as never;

describe("AdventureVideoController", () => {
  it("capabilities 直接委托 service", async () => {
    const { controller, service } = makeController();
    service.capabilities.mockResolvedValue({ enabled: true });
    await expect(controller.capabilities()).resolves.toEqual({ enabled: true });
  });

  it("create 把请求体与审计身份一起下传", async () => {
    const { controller, service } = makeController();
    service.create.mockResolvedValue({ reused: false });
    const dto = {
      episodeId: "ep1",
      episodeVersionId: "v1",
      requestId: "req-12345678",
      reason: "给这一集做一支 60 秒预告",
    };

    await controller.create(dto, REQ);

    expect(service.create).toHaveBeenCalledWith("ep1", dto, {
      username: "xiong",
      displayName: "熊总",
      profile: "authoring",
    });
  });

  it("缺少 username 时拒绝，绝不回落成匿名", async () => {
    const { controller } = makeController();
    await expect(
      controller.create(
        {
          episodeId: "ep1",
          episodeVersionId: "v1",
          requestId: "req-12345678",
        },
        { user: {} } as never,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("retry / cancel 透传 reason", async () => {
    const { controller, service } = makeController();
    service.retry.mockResolvedValue({});
    service.cancel.mockResolvedValue({});
    await controller.retry("job1", { reason: "重跑一次" }, REQ);
    await controller.cancel("job1", { reason: "不投了" }, REQ);
    expect(service.retry).toHaveBeenCalledWith(
      "job1",
      expect.any(Object),
      "重跑一次",
    );
    expect(service.cancel).toHaveBeenCalledWith(
      "job1",
      expect.any(Object),
      "不投了",
    );
  });
});
