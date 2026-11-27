import { normalizeConversationNetworkMode } from "./network-mode.util";

describe("normalizeConversationNetworkMode", () => {
  it.each([
    ["WiFi", "wifi"],
    ["wifi", "wifi"],
    [" WiFi ", "wifi"],
    ["4G", "4g"],
    ["4g", "4g"],
  ])("把 %p 归一为 %p", (raw, expected) => {
    expect(normalizeConversationNetworkMode(raw)).toBe(expected);
  });

  it.each([null, undefined, "", "  ", "5g", "ethernet", 1, {}])(
    "无法识别的值 %p 归为 null",
    (raw) => {
      expect(normalizeConversationNetworkMode(raw)).toBeNull();
    },
  );
});
