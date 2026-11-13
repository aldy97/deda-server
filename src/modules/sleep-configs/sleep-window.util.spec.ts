import {
  DEFAULT_SLEEP_TIME,
  SLEEP_TIMEZONE,
  isInSleepWindow,
} from "./sleep-window.util";

/**
 * 哄睡时段判定单测。
 *
 * 窗口口径：北京时间当日 HH:mm >= sleepTime，至当日 24:00 结束。
 * 断言全部使用固定 UTC 瞬间（Asia/Shanghai 恒为 UTC+8、无夏令时），
 * 因此无论 jest 进程跑在哪个时区，结果都必须一致——这是本 util
 * 存在的唯一理由：绝不能用服务器本地时区或设备时区判时段。
 */
describe("sleep-window.util", () => {
  /** UTC 瞬间 → 北京时间 = UTC + 8h */
  const utc = (iso: string) => new Date(iso);

  it("暴露与 scheduler 一致的时区与产品默认就寝时间", () => {
    expect(SLEEP_TIMEZONE).toBe("Asia/Shanghai");
    expect(DEFAULT_SLEEP_TIME).toBe("21:30");
  });

  describe("窗口边界", () => {
    it.each([
      // 北京 21:30 == sleepTime，含起点
      ["2026-11-13T13:30:00.000Z", "21:30", true],
      // 北京 21:29，起点前一分钟
      ["2026-11-13T13:29:00.000Z", "21:30", false],
      // 北京 23:59，当日最后一分钟仍在窗口内
      ["2026-11-13T15:59:00.000Z", "21:30", true],
      // 北京次日 00:00，窗口已结束
      ["2026-11-13T16:00:00.000Z", "21:30", false],
      // 北京次日 00:30
      ["2026-11-13T16:30:00.000Z", "21:30", false],
      // 北京 15:00（熊总的反例：白天说困了不进哄睡）
      ["2026-11-13T07:00:00.000Z", "21:30", false],
    ])("北京时刻 %s 对 sleepTime=%s 判定为 %s", (iso, sleepTime, expected) => {
      expect(isInSleepWindow(utc(iso), sleepTime)).toBe(expected);
    });
  });

  describe("sleepTime 极值", () => {
    it.each([
      // sleepTime=00:00 → 全天都是窗口
      ["2026-11-13T00:00:00.000Z", "00:00", true],
      ["2026-11-13T04:00:00.000Z", "00:00", true],
      ["2026-11-13T15:59:00.000Z", "00:00", true],
      // sleepTime=23:50 → 窗口仅 10 分钟
      ["2026-11-13T15:49:00.000Z", "23:50", false],
      ["2026-11-13T15:50:00.000Z", "23:50", true],
      ["2026-11-13T15:59:00.000Z", "23:50", true],
      // sleepTime 设在凌晨 03:00 → 03:00 起至当日 24:00
      ["2026-11-12T18:59:00.000Z", "03:00", false],
      ["2026-11-12T19:00:00.000Z", "03:00", true],
      ["2026-11-13T15:00:00.000Z", "03:00", true],
    ])("北京时刻 %s 对 sleepTime=%s 判定为 %s", (iso, sleepTime, expected) => {
      expect(isInSleepWindow(utc(iso), sleepTime)).toBe(expected);
    });
  });

  describe("缺失与非法配置", () => {
    it.each([
      ["北京 22:00 无配置行按默认 21:30 门禁", "2026-11-13T14:00:00.000Z"],
      ["北京 20:00 无配置行按默认 21:30 门禁", "2026-11-13T12:00:00.000Z"],
    ])("%s", (_label, iso) => {
      const inWindow = isInSleepWindow(utc(iso), null);
      expect(inWindow).toBe(isInSleepWindow(utc(iso), DEFAULT_SLEEP_TIME));
    });

    it("undefined 与 null 同义，都回落到产品默认值", () => {
      const at = utc("2026-11-13T14:00:00.000Z");
      expect(isInSleepWindow(at, undefined)).toBe(true);
      expect(isInSleepWindow(at, null)).toBe(true);
      expect(isInSleepWindow(at, "")).toBe(true);
    });

    it.each([
      ["9:30", "未零填充"],
      ["24:00", "小时越界"],
      ["21:60", "分钟越界"],
      ["abc", "非时间"],
      ["2130", "缺分隔符"],
    ])("非法 sleepTime %s（%s）判为不在窗口，不限制孩子", (bad) => {
      expect(isInSleepWindow(utc("2026-11-13T15:59:00.000Z"), bad)).toBe(false);
    });
  });

  describe("时区无关性", () => {
    it("同一 UTC 瞬间在任何进程时区下判定一致", () => {
      const originalTz = process.env.TZ;
      const beijing2200 = utc("2026-11-13T14:00:00.000Z");
      const baseline = isInSleepWindow(beijing2200, "21:30");
      try {
        for (const tz of ["UTC", "America/New_York", "Asia/Shanghai"]) {
          process.env.TZ = tz;
          expect(isInSleepWindow(beijing2200, "21:30")).toBe(baseline);
        }
      } finally {
        process.env.TZ = originalTz;
      }
      expect(baseline).toBe(true);
    });
  });
});
