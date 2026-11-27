export interface PhoneMaker {
  makerKey: string;
  makerLabel: string;
}

const APPLE: PhoneMaker = { makerKey: "apple", makerLabel: "Apple" };
const HUAWEI: PhoneMaker = { makerKey: "huawei", makerLabel: "华为" };
const HONOR: PhoneMaker = { makerKey: "honor", makerLabel: "荣耀" };
const XIAOMI: PhoneMaker = { makerKey: "xiaomi", makerLabel: "小米" };
const OPPO: PhoneMaker = { makerKey: "oppo", makerLabel: "OPPO 系" };
const VIVO: PhoneMaker = { makerKey: "vivo", makerLabel: "vivo 系" };
const REALME: PhoneMaker = { makerKey: "realme", makerLabel: "realme" };
const SAMSUNG: PhoneMaker = { makerKey: "samsung", makerLabel: "三星" };
const MEIZU: PhoneMaker = { makerKey: "meizu", makerLabel: "魅族" };
const LENOVO: PhoneMaker = { makerKey: "lenovo", makerLabel: "联想" };
const ZTE: PhoneMaker = { makerKey: "zte", makerLabel: "中兴" };
const SONY: PhoneMaker = { makerKey: "sony", makerLabel: "索尼" };
const GOOGLE: PhoneMaker = { makerKey: "google", makerLabel: "Google" };
const NOTHING: PhoneMaker = { makerKey: "nothing", makerLabel: "Nothing" };

/**
 * 归一化后的品牌别名 → 厂商。
 * 键必须是小写字母/数字，覆盖各家真实出厂值（含子品牌与机型名）。
 */
const MAKER_BY_BRAND: Record<string, PhoneMaker> = {
  apple: APPLE,
  iphone: APPLE,
  ipad: APPLE,
  ipod: APPLE,
  huawei: HUAWEI,
  honor: HONOR,
  xiaomi: XIAOMI,
  redmi: XIAOMI,
  poco: XIAOMI,
  oppo: OPPO,
  oneplus: OPPO,
  vivo: VIVO,
  iqoo: VIVO,
  realme: REALME,
  samsung: SAMSUNG,
  meizu: MEIZU,
  mblu: MEIZU,
  lenovo: LENOVO,
  motorola: LENOVO,
  moto: LENOVO,
  zte: ZTE,
  nubia: ZTE,
  redmagic: ZTE,
  sony: SONY,
  google: GOOGLE,
  pixel: GOOGLE,
  nothing: NOTHING,
};

/** iOS 设备族：品牌值可能带机型后缀（如 iPhone15,2） */
const APPLE_DEVICE_PREFIXES = ["iphone", "ipad", "ipod"];

/** 开发者工具/PC 端/空值：不进入品牌榜，计入未知 */
const UNKNOWN_BRANDS = new Set([
  "",
  "unknown",
  "devtools",
  "pc",
  "mac",
  "windows",
]);

/** 去空格/标点并转小写，兼容 One Plus、iQOO、SAMSUNG 等写法差异 */
function normalizeBrand(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 原始品牌 → 厂商级归并。
 * 返回 null 表示未知；未识别品牌归入“其他”。
 */
export function resolvePhoneMaker(
  raw: string | null | undefined,
): PhoneMaker | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const key = normalizeBrand(value);
  if (!key) return { makerKey: "other", makerLabel: "其他" };
  if (UNKNOWN_BRANDS.has(key)) return null;
  const maker = MAKER_BY_BRAND[key];
  if (maker) return maker;
  if (APPLE_DEVICE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return APPLE;
  }
  return { makerKey: "other", makerLabel: "其他" };
}
