import {
  isCalendarDate,
  todayInShanghai,
  IsBirthdayConstraint,
} from "./is-birthday.validator";

describe("is-birthday validator", () => {
  const constraint = new IsBirthdayConstraint();

  it("接受真实存在的日期", () => {
    expect(isCalendarDate("1990-05-20")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true);
  });

  it("拒绝不存在的日历日", () => {
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-04-31")).toBe(false);
    expect(isCalendarDate("1990-13-01")).toBe(false);
  });

  it("拒绝非 YYYY-MM-DD 格式", () => {
    expect(isCalendarDate("1990-1-1")).toBe(false);
    expect(isCalendarDate("19900520")).toBe(false);
  });

  it("今天按 Asia/Shanghai 计算", () => {
    // 2026-11-27T16:30:00Z = 上海时间 2026-11-28 00:30
    expect(todayInShanghai(new Date("2026-11-27T16:30:00Z"))).toBe(
      "2026-11-28",
    );
    expect(todayInShanghai(new Date("2026-11-28T15:59:00Z"))).toBe(
      "2026-11-28",
    );
  });

  it("接受今天，拒绝未来", () => {
    const today = todayInShanghai();
    expect(constraint.validate(today)).toBe(true);
    expect(constraint.validate("2999-01-01")).toBe(false);
  });

  it("拒绝 1900-01-01 之前", () => {
    expect(constraint.validate("1899-12-31")).toBe(false);
    expect(constraint.validate("1900-01-01")).toBe(true);
  });

  it("拒绝非字符串", () => {
    expect(constraint.validate(19900520)).toBe(false);
    expect(constraint.validate(null)).toBe(false);
  });
});
