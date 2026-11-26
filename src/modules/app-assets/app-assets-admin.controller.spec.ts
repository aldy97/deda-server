import { AppAssetsAdminController } from "./app-assets-admin.controller";
import { AppAssetsAdminService } from "./app-assets-admin.service";
import { AppAssetSlotsService } from "./app-asset-slots.service";
import { AnalyticsAuthGuard } from "../analytics/guards/analytics-auth.guard";
import { SuperAdminGuard } from "../analytics/guards/super-admin.guard";

describe("AppAssetsAdminController", () => {
  let controller: AppAssetsAdminController;
  let service: {
    list: jest.Mock;
    versions: jest.Mock;
    upload: jest.Mock;
    publish: jest.Mock;
    archive: jest.Mock;
  };
  let slots: {
    listAll: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(() => {
    service = {
      list: jest.fn().mockResolvedValue([]),
      versions: jest.fn().mockResolvedValue([]),
      upload: jest.fn().mockResolvedValue({}),
      publish: jest.fn().mockResolvedValue({}),
      archive: jest.fn().mockResolvedValue({}),
    };
    slots = {
      listAll: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    };
    controller = new AppAssetsAdminController(
      service as unknown as AppAssetsAdminService,
      slots as unknown as AppAssetSlotsService,
    );
  });

  it("整组挂在 SuperAdminGuard 之下", () => {
    const guards = Reflect.getMetadata(
      "__guards__",
      AppAssetsAdminController,
    ) as unknown[];
    expect(guards).toContain(SuperAdminGuard);
    expect(guards).not.toContain(AnalyticsAuthGuard);
  });

  it("keys 走 slots.listAll，list/versions 委托 service", async () => {
    await controller.keys();
    await controller.list();
    await controller.versions({ key: "diagnostics/remote-probe" });

    expect(slots.listAll).toHaveBeenCalled();
    expect(service.list).toHaveBeenCalled();
    expect(service.versions).toHaveBeenCalledWith("diagnostics/remote-probe");
  });

  it("create/update 委托 slots 并透传 username", async () => {
    await controller.create(
      {
        page: "device-home",
        suffix: "hero",
        label: "首页主视觉",
      },
      { user: { username: "superadmin" } } as never,
    );
    await controller.update({ key: "device-home/hero", label: "新标签" }, {
      user: { username: "superadmin" },
    } as never);

    expect(slots.create).toHaveBeenCalledWith(
      { page: "device-home", suffix: "hero", label: "首页主视觉" },
      "superadmin",
    );
    expect(slots.update).toHaveBeenCalledWith(
      { key: "device-home/hero", label: "新标签" },
      "superadmin",
    );
  });

  it("create/update 无 user 时操作人为 null", async () => {
    await controller.create(
      { page: "device-home", suffix: "hero", label: "首页主视觉" },
      {} as never,
    );
    await controller.update(
      { key: "device-home/hero", label: "新标签" },
      {} as never,
    );

    expect(slots.create).toHaveBeenLastCalledWith(expect.anything(), null);
    expect(slots.update).toHaveBeenLastCalledWith(expect.anything(), null);
  });

  it("upload 委托 service 并透传 username", async () => {
    await controller.upload(
      { key: "diagnostics/remote-probe", width: 512, height: 512 },
      { buffer: Buffer.from("x") },
      { user: { username: "superadmin" } } as never,
    );

    expect(service.upload).toHaveBeenCalledWith(
      { key: "diagnostics/remote-probe", width: 512, height: 512 },
      { buffer: Buffer.from("x") },
      "superadmin",
    );
  });

  it("upload 无 user 时 createdBy 为 null", async () => {
    await controller.upload(
      { key: "diagnostics/remote-probe", width: 512, height: 512 },
      { buffer: Buffer.from("x") },
      {} as never,
    );

    expect(service.upload).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      null,
    );
  });

  it("publish/archive 委托 service", async () => {
    await controller.publish("id-1");
    await controller.archive("id-1");

    expect(service.publish).toHaveBeenCalledWith("id-1");
    expect(service.archive).toHaveBeenCalledWith("id-1");
  });
});
