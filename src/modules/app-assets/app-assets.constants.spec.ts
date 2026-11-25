import {
  APP_ASSET_SLOTS,
  detectImageType,
  isIpAddress,
  isRegisteredAssetKey,
  isValidAssetKey,
  resolveAllowedHosts,
  resolveAssetLocalDir,
  sha256Hex,
  validateAssetUrl,
} from "./app-assets.constants";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const webp = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP"),
]);

describe("app-assets constants", () => {
  it("注册表初始只有 remote-probe 一项", () => {
    expect(APP_ASSET_SLOTS).toEqual([
      {
        key: "diagnostics/remote-probe",
        label: "远程素材探针",
        page: "asset-selftest",
      },
    ]);
  });

  it("isRegisteredAssetKey 只认注册表内的 key", () => {
    expect(isRegisteredAssetKey("diagnostics/remote-probe")).toBe(true);
    expect(isRegisteredAssetKey("diagnostics/unknown")).toBe(false);
  });

  it("isValidAssetKey 校验分段", () => {
    expect(isValidAssetKey("diagnostics/remote-probe")).toBe(true);
    expect(isValidAssetKey("Diagnostics/remote")).toBe(false);
    expect(isValidAssetKey("a//b")).toBe(false);
    expect(isValidAssetKey("a/")).toBe(false);
    expect(isValidAssetKey("")).toBe(false);
  });

  it("detectImageType 识别 PNG/JPEG/WebP，拒绝 SVG 与其他", () => {
    expect(detectImageType(png)).toEqual({ mimeType: "image/png", ext: "png" });
    expect(detectImageType(jpeg)).toEqual({
      mimeType: "image/jpeg",
      ext: "jpg",
    });
    expect(detectImageType(webp)).toEqual({
      mimeType: "image/webp",
      ext: "webp",
    });
    expect(detectImageType(Buffer.from("<svg/>"))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });

  it("sha256Hex 是标准 sha256", () => {
    expect(sha256Hex(Buffer.alloc(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("isIpAddress 识别 IPv4/IPv6", () => {
    expect(isIpAddress("192.168.1.1")).toBe(true);
    expect(isIpAddress("::1")).toBe(true);
    expect(isIpAddress("staging.valleyletters.com")).toBe(false);
    expect(isIpAddress("localhost")).toBe(false);
  });

  it("resolveAssetLocalDir 空值回落到系统临时目录", () => {
    expect(resolveAssetLocalDir("").endsWith("deda-app-assets")).toBe(true);
    expect(resolveAssetLocalDir("/opt/deda/app-assets/prod")).toBe(
      "/opt/deda/app-assets/prod",
    );
  });

  it("resolveAllowedHosts 空白名单回落 PUBLIC_BASE_URL 的 host", () => {
    expect(
      resolveAllowedHosts("https://staging.valleyletters.com/app-assets/files"),
    ).toEqual(["staging.valleyletters.com"]);
    expect(
      resolveAllowedHosts(
        "https://staging.valleyletters.com/app-assets/files",
        "a.example.com,b.example.com",
      ),
    ).toEqual(["a.example.com", "b.example.com"]);
  });

  it("validateAssetUrl：空白名单命中、显式命中通过", () => {
    expect(() =>
      validateAssetUrl("https://staging.valleyletters.com/app-assets/files/x", {
        publicBaseUrl: "https://staging.valleyletters.com/app-assets/files",
        isProduction: false,
      }),
    ).not.toThrow();

    expect(() =>
      validateAssetUrl("https://a.example.com/x", {
        publicBaseUrl: "https://staging.valleyletters.com/app-assets/files",
        hostsEnv: "a.example.com,b.example.com",
        isProduction: false,
      }),
    ).not.toThrow();
  });

  it("validateAssetUrl：host 不在白名单时拒绝", () => {
    expect(() =>
      validateAssetUrl("https://evil.example.com/x", {
        publicBaseUrl: "https://staging.valleyletters.com/app-assets/files",
        hostsEnv: "staging.valleyletters.com",
        isProduction: false,
      }),
    ).toThrow(/不在白名单/);
  });

  it("validateAssetUrl：生产拒绝 http / IP / 端口", () => {
    expect(() =>
      validateAssetUrl("http://valleyletters.com/x", {
        publicBaseUrl: "https://valleyletters.com/app-assets/files",
        hostsEnv: "valleyletters.com",
        isProduction: true,
      }),
    ).toThrow(/必须使用 https/);

    expect(() =>
      validateAssetUrl("https://192.168.1.1/x", {
        publicBaseUrl: "https://192.168.1.1/app-assets/files",
        hostsEnv: "192.168.1.1",
        isProduction: true,
      }),
    ).toThrow(/禁止使用 IP/);

    expect(() =>
      validateAssetUrl("https://valleyletters.com:8443/x", {
        publicBaseUrl: "https://valleyletters.com/app-assets/files",
        hostsEnv: "valleyletters.com",
        isProduction: true,
      }),
    ).toThrow(/禁止携带端口/);
  });

  it("validateAssetUrl：非法 URL 与无法解析的 base 都拒绝", () => {
    expect(() =>
      validateAssetUrl("not-a-url", {
        publicBaseUrl: "https://staging.valleyletters.com/app-assets/files",
        isProduction: false,
      }),
    ).toThrow(/非法/);

    expect(() =>
      validateAssetUrl("https://staging.valleyletters.com/x", {
        publicBaseUrl: "not-a-url",
        isProduction: false,
      }),
    ).toThrow(/不在白名单/);
  });

  it("validateAssetUrl：非生产允许 localhost", () => {
    expect(() =>
      validateAssetUrl("http://localhost:3000/app-assets/files/x", {
        publicBaseUrl: "http://localhost:3000/app-assets/files",
        isProduction: false,
      }),
    ).not.toThrow();
  });
});
