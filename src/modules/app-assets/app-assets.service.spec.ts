import { PrismaService } from "@/common/prisma/prisma.service";
import { AppAssetSlotsService } from "./app-asset-slots.service";
import { AppAssetsService } from "./app-assets.service";

function row(overrides: Record<string, unknown>) {
  return {
    key: "diagnostics/remote-probe",
    version: 1,
    url: "https://staging.valleyletters.com/app-assets/files/diagnostics/remote-probe/v1-a.png",
    width: 512,
    height: 512,
    updatedAt: new Date("2026-11-25T00:00:00.000Z"),
    ...overrides,
  } as never;
}

function makeService(enabledKeys: string[] = ["diagnostics/remote-probe"]) {
  const findMany = jest.fn();
  const enabledKeySet = jest.fn().mockResolvedValue(new Set(enabledKeys));
  const service = new AppAssetsService(
    { appAsset: { findMany } } as unknown as PrismaService,
    { enabledKeySet } as unknown as AppAssetSlotsService,
  );
  return { service, findMany, enabledKeySet };
}

describe("AppAssetsService", () => {
  it("manifest 只查 published，并先取启用 key 集合", async () => {
    const { service, findMany, enabledKeySet } = makeService();
    findMany.mockResolvedValue([]);

    await service.getManifest();

    expect(enabledKeySet).toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith({
      where: { status: "published" },
      orderBy: [{ key: "asc" }, { version: "desc" }],
    });
  });

  it("空数据 version 为空串", async () => {
    const { service, findMany } = makeService();
    findMany.mockResolvedValue([]);
    expect(await service.getManifest()).toEqual({ version: "", assets: {} });
  });

  it("每 key 只取最新一条 published", async () => {
    const { service, findMany } = makeService();
    findMany.mockResolvedValue([
      row({ version: 2, updatedAt: new Date("2026-11-25T02:00:00.000Z") }),
      row({ version: 1, updatedAt: new Date("2026-11-25T01:00:00.000Z") }),
    ]);

    const manifest = await service.getManifest();
    expect(manifest.assets["diagnostics/remote-probe"].version).toBe(2);
    expect(manifest.version).toBe("2026-11-25T02:00:00.000Z");
  });

  it("过滤未注册/停用的 key，且不把它们的 updatedAt 算进 version", async () => {
    const { service, findMany } = makeService();
    findMany.mockResolvedValue([
      row({
        key: "unknown/key",
        version: 1,
        updatedAt: new Date("2026-11-25T05:00:00.000Z"),
      }),
      row({
        key: "diagnostics/remote-probe",
        version: 1,
        updatedAt: new Date("2026-11-25T01:00:00.000Z"),
      }),
    ]);

    const manifest = await service.getManifest();
    expect(Object.keys(manifest.assets)).toEqual(["diagnostics/remote-probe"]);
    expect(manifest.version).toBe("2026-11-25T01:00:00.000Z");
  });

  it("全部 key 都停用时不下发任何素材", async () => {
    const { service, findMany } = makeService([]);
    findMany.mockResolvedValue([row({ version: 1 })]);

    expect(await service.getManifest()).toEqual({ version: "", assets: {} });
  });

  it("输出字段为 url/width/height/version/updatedAt", async () => {
    const { service, findMany } = makeService();
    findMany.mockResolvedValue([
      row({
        version: 1,
        url: "https://x/app-assets/files/diagnostics/remote-probe/v1-a.png",
        width: 512,
        height: 512,
        updatedAt: new Date("2026-11-25T00:00:00.000Z"),
      }),
    ]);

    const manifest = await service.getManifest();
    expect(manifest.assets["diagnostics/remote-probe"]).toEqual({
      url: "https://x/app-assets/files/diagnostics/remote-probe/v1-a.png",
      width: 512,
      height: 512,
      version: 1,
      updatedAt: "2026-11-25T00:00:00.000Z",
    });
  });
});
