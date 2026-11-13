/**
 * 冒险域的「日」口径。
 *
 * 单独成文件的唯一理由：引擎（每日额度、daily.assignedDate）与自愈巡检
 * （跨天陈旧 daily 判定、补 completedDate）必须用**同一个**日期口径，
 * 否则巡检会把引擎认为「今天」的行判成陈旧并收走，直接毁掉孩子的当日额度。
 * 放在这里两边共用，杜绝两处各写一份 local-time 格式化。
 *
 * 用服务器本地时区（与既有行为一致，不改成 UTC）：每日额度是给孩子看的
 * 日历日，家庭的「今天」就是设备所在时区的今天。
 */
export function adventureDateKey(date: Date = new Date()): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}
