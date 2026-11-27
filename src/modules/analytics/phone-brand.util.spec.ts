import { resolvePhoneMaker } from "./phone-brand.util";

describe("resolvePhoneMaker", () => {
  it.each([
    ["Apple", "apple", "Apple"],
    ["HUAWEI", "huawei", "华为"],
    ["Honor", "honor", "荣耀"],
    ["Xiaomi", "xiaomi", "小米"],
    ["Redmi", "xiaomi", "小米"],
    ["POCO", "xiaomi", "小米"],
    ["OPPO", "oppo", "OPPO 系"],
    ["OnePlus", "oppo", "OPPO 系"],
    ["vivo", "vivo", "vivo 系"],
    ["iQOO", "vivo", "vivo 系"],
    ["realme", "realme", "realme"],
    ["SAMSUNG", "samsung", "三星"],
    ["Meizu", "meizu", "魅族"],
    ["Lenovo", "lenovo", "联想"],
    ["Motorola", "lenovo", "联想"],
    ["ZTE", "zte", "中兴"],
    ["Nubia", "zte", "中兴"],
    ["Sony", "sony", "索尼"],
    ["Google", "google", "Google"],
    ["Nothing", "nothing", "Nothing"],
  ])("把 %p 归并为 %p", (raw, makerKey, makerLabel) => {
    expect(resolvePhoneMaker(raw)).toEqual({ makerKey, makerLabel });
  });

  it.each([null, undefined, "", "   ", "unknown", "devtools", "pc"])(
    "空值/开发环境 %p 计入未知",
    (raw) => {
      expect(resolvePhoneMaker(raw)).toBeNull();
    },
  );

  it("未识别品牌归入其他", () => {
    expect(resolvePhoneMaker("BrandX")).toEqual({
      makerKey: "other",
      makerLabel: "其他",
    });
  });
});
