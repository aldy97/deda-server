/** 对话网络口径：wifi / 4g；未知统一为 null */
export type ConversationNetworkMode = "wifi" | "4g" | null;

/**
 * 设备网络归一：Device.networkType 可能是 "WiFi"/"4G"/null，
 * MQTT networkMode 可能是 "wifi"/"4g"/null；统一成对话聚合口径。
 */
export function normalizeConversationNetworkMode(
  raw: unknown,
): ConversationNetworkMode {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value === "wifi") return "wifi";
  if (value === "4g") return "4g";
  return null;
}
