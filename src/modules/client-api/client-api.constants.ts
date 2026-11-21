/**
 * client-api 模块共享常量。
 *
 * devices 模块的 provision-candidates 接口复用本文件的认领窗口常量，
 * 保证「设备上线写入」与「小程序轮询读取」口径一致。
 */

import {
  TTS_SPD_MAX,
  TTS_SPD_MIN,
} from "@/modules/baidu-agent/baidu-agent.types";

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

/**
 * 设备昵称派生规则：loginMac 下发与 getvalue 回传校验共用同一处，
 * 避免两个接口对同一台设备给出不同的 nickname（v1.4 §4.1 要求原值回传）。
 */
export const deviceNickname = (mac: string): string => `设备 ${mac.slice(-6)}`;

/** `TTS_DEFAULT_VOL` 未配置时采用的 TTS 合成音量倍数（v1.4 §4.2 的基础值） */
export const DEFAULT_TTS_VOL = 1;

/**
 * 解析 `TTS_DEFAULT_VOL`（getvalue 响应体 `vol` 的唯一来源，全局配置，不做每设备可调）。
 *
 * 未配置（undefined / 空串）→ 默认 1.0。非数字或超出 v1.4 §4.2 的
 * `[0.5, 2.0]`（与 `TTS_SPD_MIN`/`TTS_SPD_MAX` 同一区间，vol 与 spd 共用百度
 * 内置 DEFAULT TTS 的取值范围）→ 返回 null，由调用方 fail-closed 抛 500：
 * 越界值下发给固件同样会让它按 §4.3 停止本轮创建，裁剪成边界值等于把配置错误
 * 伪装成正常，因此不裁剪、不猜默认值。
 */
export const resolveTtsDefaultVol = (
  raw: string | undefined,
): number | null => {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_TTS_VOL;
  const vol = Number(trimmed);
  if (!Number.isFinite(vol)) return null;
  if (vol < TTS_SPD_MIN || vol > TTS_SPD_MAX) return null;
  return vol;
};
