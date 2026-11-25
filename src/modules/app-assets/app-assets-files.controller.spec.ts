import { ConfigService } from "@nestjs/config";
import { NotFoundException } from "@nestjs/common";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AppAssetsFilesController } from "./app-assets-files.controller";

function makeController(dir: string) {
  const config = {
    get: jest.fn((key: string) =>
      key === "APP_ASSET_LOCAL_DIR" ? dir : undefined,
    ),
  } as unknown as ConfigService;
  return new AppAssetsFilesController(config);
}

function makeRes() {
  return { setHeader: jest.fn(), sendFile: jest.fn() };
}

describe("AppAssetsFilesController", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deda-assets-files-"));
    mkdirSync(join(dir, "diagnostics", "remote-probe"), { recursive: true });
    writeFileSync(join(dir, "diagnostics", "remote-probe", "v1-a.png"), "png");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("存在的文件：设置长缓存并 sendFile", () => {
    const controller = makeController(dir);
    const res = makeRes();

    controller.get("diagnostics/remote-probe/v1-a.png", res as never);

    expect(res.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=31536000, immutable",
    );
    expect(res.sendFile).toHaveBeenCalledWith(
      join(dir, "diagnostics", "remote-probe", "v1-a.png"),
    );
  });

  it("文件不存在或路径穿越：404", () => {
    const controller = makeController(dir);

    expect(() =>
      controller.get("diagnostics/missing.png", makeRes() as never),
    ).toThrow(NotFoundException);
    expect(() => controller.get("../secret.png", makeRes() as never)).toThrow(
      NotFoundException,
    );
  });
});
