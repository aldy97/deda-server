import {
  parseBceAuthString,
  isBceAuthExpired,
  hasRequiredSignedHeaders,
} from "./bce-auth-string.util";

// 文档示例值：bce-auth-v1/{accessKeyId}/{timestamp}/{expirationPeriodInSeconds}/{signedHeaders}/{signature}
const VALID_ACCESS_KEY_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_SIGNATURE =
  "47724e42fb47545f86b15d3e4672a7c94a226cee4247147cc44e12ab0248d03d";
const VALID_TIMESTAMP = "2015-04-27T08:23:49Z";
const VALID_EXPIRES = "1800";
const VALID_SIGNED_HEADERS = "content-type;host;x-bce-date";

const buildValidRaw = (overrides?: {
  prefix?: string;
  accessKeyId?: string;
  timestamp?: string;
  expires?: string;
  signedHeaders?: string;
  signature?: string;
}) => {
  const o = {
    prefix: "bce-auth-v1",
    accessKeyId: VALID_ACCESS_KEY_ID,
    timestamp: VALID_TIMESTAMP,
    expires: VALID_EXPIRES,
    signedHeaders: VALID_SIGNED_HEADERS,
    signature: VALID_SIGNATURE,
    ...overrides,
  };
  return `${o.prefix}/${o.accessKeyId}/${o.timestamp}/${o.expires}/${o.signedHeaders}/${o.signature}`;
};

describe("parseBceAuthString", () => {
  it("解析合法认证字符串：返回 ParsedBceAuthString（不含 accessKeyId 与 signature）", () => {
    const raw = buildValidRaw();
    const result = parseBceAuthString(raw);

    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe(VALID_TIMESTAMP);
    expect(result!.expiresInSeconds).toBe(1800);
    expect(result!.signedHeaders).toEqual([
      "content-type",
      "host",
      "x-bce-date",
    ]);
    expect(result!.raw).toBe(raw);
    // 返回值不含 accessKeyId 与 signature
    expect(
      (result as unknown as Record<string, unknown>).accessKeyId,
    ).toBeUndefined();
    expect(
      (result as unknown as Record<string, unknown>).signature,
    ).toBeUndefined();
  });

  it("raw 为 null → null", () => {
    expect(parseBceAuthString(null)).toBeNull();
  });

  it("raw 为 undefined → null", () => {
    expect(parseBceAuthString(undefined)).toBeNull();
  });

  it("raw 为空字符串 → null", () => {
    expect(parseBceAuthString("")).toBeNull();
  });

  it("raw 为纯空白字符串 → null", () => {
    expect(parseBceAuthString("   ")).toBeNull();
  });

  it("按 / 切分段数不足 6 → null", () => {
    expect(parseBceAuthString("bce-auth-v1/a/b/c/d")).toBeNull();
  });

  it("按 / 切分段数超过 6 → null", () => {
    expect(parseBceAuthString("bce-auth-v1/a/b/c/d/e/extra")).toBeNull();
  });

  it("第 1 段不是 bce-auth-v1 → null", () => {
    const raw = buildValidRaw({ prefix: "wrong-prefix" });
    expect(parseBceAuthString(raw)).toBeNull();
  });

  it("第 2 段（accessKeyId）为空 → null", () => {
    const raw = buildValidRaw({ accessKeyId: "" });
    expect(parseBceAuthString(raw)).toBeNull();
  });

  it("第 6 段（signature）为空 → null", () => {
    const raw = buildValidRaw({ signature: "" });
    expect(parseBceAuthString(raw)).toBeNull();
  });

  it("timestamp 格式不匹配 BCE_TIMESTAMP_PATTERN → null（缺少 T）", () => {
    const raw = buildValidRaw({ timestamp: "2015-04-27 08:23:49Z" });
    expect(parseBceAuthString(raw)).toBeNull();
  });

  it("timestamp 是 Invalid Date → null", () => {
    const raw = buildValidRaw({ timestamp: "2015-13-99T99:99:99Z" });
    expect(parseBceAuthString(raw)).toBeNull();
  });

  it("第 4 段不是正整数 → null（非数字）", () => {
    const raw = buildValidRaw({ expires: "abc" });
    expect(parseBceAuthString(raw)).toBeNull();
  });

  it("第 4 段不是正整数 → null（0）", () => {
    const raw = buildValidRaw({ expires: "0" });
    expect(parseBceAuthString(raw)).toBeNull();
  });

  it("第 4 段不是正整数 → null（负数）", () => {
    const raw = buildValidRaw({ expires: "-1" });
    expect(parseBceAuthString(raw)).toBeNull();
  });

  it("第 4 段不是正整数 → null（超过 9 位数字）", () => {
    const raw = buildValidRaw({ expires: "1234567890" });
    expect(parseBceAuthString(raw)).toBeNull();
  });

  it("第 5 段 signedHeaders 按 ; 切分后为空数组 → null", () => {
    const raw = buildValidRaw({ signedHeaders: "" });
    expect(parseBceAuthString(raw)).toBeNull();
  });

  it("signedHeaders 按 ; 切分去空后只剩空白 → null", () => {
    const raw = buildValidRaw({ signedHeaders: " ; " });
    expect(parseBceAuthString(raw)).toBeNull();
  });

  it("signedHeaders 转小写后存入数组", () => {
    const raw = buildValidRaw({
      signedHeaders: "Content-Type;Host;X-Bce-Date",
    });
    const result = parseBceAuthString(raw);
    expect(result!.signedHeaders).toEqual([
      "content-type",
      "host",
      "x-bce-date",
    ]);
  });

  it("signedHeaders 中多余的分号产生空项应被过滤", () => {
    const raw = buildValidRaw({
      signedHeaders: "host;;x-bce-date",
    });
    const result = parseBceAuthString(raw);
    expect(result!.signedHeaders).toEqual(["host", "x-bce-date"]);
  });
});

