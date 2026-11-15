import { BadRequestException } from "@nestjs/common";
import { buildTtsConfig } from "./tts-config.util";
import {
  TTS_TYPE_DEFAULT,
  TTS_SPD_MIN,
  TTS_SPD_MAX,
} from "./baidu-agent.types";

describe("buildTtsConfig", () => {
  it("只有 vcn 时返回不带 spd 键的配置串", () => {
    const result = buildTtsConfig({ vcn: "1000063" });
    expect(result).toBe('DEFAULT{"vcn":"1000063"}');
    // 断言没有 vol 键
    expect(result).not.toContain("vol");
  });

  it("vcn + spd 时返回完整配置串，键顺序 vcn 然后 spd", () => {
    const result = buildTtsConfig({ vcn: "1000063", spd: 0.8 });
    expect(result).toBe('DEFAULT{"vcn":"1000063","spd":0.8}');
    expect(result).not.toContain("vol");
  });

  it("spd 为 0.5（最小值）合法", () => {
    const result = buildTtsConfig({ vcn: "1000063", spd: TTS_SPD_MIN });
    expect(result).toBe('DEFAULT{"vcn":"1000063","spd":0.5}');
  });

  it("spd 为 2.0（最大值）合法", () => {
    const result = buildTtsConfig({ vcn: "1000063", spd: TTS_SPD_MAX });
    expect(result).toBe('DEFAULT{"vcn":"1000063","spd":2}');
  });

  it("spd 越界（0.4 < 0.5）抛 BadRequestException", () => {
    expect(() => buildTtsConfig({ vcn: "1000063", spd: 0.4 })).toThrow(
      BadRequestException,
    );
  });

  it("spd 越界（2.1 > 2.0）抛 BadRequestException", () => {
    expect(() => buildTtsConfig({ vcn: "1000063", spd: 2.1 })).toThrow(
      BadRequestException,
    );
  });

  it("vcn 为空字符串抛 BadRequestException", () => {
    expect(() => buildTtsConfig({ vcn: "" })).toThrow(BadRequestException);
  });

  it("vcn 为纯空白字符串抛 BadRequestException", () => {
    expect(() => buildTtsConfig({ vcn: "   " })).toThrow(BadRequestException);
  });

  it("spd 为 NaN 抛 BadRequestException", () => {
    expect(() => buildTtsConfig({ vcn: "1000063", spd: NaN })).toThrow(
      BadRequestException,
    );
  });

  it("spd 为 Infinity 抛 BadRequestException", () => {
    expect(() => buildTtsConfig({ vcn: "1000063", spd: Infinity })).toThrow(
      BadRequestException,
    );
  });

  it("spd 为 -Infinity 抛 BadRequestException", () => {
    expect(() => buildTtsConfig({ vcn: "1000063", spd: -Infinity })).toThrow(
      BadRequestException,
    );
  });

  it("断言输出里绝对没有 vol 键", () => {
    const result = buildTtsConfig({ vcn: "1000063", spd: 1.5 });
    const inner = JSON.parse(result.slice(TTS_TYPE_DEFAULT.length));
    expect(inner).toHaveProperty("vcn");
    expect(inner).toHaveProperty("spd");
    expect(inner).not.toHaveProperty("vol");
  });
});
