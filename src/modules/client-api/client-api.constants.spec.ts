import {
  TTS_SPD_MAX,
  TTS_SPD_MIN,
} from "@/modules/baidu-agent/baidu-agent.types";
import {
  DEFAULT_TTS_VOL,
  deviceNickname,
  resolveTtsDefaultVol,
} from "./client-api.constants";

describe("client-api.constants", () => {
  describe("deviceNickname", () => {
    it("derives the nickname from the last six mac chars", () => {
      expect(deviceNickname("aabbccddeeff")).toBe("设备 ddeeff");
    });

    it("is stable for the same mac so getvalue can compare the echoed value", () => {
      expect(deviceNickname("aabbccddeeff")).toBe(
        deviceNickname("aabbccddeeff"),
      );
    });
  });

  describe("resolveTtsDefaultVol", () => {
    it("falls back to the default when unset or blank", () => {
      expect(resolveTtsDefaultVol(undefined)).toBe(DEFAULT_TTS_VOL);
      expect(resolveTtsDefaultVol("")).toBe(DEFAULT_TTS_VOL);
      expect(resolveTtsDefaultVol("   ")).toBe(DEFAULT_TTS_VOL);
    });

    it("accepts values inside the v1.4 0.5-2.0 range", () => {
      expect(resolveTtsDefaultVol("1")).toBe(1);
      expect(resolveTtsDefaultVol("1.5")).toBe(1.5);
      expect(resolveTtsDefaultVol(String(TTS_SPD_MIN))).toBe(TTS_SPD_MIN);
      expect(resolveTtsDefaultVol(String(TTS_SPD_MAX))).toBe(TTS_SPD_MAX);
    });

    it("returns null for values outside the range instead of clamping", () => {
      expect(resolveTtsDefaultVol("0.4")).toBeNull();
      expect(resolveTtsDefaultVol("2.1")).toBeNull();
      expect(resolveTtsDefaultVol("-1")).toBeNull();
    });

    it("returns null for non-numeric values", () => {
      expect(resolveTtsDefaultVol("loud")).toBeNull();
      expect(resolveTtsDefaultVol("NaN")).toBeNull();
      expect(resolveTtsDefaultVol("Infinity")).toBeNull();
    });
  });
});