describe("isBceAuthExpired", () => {
  const expiredParsed = {
    timestamp: "2015-04-27T08:23:49Z",
    expiresInSeconds: 1800,
    signedHeaders: ["content-type", "host", "x-bce-date"],
    raw: buildValidRaw(),
  };

  it("过期：now 晚于 timestamp + expiresInSeconds → true", () => {
    // timestamp + 1800s = 2015-04-27T08:53:49Z
    const now = new Date("2015-04-27T08:53:50Z");
    expect(isBceAuthExpired(expiredParsed, now)).toBe(true);
  });

  it("未过期：now 早于 timestamp + expiresInSeconds → false", () => {
    const now = new Date("2015-04-27T08:23:50Z");
    expect(isBceAuthExpired(expiredParsed, now)).toBe(false);
  });

  it("边界：now 正好等于到期瞬间（timestamp + expiresInSeconds）→ true（过期）", () => {
    const now = new Date("2015-04-27T08:53:49Z");
    expect(isBceAuthExpired(expiredParsed, now)).toBe(true);
  });

  it("now 默认不传时为 Date.now()，可正常判定", () => {
    // 用一个很久以前过期的时间，默认 now 必定让它过期
    expect(isBceAuthExpired(expiredParsed)).toBe(true);
  });

  it("用当前时间生成的未过期 fixture 不会过期", () => {
    const now = new Date();
    const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const freshParsed = {
      timestamp,
      expiresInSeconds: 1800,
      signedHeaders: ["content-type", "host", "x-bce-date"],
      raw: buildValidRaw({ timestamp }),
    };
    expect(isBceAuthExpired(freshParsed, now)).toBe(false);
  });
});

describe("hasRequiredSignedHeaders", () => {
  it("包含 host 和 x-bce-date → true", () => {
    const parsed = {
      timestamp: VALID_TIMESTAMP,
      expiresInSeconds: 1800,
      signedHeaders: ["content-type", "host", "x-bce-date"],
      raw: buildValidRaw(),
    };
    expect(hasRequiredSignedHeaders(parsed)).toBe(true);
  });

  it("缺少 host → false", () => {
    const parsed = {
      timestamp: VALID_TIMESTAMP,
      expiresInSeconds: 1800,
      signedHeaders: ["content-type", "x-bce-date"],
      raw: buildValidRaw({ signedHeaders: "content-type;x-bce-date" }),
    };
    expect(hasRequiredSignedHeaders(parsed)).toBe(false);
  });

  it("缺少 x-bce-date → false", () => {
    const parsed = {
      timestamp: VALID_TIMESTAMP,
      expiresInSeconds: 1800,
      signedHeaders: ["content-type", "host"],
      raw: buildValidRaw({ signedHeaders: "content-type;host" }),
    };
    expect(hasRequiredSignedHeaders(parsed)).toBe(false);
  });

  it("全部缺少 → false", () => {
    const parsed = {
      timestamp: VALID_TIMESTAMP,
      expiresInSeconds: 1800,
      signedHeaders: ["content-type"],
      raw: buildValidRaw({ signedHeaders: "content-type" }),
    };
    expect(hasRequiredSignedHeaders(parsed)).toBe(false);
  });

  it("大写 headers 也能匹配（parseBceAuthString 已转小写）", () => {
    const raw = buildValidRaw({ signedHeaders: "HOST;X-BCE-DATE" });
    const parsed = parseBceAuthString(raw);
    expect(parsed).not.toBeNull();
    expect(hasRequiredSignedHeaders(parsed!)).toBe(true);
  });
});
