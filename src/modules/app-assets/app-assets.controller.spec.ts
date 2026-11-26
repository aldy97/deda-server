import { Response } from "express";
import { AppAssetsController } from "./app-assets.controller";
import { AppAssetsService } from "./app-assets.service";

describe("AppAssetsController", () => {
  let controller: AppAssetsController;
  let service: { getManifest: jest.Mock };

  beforeEach(() => {
    service = {
      getManifest: jest.fn().mockResolvedValue({ version: "", assets: {} }),
    };
    controller = new AppAssetsController(
      service as unknown as AppAssetsService,
    );
  });

  it("manifest 接口不挂鉴权守卫", () => {
    expect(
      Reflect.getMetadata("__guards__", AppAssetsController),
    ).toBeUndefined();
  });

  it("manifest 设置 Cache-Control 头", () => {
    const headers = Reflect.getMetadata(
      "__headers__",
      AppAssetsController.prototype.manifest,
    ) as Array<{ name: string; value: string }>;
    expect(headers).toContainEqual({
      name: "Cache-Control",
      value: "public, max-age=60, stale-while-revalidate=300",
    });
  });

  it("manifest 委托 service 并设置 ETag", async () => {
    const res = { setHeader: jest.fn() } as unknown as Response;
    service.getManifest.mockResolvedValue({
      version: "2026-11-25T00:00:00.000Z",
      assets: {},
    });

    const result = await controller.manifest(res);

    expect(service.getManifest).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      "ETag",
      '"2026-11-25T00:00:00.000Z"',
    );
    expect(result).toEqual({
      version: "2026-11-25T00:00:00.000Z",
      assets: {},
    });
  });
});
