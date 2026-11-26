import { createHash } from "crypto";
import { resolve } from "path";
import { tmpdir } from "os";

/**
 * 展示位注册表的初始种子：迁移只种这一项，业务展示位由 dashboard 创建。
 * 保留这份常量是为了让 seed、文档和测试有同一个对照。
 */
export interface AppAssetSlotSeed {
  key: string;
  label: string;
  page: string;
}

export const APP_ASSET_SLOT_SEED: AppAssetSlotSeed[] = [
  {
    key: "diagnostics/remote-probe",
    label: "远程素材探针",
    page: "diagnostics",
  },
];

/** key 的每一段只允许 [a-z0-9-]+；段之间以 / 分隔。 */
export const APP_ASSET_KEY_PATTERN = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;

/** page 是短 code（单段），且必须等于 key 的第一段。 */
export const APP_ASSET_SLOT_PAGE_PATTERN = /^[a-z0-9-]+$/;

/** suffix 拼在 page 后面，允许一个或多个分段。 */
export const APP_ASSET_SLOT_SUFFIX_PATTERN = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;

export const APP_ASSET_SLOT_MAX_KEY_LENGTH = 64;
export const APP_ASSET_SLOT_MAX_PAGE_LENGTH = 32;
export const APP_ASSET_SLOT_MAX_LABEL_LENGTH = 40;
export const APP_ASSET_SLOT_MAX_NOTE_LENGTH = 200;

export function isValidAssetKey(key: string): boolean {
  return key.length > 0 && APP_ASSET_KEY_PATTERN.test(key);
}

/** 默认值（compose 与代码共享口径）。 */
export const APP_ASSET_MAX_BYTES_DEFAULT = 2097152; // 2 MiB
export const APP_ASSET_MAX_DIMENSION_DEFAULT = 8000;
export const APP_ASSET_PUBLIC_BASE_URL_DEFAULT =
  "http://localhost:3000/app-assets/files";
export const APP_ASSET_STORAGE_DRIVER_DEFAULT = "local";

/** 未配置 APP_ASSET_LOCAL_DIR 时落到系统临时目录，避免污染仓库/项目目录。 */
export function resolveAssetLocalDir(raw: string | undefined): string {
  return (raw || "").trim() || resolve(tmpdir(), "deda-app-assets");
}

export interface DetectedImage {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  ext: "png" | "jpg" | "webp";
}

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

/** 只认 PNG / JPEG / WebP 的 magic bytes；SVG 等文本格式一律返回 null。 */
export function detectImageType(buffer: Buffer): DetectedImage | null {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: "image/png", ext: "png" };
  }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return { mimeType: "image/jpeg", ext: "jpg" };
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && // R
    buffer[1] === 0x49 && // I
    buffer[2] === 0x46 && // F
    buffer[3] === 0x46 && // F
    buffer[8] === 0x57 && // W
    buffer[9] === 0x45 && // E
    buffer[10] === 0x42 && // B
    buffer[11] === 0x50 // P
  ) {
    return { mimeType: "image/webp", ext: "webp" };
  }
  return null;
}

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** IPv4 点分十进制，或 IPv6 字面量（含方括号、含冒号）。 */
export function isIpAddress(host: string): boolean {
  if (host.includes(":")) return true;
  const parts = host.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p));
}

/** 有效 host 白名单：显式配置优先；空则回落到 PUBLIC_BASE_URL 的 host。 */
export function resolveAllowedHosts(
  publicBaseUrl: string,
  hostsEnv?: string | null,
): string[] {
  const configured = (hostsEnv ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured;
  try {
    return [new URL(publicBaseUrl).hostname];
  } catch {
    return [];
  }
}

export interface AssetUrlValidationOptions {
  publicBaseUrl: string;
  hostsEnv?: string | null;
  isProduction: boolean;
}

/**
 * 校验素材 URL：
 * - host 必须在白名单内（白名单为空则用 PUBLIC_BASE_URL 的 host）；
 * - 生产环境禁止 http / IP / 端口；非生产允许 localhost 等。
 */
export function validateAssetUrl(
  url: string,
  options: AssetUrlValidationOptions,
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("素材 URL 非法");
  }
  const allowed = resolveAllowedHosts(options.publicBaseUrl, options.hostsEnv);
  if (!allowed.includes(parsed.hostname)) {
    throw new Error(`素材 URL host 不在白名单：${parsed.hostname}`);
  }
  if (options.isProduction) {
    if (parsed.protocol !== "https:") {
      throw new Error("生产环境素材 URL 必须使用 https");
    }
    if (isIpAddress(parsed.hostname)) {
      throw new Error("生产环境素材 URL 禁止使用 IP");
    }
    if (parsed.port !== "") {
      throw new Error("生产环境素材 URL 禁止携带端口");
    }
  }
}
