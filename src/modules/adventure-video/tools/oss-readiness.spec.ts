import {
  runOssReadinessChecks,
  summarizeChecks,
  type HttpProbe,
  type OssClientLike,
} from "./oss-readiness";

function fakeClient(overrides: Partial<OssClientLike> = {}): OssClientLike {
  return {
    getBucketInfo: jest.fn().mockResolvedValue({ region: "oss-cn-beijing" }),
    getBucketACL: jest.fn().mockResolvedValue({ acl: "private" }),
    put: jest.fn().mockResolvedValue({}),
    signatureUrl: jest.fn((key: string) => `https://bucket/${key}?sig=1`),
    list: jest.fn().mockResolvedValue({}),
    ...overrides,
  };
}

const PROBE_OK = {
  status: jest.fn(async (url: string, headers?: Record<string, string>) => {
    if (headers?.Range) return 206;
    if (url.includes("sig=1")) return 200;
    return 403;
  }),
};

async function run(client: OssClientLike, probe: HttpProbe = PROBE_OK) {
  return runOssReadinessChecks({
    client,
    probe,
    expectedRegion: "oss-cn-beijing",
    testKey: "adventure-video/healthcheck.txt",
    sleep: async () => undefined,
  });
}

describe("oss-readiness", () => {
  it("全部满足时 required 全绿", async () => {
    const results = await run(fakeClient());
    expect(summarizeChecks(results)).toEqual({ ok: true, failed: [] });
  });

  it("公共读：ACL 与匿名访问两道都会红", async () => {
    const client = fakeClient({
      getBucketACL: jest.fn().mockResolvedValue({ acl: "public-read" }),
    });
    const probe = {
      status: jest.fn(async () => 200),
    };
    const results = await run(client, probe);
    const summary = summarizeChecks(results);
    expect(summary.ok).toBe(false);
    expect(summary.failed).toEqual(
      expect.arrayContaining(["bucket.private", "anonymous.denied"]),
    );
  });

  it("地域不一致必须报错（跨区会慢且可能失败）", async () => {
    const client = fakeClient({
      getBucketInfo: jest.fn().mockResolvedValue({ region: "oss-cn-shanghai" }),
    });
    const results = await run(client);
    expect(summarizeChecks(results).failed).toContain("bucket.region");
  });

  it("Range 返回 200 视为失败：视频拖不动", async () => {
    const probe = {
      status: jest.fn(async (_url: string, headers?: Record<string, string>) =>
        headers?.Range ? 200 : _url.includes("sig=1") ? 200 : 403,
      ),
    };
    const results = await run(fakeClient(), probe);
    expect(summarizeChecks(results).failed).toContain("signed.range");
  });

  it("缺 list 权限会红：生命周期清孤儿依赖它", async () => {
    const client = fakeClient({ list: undefined });
    const results = await run(client);
    expect(summarizeChecks(results).failed).toContain("object.list");
  });

  it("过期签名不是必选项，失败不阻断", async () => {
    const probe = {
      status: jest.fn(async () => 200),
    };
    const results = await run(fakeClient(), probe);
    const expired = results.find((item) => item.name === "signed.expired");
    expect(expired?.ok).toBe(false);
    expect(expired?.required).toBe(false);
    expect(summarizeChecks(results).ok).toBe(false);
  });
});
