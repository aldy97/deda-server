import { isActiveSleepSession } from "./sleep-session.util";

const NOW = new Date("2026-11-22T12:00:00Z").getTime();

describe("isActiveSleepSession", () => {
  it("returns false for a missing session", () => {
    expect(isActiveSleepSession(null, NOW)).toBe(false);
  });

  it("returns false for a non-sleep mode", () => {
    expect(
      isActiveSleepSession({ currentMode: "free_chat", expiresAt: null }, NOW),
    ).toBe(false);
  });

  it("returns true for sleep_story without expiry", () => {
    expect(
      isActiveSleepSession(
        { currentMode: "sleep_story", expiresAt: null },
        NOW,
      ),
    ).toBe(true);
  });

  it("returns true for sleep_story before expiry", () => {
    expect(
      isActiveSleepSession(
        { currentMode: "sleep_story", expiresAt: new Date(NOW + 1) },
        NOW,
      ),
    ).toBe(true);
  });

  it("returns false exactly at expiry", () => {
    expect(
      isActiveSleepSession(
        { currentMode: "sleep_story", expiresAt: new Date(NOW) },
        NOW,
      ),
    ).toBe(false);
  });

  it("returns false after expiry", () => {
    expect(
      isActiveSleepSession(
        { currentMode: "sleep_story", expiresAt: new Date(NOW - 1) },
        NOW,
      ),
    ).toBe(false);
  });
});
