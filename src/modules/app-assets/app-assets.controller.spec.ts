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

  it("manifest 禁止客户端缓存：no-store，且不得出现可复用指令", () => {
    const headers = Reflect.getMetadata(
      "__headers__",
      AppAssetsController.prototype.manifest,
    ) as Array<{ name: string; value: string }>;
    const cacheControl = headers.find(
      (header) => header.name === "Cache-Control",
    );

    expect(cacheControl?.value).toBe("no-store");
    expect(cacheControl?.value).not.toMatch(
      /max-age|stale-while-revalidate|must-revalidate/,
    );
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
