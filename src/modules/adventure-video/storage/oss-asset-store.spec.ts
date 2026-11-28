import { ConfigService } from "@nestjs/config";
import OSS = require("ali-oss");
import { OssAssetStore } from "./oss-asset-store";
import { resolveVideoStudioConfig } from "@/config/video.config";

jest.mock("ali-oss", () => {
  const client = {
    put: jest.fn().mockResolvedValue({ name: "k" }),
    get: jest.fn().mockResolvedValue({ content: Buffer.from("bytes") }),
    signatureUrl: jest.fn(
      (key: string, options: { expires?: number }) =>
        `https://oss/${key}?expires=${options?.expires ?? ""}`,
    ),
  };
  // export= 形态下 require("ali-oss") 拿到的就是模块本体，直接返回构造函数
  return jest.fn(() => client);
});

const MockOss = OSS as unknown as jest.Mock;

function makeStore(overrides: Record<string, string> = {}) {
  const base = resolveVideoStudioConfig(() => undefined);
  const config = {
    get: jest.fn(() => ({
      ...base,
      oss: {
        ...base.oss,
        region: overrides.region ?? "oss-cn-beijing",
        bucket: overrides.bucket ?? "deda-video",
        accessKeyId: overrides.accessKeyId ?? "ak",
        accessKeySecret: overrides.accessKeySecret ?? "sk",
        signedUrlTtlSec: 3600,
      },
    })),
  } as unknown as ConfigService;
  return new OssAssetStore(config);
}

describe("OssAssetStore", () => {
  beforeEach(() => {
    MockOss.mockClear();
  });

  it("put 返回 objectKey/bytes/sha256，不把公网 URL 落库", async () => {
    const store = makeStore();
    const body = Buffer.from("hello");
    const result = await store.put("a/b.txt", body, "text/plain");
    expect(result.objectKey).toBe("a/b.txt");
    expect(result.bytes).toBe(5);
    expect(result.sha256).toHaveLength(64);
    const client = MockOss.mock.results[0].value;
    expect(client.put).toHaveBeenCalledWith("a/b.txt", body, {
      mime: "text/plain",
    });
  });

  it("签名 URL 用配置 TTL，可被调用方覆盖", () => {
    const store = makeStore();
    expect(store.signedUrl("v.mp4")).toContain("expires=3600");
    expect(store.signedUrl("v.mp4", 60)).toContain("expires=60");
  });

  it("下载签名把 response 头透传给 OSS（附件下载）", () => {
    const store = makeStore();
    store.signedUrl("v.mp4", 60, {
      "content-disposition": 'attachment; filename="a.mp4"',
    });
    const client = MockOss.mock.results[0].value;
    expect(client.signatureUrl).toHaveBeenCalledWith("v.mp4", {
      expires: 60,
      response: { "content-disposition": 'attachment; filename="a.mp4"' },
    });
  });

  it("get 读回已存对象，审批后复用音频", async () => {
    const store = makeStore();
    await expect(store.get("a/beat-0.wav")).resolves.toEqual(
      Buffer.from("bytes"),
    );
    const client = MockOss.mock.results[0].value;
    expect(client.get).toHaveBeenCalledWith("a/beat-0.wav");
  });

  it("客户端只构造一次，避免每次签名都新建连接", () => {
    const store = makeStore();
    store.signedUrl("a");
    store.signedUrl("b");
    expect(MockOss).toHaveBeenCalledTimes(1);
  });

  it("缺任意一项配置都抛 OSS_NOT_CONFIGURED，而不是半残调用", async () => {
    for (const key of ["region", "bucket", "accessKeyId", "accessKeySecret"]) {
      const store = makeStore({ [key]: "" });
      await expect(
        store.put("a", Buffer.from("x"), "text/plain"),
      ).rejects.toMatchObject({ code: "OSS_NOT_CONFIGURED" });
    }
  });
});
