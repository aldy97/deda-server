import { PrismaService } from "@/common/prisma/prisma.service";
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

describe("AppAssetsService", () => {
  let service: AppAssetsService;
  let findMany: jest.Mock;

  beforeEach(() => {
    findMany = jest.fn();
    service = new AppAssetsService({
      appAsset: { findMany },
    } as unknown as PrismaService);
  });

  it("manifest 只查 published", async () => {
    findMany.mockResolvedValue([]);
    await service.getManifest();
    expect(findMany).toHaveBeenCalledWith({
      where: { status: "published" },
      orderBy: [{ key: "asc" }, { version: "desc" }],
    });
  });

  it("空数据 version 为空串", async () => {
    findMany.mockResolvedValue([]);
    expect(await service.getManifest()).toEqual({ version: "", assets: {} });
  });

  it("每 key 只取最新一条 published", async () => {
    findMany.mockResolvedValue([
      row({ version: 2, updatedAt: new Date("2026-11-25T02:00:00.000Z") }),
      row({ version: 1, updatedAt: new Date("2026-11-25T01:00:00.000Z") }),
    ]);

    const manifest = await service.getManifest();
    expect(manifest.assets["diagnostics/remote-probe"].version).toBe(2);
    expect(manifest.version).toBe("2026-11-25T02:00:00.000Z");
  });

  it("过滤注册表之外的 key", async () => {
    findMany.mockResolvedValue([
      row({ key: "unknown/key", version: 1 }),
      row({ key: "diagnostics/remote-probe", version: 1 }),
    ]);

    const manifest = await service.getManifest();
    expect(Object.keys(manifest.assets)).toEqual(["diagnostics/remote-probe"]);
  });

  it("输出字段为 url/width/height/version/updatedAt", async () => {
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
