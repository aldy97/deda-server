export interface PhoneMaker {
  makerKey: string;
  makerLabel: string;
}

const MAKER_BY_BRAND: Record<string, PhoneMaker> = {
  apple: { makerKey: "apple", makerLabel: "Apple" },
  huawei: { makerKey: "huawei", makerLabel: "华为" },
  honor: { makerKey: "honor", makerLabel: "荣耀" },
  xiaomi: { makerKey: "xiaomi", makerLabel: "小米" },
  redmi: { makerKey: "xiaomi", makerLabel: "小米" },
  poco: { makerKey: "xiaomi", makerLabel: "小米" },
  oppo: { makerKey: "oppo", makerLabel: "OPPO 系" },
  oneplus: { makerKey: "oppo", makerLabel: "OPPO 系" },
  vivo: { makerKey: "vivo", makerLabel: "vivo 系" },
  iqoo: { makerKey: "vivo", makerLabel: "vivo 系" },
  realme: { makerKey: "realme", makerLabel: "realme" },
  samsung: { makerKey: "samsung", makerLabel: "三星" },
  meizu: { makerKey: "meizu", makerLabel: "魅族" },
  lenovo: { makerKey: "lenovo", makerLabel: "联想" },
  motorola: { makerKey: "lenovo", makerLabel: "联想" },
  zte: { makerKey: "zte", makerLabel: "中兴" },
  nubia: { makerKey: "zte", makerLabel: "中兴" },
  sony: { makerKey: "sony", makerLabel: "索尼" },
  google: { makerKey: "google", makerLabel: "Google" },
  nothing: { makerKey: "nothing", makerLabel: "Nothing" },
};

/** 开发者工具/PC 端/空值：不进入品牌榜，计入未知 */
const UNKNOWN_BRANDS = new Set([
  "",
  "unknown",
  "devtools",
  "pc",
  "mac",
  "windows",
]);

/**
 * 原始品牌 → 厂商级归并。
 * 返回 null 表示未知；未识别品牌归入“其他”。
 */
export function resolvePhoneMaker(
  raw: string | null | undefined,
): PhoneMaker | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const key = value.toLowerCase();
  if (UNKNOWN_BRANDS.has(key)) return null;
  return MAKER_BY_BRAND[key] ?? { makerKey: "other", makerLabel: "其他" };
}
