import { ConfigService } from "@nestjs/config";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  LocalAssetStorage,
  resolveLocalAssetStorageOptions,
} from "./local-asset-storage";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function makeConfig(values: Record<string, string | undefined> = {}) {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe("resolveLocalAssetStorageOptions", () => {
  it("空配置回落到默认值", () => {
    const options = resolveLocalAssetStorageOptions((key) => undefined);
    expect(options.localDir.endsWith("deda-app-assets")).toBe(true);
    expect(options.publicBaseUrl).toBe(
      "http://localhost:3000/app-assets/files",
    );
    expect(options.hosts).toEqual(["localhost"]);
    expect(options.isProduction).toBe(false);
  });

  it("生产环境与显式配置生效", () => {
    const options = resolveLocalAssetStorageOptions(
      (key) =>
        ({
          APP_ASSET_LOCAL_DIR: "/opt/deda/app-assets/prod",
          APP_ASSET_PUBLIC_BASE_URL:
            "https://valleyletters.com/app-assets/files",
          APP_ASSET_HOSTS: "valleyletters.com",
          NODE_ENV: "production",
        })[key],
    );
    expect(options.localDir).toBe("/opt/deda/app-assets/prod");
    expect(options.publicBaseUrl).toBe(
      "https://valleyletters.com/app-assets/files",
    );
    expect(options.hosts).toEqual(["valleyletters.com"]);
    expect(options.isProduction).toBe(true);
  });
});

describe("LocalAssetStorage", () => {
  let localDir: string;

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), "deda-assets-test-"));
  });

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true });
  });

  it("非 local 存储驱动启动即失败", () => {
    expect(
      () =>
        new LocalAssetStorage(makeConfig({ APP_ASSET_STORAGE_DRIVER: "s3" })),
    ).toThrow(/暂不支持/);
  });

  it("buildPublicUrl 去除 base 尾斜杠再拼接", () => {
    const storage = new LocalAssetStorage(
      makeConfig({
        APP_ASSET_PUBLIC_BASE_URL:
          "https://valleyletters.com/app-assets/files/",
        APP_ASSET_HOSTS: "valleyletters.com",
      }),
    );
    expect(storage.buildPublicUrl("diagnostics/remote-probe/v1-a.png")).toBe(
      "https://valleyletters.com/app-assets/files/diagnostics/remote-probe/v1-a.png",
    );
  });

  it("save 写入嵌套路径并返回相对路径与公开 URL", async () => {
    const storage = new LocalAssetStorage(
      makeConfig({
        APP_ASSET_LOCAL_DIR: localDir,
        APP_ASSET_PUBLIC_BASE_URL:
          "https://staging.valleyletters.com/app-assets/files",
        APP_ASSET_HOSTS: "staging.valleyletters.com",
      }),
    );

    const result = await storage.save({
      key: "diagnostics/remote-probe",
      version: 1,
      mimeType: "image/png",
      buffer: png,
    });

    expect(result.relativePath).toMatch(
      /^diagnostics\/remote-probe\/v1-[0-9a-f]{16}\.png$/,
    );
    expect(result.url).toBe(
      `https://staging.valleyletters.com/app-assets/files/${result.relativePath}`,
    );
    const absolutePath = join(localDir, ...result.relativePath.split("/"));
    expect(existsSync(absolutePath)).toBe(true);
    expect(readFileSync(absolutePath)).toEqual(png);
  });

  it("save 拒绝非法 key", async () => {
    const storage = new LocalAssetStorage(
      makeConfig({ APP_ASSET_LOCAL_DIR: localDir }),
    );
    await expect(
      storage.save({
        key: "Bad/key",
        version: 1,
        mimeType: "image/png",
        buffer: png,
      }),
    ).rejects.toThrow(/key 非法/);
  });

  it("assertValidPublicUrl 把 host 不在白名单的错误映射为 400", () => {
    const storage = new LocalAssetStorage(
      makeConfig({
        APP_ASSET_PUBLIC_BASE_URL: "https://valleyletters.com/app-assets/files",
        APP_ASSET_HOSTS: "valleyletters.com",
        NODE_ENV: "production",
      }),
    );
    expect(() =>
      storage.assertValidPublicUrl("https://evil.example.com/x"),
    ).toThrow(/不在白名单/);
  });
});
