/**
 * 哄睡会话判定（单一真相源）。
 *
 * getvalue、start 追平、device-configs 响应三处都必须用同一口径，
 * 否则「哄睡中该用 sleepSpd」会出现三份各自漂移的实现。
 */
export interface SleepSessionView {
  currentMode: string;
  expiresAt: Date | null;
}

export function isActiveSleepSession(
  session: SleepSessionView | null,
  now = Date.now(),
): boolean {
  if (!session || session.currentMode !== "sleep_story") return false;
  return !session.expiresAt || session.expiresAt.getTime() > now;
}
