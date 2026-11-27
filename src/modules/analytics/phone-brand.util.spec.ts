import { resolvePhoneMaker } from "./phone-brand.util";

describe("resolvePhoneMaker", () => {
  it.each([
    ["Apple", "apple", "Apple"],
    ["iPhone", "apple", "Apple"],
    ["iPad", "apple", "Apple"],
    ["iPod touch", "apple", "Apple"],
    ["iPhone15,2", "apple", "Apple"],
    ["HUAWEI", "huawei", "华为"],
    ["Honor", "honor", "荣耀"],
    ["Xiaomi", "xiaomi", "小米"],
    ["Redmi", "xiaomi", "小米"],
    ["POCO", "xiaomi", "小米"],
    ["OPPO", "oppo", "OPPO 系"],
    ["OnePlus", "oppo", "OPPO 系"],
    ["One Plus", "oppo", "OPPO 系"],
    ["vivo", "vivo", "vivo 系"],
    ["iQOO", "vivo", "vivo 系"],
    ["realme", "realme", "realme"],
    ["SAMSUNG", "samsung", "三星"],
    ["Meizu", "meizu", "魅族"],
    ["mblu", "meizu", "魅族"],
    ["Lenovo", "lenovo", "联想"],
    ["Motorola", "lenovo", "联想"],
    ["moto", "lenovo", "联想"],
    ["ZTE", "zte", "中兴"],
    ["Nubia", "zte", "中兴"],
    ["RedMagic", "zte", "中兴"],
    ["Sony", "sony", "索尼"],
    ["Google", "google", "Google"],
    ["pixel", "google", "Google"],
    ["Nothing", "nothing", "Nothing"],
    ["  Xiaomi  ", "xiaomi", "小米"],
  ])("把 %p 归并为 %p", (raw, makerKey, makerLabel) => {
    expect(resolvePhoneMaker(raw)).toEqual({ makerKey, makerLabel });
  });

  it.each([
    null,
    undefined,
    "",
    "   ",
    "unknown",
    "devtools",
    "DevTools",
    "pc",
  ])("空值/开发环境 %p 计入未知", (raw) => {
    expect(resolvePhoneMaker(raw)).toBeNull();
  });

  it("未识别品牌归入其他", () => {
    expect(resolvePhoneMaker("BrandX")).toEqual({
      makerKey: "other",
      makerLabel: "其他",
    });
  });

  it("纯非 ASCII 未识别品牌仍归入其他而不是未知", () => {
    expect(resolvePhoneMaker("未知牌")).toEqual({
      makerKey: "other",
      makerLabel: "其他",
    });
  });
});
