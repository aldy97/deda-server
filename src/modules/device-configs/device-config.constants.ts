export const DEVICE_MODES = ["free_chat", "english_chat"] as const;

export type DeviceMode = (typeof DEVICE_MODES)[number];
