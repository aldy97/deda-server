export const DEVICE_MODES = [
  "free_chat",
  "textbook_learning",
  "locked_unit",
  "free_textbook",
] as const;

export type DeviceMode = (typeof DEVICE_MODES)[number];
