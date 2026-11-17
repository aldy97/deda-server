/**
 * 哄睡时段判定。
 *
 * 窗口口径：北京时间当日 `HH:mm >= sleepTime`，至当日 24:00 结束。
 * 该窗口同时服务两件事，因此必须是同一份实现：
 * 1. forceSleep 强制哄睡的生效区间；
 * 2. `sleep_story` 意图的时段门禁（白天说「我困了」不进哄睡）。
 *
 * 时区一律按 Asia/Shanghai 解释，与 sleep-scheduler.service.ts 的定时扫描
 * 保持同一口径；绝不能用服务器本地时区或设备时区，否则跨时区部署或
 * 设备时钟漂移会让边界整段错位。
 *
 * TODO(sleep): scheduler 内另有一份 beijingParts（含 dateKey），两处时区
 * 逻辑仍重复；合并需同时改动定时扫描，超出本次范围。
 */

/** 与 sleep-scheduler.service.ts 一致的单一时区约定 */
export const SLEEP_TIMEZONE = "Asia/Shanghai";

/** schema 里 sleepTime 的默认值；设备没有配置行时按它门禁 */
export const DEFAULT_SLEEP_TIME = "21:30";

/** 与 update-sleep-config.dto.ts 的校验正则一致：零填充 24h 制 HH:mm */
const SLEEP_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function beijingHHmm(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SLEEP_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.get("hour")}:${values.get("minute")}`;
}

/**
 * 当前时刻是否落在哄睡时段内。
 *
 * `sleepTime` 缺省（无配置行 / null / 空串）时按产品默认 21:30 门禁，
 * 保证未配置设备与已配置设备行为一致。历史脏数据（如未零填充的 "9:30"）
 * 判为不在窗口——即不强制哄睡、也不拦孩子的请求，失败方向一律偏向
 * 「少限制孩子」，不让一条坏配置把设备锁进哄睡模式。
 *
 * 零填充 HH:mm 的字典序等价于时间序，故直接字符串比较。
 */
export function isInSleepWindow(now: Date, sleepTime?: string | null): boolean {
  const configured = sleepTime?.trim() ?? "";
  const threshold = configured === "" ? DEFAULT_SLEEP_TIME : configured;
  if (!SLEEP_TIME_PATTERN.test(threshold)) return false;
  return beijingHHmm(now) >= threshold;
}
