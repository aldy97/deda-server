/**
 * client-api 模块共享常量。
 *
 * devices 模块的 provision-candidates 接口复用本文件的认领窗口常量，
 * 保证「设备上线写入」与「小程序轮询读取」口径一致。
 */

/** 最近上线设备 sorted set 的 Redis key（member=mac，score=上线时间戳 ms） */
export const PROVISION_RECENT_KEY = "provision:recent";

/** 认领窗口默认时长（秒）：loginMac 后该时长内设备可被小程序认领绑定 */
export const DEFAULT_PROVISION_WINDOW_SECONDS = 120;

/**
 * 解析认领窗口配置（PROVISION_CLAIM_WINDOW_SEC，秒 → 毫秒）。
 * 非法值回落默认窗口。client-api（写入）与 devices（读取）共用。
 */
export const resolveProvisionWindowMs = (raw: string | undefined): number => {
  const seconds = Number(raw ?? DEFAULT_PROVISION_WINDOW_SECONDS);
  return (
    (Number.isFinite(seconds) && seconds > 0
      ? seconds
      : DEFAULT_PROVISION_WINDOW_SECONDS) * 1000
  );
};

/** 百度实例登记记录的 TTL（秒）：防御性过期，正常由 stop 标记结束 */
export const BOT_INSTANCE_TTL_SECONDS = 24 * 3600;

/** 当前实例指针 key 前缀：`bot:current:{mac}` → instanceid */
export const botCurrentKey = (mac: string): string => `bot:current:${mac}`;

/** 实例登记 key：`bot:inst:{mac}:{instanceid}` → JSON 记录 */
export const botInstanceKey = (mac: string, instanceId: string): string =>
  `bot:inst:${mac}:${instanceId}`;
