import {
  BCE_AUTH_PREFIX,
  BCE_TIMESTAMP_PATTERN,
  ParsedBceAuthString,
  REQUIRED_SIGNED_HEADERS,
} from "./baidu-agent.types";

/**
 * 解析百度云 BCE 认证字符串。
 *
 * 格式：`bce-auth-v1/{accessKeyId}/{timestamp}/{expirationPeriodInSeconds}/{signedHeaders}/{signature}`
 * 任一条不满足返回 null（fail-closed），返回值不含 accessKeyId 与 signature。
 *
 * @param raw 设备上报的 authorization 头原值
 * @returns 解析后的认证字符串结构，解析失败返回 null
 *
 * @see https://cloud.baidu.com/doc/Reference/s/njwvz1yfu
 */
export function parseBceAuthString(
  raw: string | null | undefined,
): ParsedBceAuthString | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }

  const segments = raw.split("/");
  if (segments.length !== 6) {
    return null;
  }

  const [
    prefix,
    accessKeyId,
    timestamp,
    expiresStr,
    signedHeadersRaw,
    signature,
  ] = segments;

  // 前缀校验
  if (prefix !== BCE_AUTH_PREFIX) {
    return null;
  }

  // accessKeyId 与 signature 非空（但不暴露到返回值）
  if (accessKeyId.length === 0 || signature.length === 0) {
    return null;
  }

  // timestamp 格式校验 + Date 有效性
  if (!BCE_TIMESTAMP_PATTERN.test(timestamp)) {
    return null;
  }
  const parsedDate = new Date(timestamp);
  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  // 有效期必须是正整数（1-9 位）
  if (!/^\d{1,9}$/.test(expiresStr)) {
    return null;
  }
  const expiresInSeconds = Number(expiresStr);
  if (expiresInSeconds <= 0) {
    return null;
  }

  // signedHeaders 按 ; 切分、去空、转小写，必须非空
  const signedHeaders = signedHeadersRaw
    .split(";")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);

  if (signedHeaders.length === 0) {
    return null;
  }

  return {
    timestamp,
    expiresInSeconds,
    signedHeaders,
    raw,
  };
}

/**
 * 判断认证字符串是否已过期。
 *
 * 过期条件：`now.getTime() >= Date.parse(timestamp) + expiresInSeconds * 1000`
 * 等于到期瞬间也视为过期（fail-closed）。
 *
 * @param parsed 解析后的认证字符串
 * @param now 判定时刻（默认 new Date()），允许注入以便测试
 * @returns 是否过期
 */
export function isBceAuthExpired(
  parsed: ParsedBceAuthString,
  now?: Date,
): boolean {
  const current = now ?? new Date();
  const expiresAt =
    Date.parse(parsed.timestamp) + parsed.expiresInSeconds * 1000;
  return current.getTime() >= expiresAt;
}

/**
 * 判断 signedHeaders 是否包含所有必需头。
 *
 * REQUIRED_SIGNED_HEADERS（host、x-bce-date）全部包含才返回 true。
 * 要求 x-bce-date 被签进签名，是为了让我方回填的 `x-bce-date` 有唯一权威取值
 * （即签名串第 3 段的 timestamp）；未被签名的头，回放时取值无从校验。
 *
 * TODO(Q10): 设备签名实际覆盖的 signedHeaders 取值本仓库无书面出处，
 * 待机芯公司确认。若固件未把 x-bce-date 签进去，这里会一律返回
 * signed_headers_unexpected（fail-closed，不会误发请求），届时按确认结果放宽。
 */
export function hasRequiredSignedHeaders(parsed: ParsedBceAuthString): boolean {
  return REQUIRED_SIGNED_HEADERS.every((required) =>
    parsed.signedHeaders.includes(required),
  );
}
