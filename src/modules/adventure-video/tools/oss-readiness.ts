/**
 * OSS 就绪检查。
 *
 * 目的不是「上传成功」这一件事，而是把「看起来配置好了、其实放不了视频」
 * 的六种情况逐条钉死：地域不对、桶是公共读、匿名能读、签名 URL 不能读、
 * Range 不支持（视频拖不动）、RAM 无 List（生命周期清孤儿会失败）。
 *
 * 纯逻辑与网络分离，CI 用假 client 测；真检查由 scripts/check-oss.ts 执行。
 */

export interface OssClientLike {
  getBucketInfo(): Promise<{ region?: string }>;
  getBucketACL(): Promise<{ acl?: string }>;
  put(key: string, body: Buffer, options?: { mime?: string }): Promise<unknown>;
  signatureUrl(
    key: string,
    options?: { expires?: number; method?: string },
  ): string;
  list?(query: { prefix: string; "max-keys": number }): Promise<unknown>;
}

export interface HttpProbe {
  status(url: string, headers?: Record<string, string>): Promise<number>;
}

export interface OssCheckInput {
  client: OssClientLike;
  probe: HttpProbe;
  expectedRegion: string;
  testKey: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface OssCheckResult {
  name: string;
  required: boolean;
  ok: boolean;
  detail: string;
}

const PRIVATE_ACL = "private";

export async function runOssReadinessChecks(
  input: OssCheckInput,
): Promise<OssCheckResult[]> {
  const { client, probe, expectedRegion, testKey } = input;
  const sleep =
    input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const results: OssCheckResult[] = [];

  const run = async (
    name: string,
    required: boolean,
    fn: () => Promise<string>,
  ): Promise<void> => {
    try {
      const detail = await fn();
      results.push({ name, required, ok: true, detail });
    } catch (error) {
      results.push({
        name,
        required,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await run("bucket.region", true, async () => {
    const info = await client.getBucketInfo();
    const region = info?.region ?? "";
    if (!region) throw new Error("getBucketInfo 未返回 region");
    if (region !== expectedRegion) {
      throw new Error(`地域不一致：bucket=${region}，期望=${expectedRegion}`);
    }
    return region;
  });

  await run("bucket.private", true, async () => {
    const acl = (await client.getBucketACL())?.acl ?? "";
    if (acl !== PRIVATE_ACL) {
      throw new Error(`桶 ACL 是 ${acl || "未知"}，必须是 private`);
    }
    return "private";
  });

  await run("object.put", true, async () => {
    await client.put(testKey, Buffer.from("deda-video-readiness"), {
      mime: "text/plain",
    });
    return testKey;
  });

  await run("anonymous.denied", true, async () => {
    const signed = client.signatureUrl(testKey, { expires: 60 });
    const anonymousUrl = signed.split("?")[0];
    const status = await probe.status(anonymousUrl);
    if (status !== 403) {
      throw new Error(`匿名 GET 返回 ${status}，期望 403（桶可能公共读）`);
    }
    return "403";
  });

  await run("signed.get", true, async () => {
    const signed = client.signatureUrl(testKey, { expires: 300 });
    const status = await probe.status(signed);
    if (status !== 200) throw new Error(`签名 GET 返回 ${status}，期望 200`);
    return "200";
  });

  await run("signed.range", true, async () => {
    const signed = client.signatureUrl(testKey, { expires: 300 });
    const status = await probe.status(signed, { Range: "bytes=0-7" });
    if (status !== 206) {
      throw new Error(`签名 Range 返回 ${status}，期望 206（视频无法拖动）`);
    }
    return "206";
  });

  await run("object.list", true, async () => {
    if (!client.list) throw new Error("client 未实现 list");
    await client.list({ prefix: testKey, "max-keys": 1 });
    return "ok";
  });

  await run("signed.expired", false, async () => {
    const signed = client.signatureUrl(testKey, { expires: 1 });
    await sleep(1_500);
    const status = await probe.status(signed);
    if (status !== 403) throw new Error(`过期签名返回 ${status}，期望 403`);
    return "403";
  });

  return results;
}

export function summarizeChecks(results: OssCheckResult[]): {
  ok: boolean;
  failed: string[];
} {
  const failed = results
    .filter((item) => item.required && !item.ok)
    .map((item) => item.name);
  return { ok: failed.length === 0, failed };
}
