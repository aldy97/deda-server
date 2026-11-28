import axios from "axios";
import OSS = require("ali-oss");
import {
  runOssReadinessChecks,
  summarizeChecks,
  type OssClientLike,
} from "../src/modules/adventure-video/tools/oss-readiness";

/**
 * OSS 就绪检查：npm run check:oss
 *
 * 前置：OSS_REGION / OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET。
 * 退出码：0 全绿；1 有必检项失败；2 缺配置。
 * 不打印任何密钥；测试对象在结束时删除。
 */
async function main(): Promise<void> {
  const required = [
    "OSS_REGION",
    "OSS_BUCKET",
    "OSS_ACCESS_KEY_ID",
    "OSS_ACCESS_KEY_SECRET",
  ];
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    console.error(`缺少配置：${missing.join(", ")}`);
    process.exit(2);
  }

  const bucketName = process.env.OSS_BUCKET!;
  const raw = new OSS({
    region: process.env.OSS_REGION!,
    bucket: bucketName,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID!,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET!,
    ...(process.env.OSS_ENDPOINT ? { endpoint: process.env.OSS_ENDPOINT } : {}),
    secure: true,
  });

  // OssClientLike 是与 SDK 解耦的隔离层，真 SDK 的两处怪癖在这里归一化：
  // 1. getBucketInfo 的地域在返回体 bucket.Location（形如 oss-cn-beijing），
  //    而 OssClientLike 约定的是 cn-beijing 形式，需去 oss- 前缀；
  // 2. getBucketACL 不像 getBucketInfo 那样回退到默认 bucket，必须显式传桶名，
  //    否则请求落到服务端点被 RAM 当成 ListBuckets 拒绝。
  const client: OssClientLike = {
    async getBucketInfo() {
      const info = await raw.getBucketInfo(bucketName);
      return { region: (info.bucket?.Location ?? "").replace(/^oss-/, "") };
    },
    async getBucketACL() {
      const result = await raw.getBucketACL(bucketName);
      return { acl: result.acl };
    },
    put: (key, body, options) => raw.put(key, body, options),
    signatureUrl: (key, options) => raw.signatureUrl(key, options),
    list: (query) => raw.list(query),
  };

  const probe = {
    async status(
      url: string,
      headers?: Record<string, string>,
    ): Promise<number> {
      try {
        const response = await axios.get(url, {
          headers,
          timeout: 15_000,
          validateStatus: () => true,
          maxRedirects: 0,
        });
        return response.status;
      } catch {
        return 0;
      }
    },
  };

  const testKey = `adventure-video/healthcheck-${Date.now()}.txt`;
  const results = await runOssReadinessChecks({
    client,
    probe,
    expectedRegion: process.env.OSS_REGION!,
    testKey,
  });

  console.table(
    results.map((item) => ({
      检查项: item.name,
      必检: item.required ? "是" : "否",
      结果: item.ok ? "PASS" : "FAIL",
      说明: item.detail,
    })),
  );

  try {
    await raw.delete(testKey);
  } catch {
    // 清理失败不影响判定；生命周期规则会兜底。
  }

  const summary = summarizeChecks(results);
  if (!summary.ok) {
    console.error(`未通过：${summary.failed.join(", ")}`);
    process.exit(1);
  }
  console.log("OSS 就绪检查全部通过。");
}

void main();
