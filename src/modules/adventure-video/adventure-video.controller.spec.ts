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
    previewUrl: jest.fn(),
    downloadUrl: jest.fn(),
    validateStoryboardDraft: jest.fn(),
    saveStoryboard: jest.fn(),
    revoiceStoryboard: jest.fn(),
    regenerateStoryboard: jest.fn(),
    approveStoryboard: jest.fn(),
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
      reason: "给这一集做一支 60 秒故事短片",
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

  it("分镜审核路由：validate 不传 actor，写操作都带审计身份", async () => {
    const { controller, service } = makeController();
    service.validateStoryboardDraft.mockResolvedValue({ ok: true });
    service.saveStoryboard.mockResolvedValue({});
    service.revoiceStoryboard.mockResolvedValue({});
    service.regenerateStoryboard.mockResolvedValue({});
    service.approveStoryboard.mockResolvedValue({});
    service.downloadUrl.mockResolvedValue({ url: "https://oss/x" });

    const storyboard = { stylePrompt: "p", beats: [] };
    await controller.validateStoryboard("job1", { storyboard });
    await controller.saveStoryboard(
      "job1",
      { storyboard, expectedRevision: 1, reason: "改文案" },
      REQ,
    );
    await controller.revoiceStoryboard(
      "job1",
      { expectedRevision: 1, reason: "重新配音" },
      REQ,
    );
    await controller.regenerateStoryboard(
      "job1",
      { expectedRevision: 1, reason: "重新生成" },
      REQ,
    );
    await controller.approveStoryboard(
      "job1",
      { expectedRevision: 1, reason: "审批通过" },
      REQ,
    );
    await controller.downloadUrl("job1");

    expect(service.validateStoryboardDraft).toHaveBeenCalledWith("job1", {
      storyboard,
    });
    const actor = {
      username: "xiong",
      displayName: "熊总",
      profile: "authoring",
    };
    expect(service.saveStoryboard).toHaveBeenCalledWith(
      "job1",
      expect.any(Object),
      actor,
    );
    expect(service.revoiceStoryboard).toHaveBeenCalledWith(
      "job1",
      expect.any(Object),
      actor,
    );
    expect(service.regenerateStoryboard).toHaveBeenCalledWith(
      "job1",
      expect.any(Object),
      actor,
    );
    expect(service.approveStoryboard).toHaveBeenCalledWith(
      "job1",
      expect.any(Object),
      actor,
    );
    expect(service.downloadUrl).toHaveBeenCalledWith("job1");
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
