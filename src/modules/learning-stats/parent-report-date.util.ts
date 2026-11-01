export const DEFAULT_REPORT_TIMEZONE = "Asia/Shanghai";

type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsInTimezone(date: Date, timeZone: string): DateTimeParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.get("year") ?? 0,
    month: values.get("month") ?? 0,
    day: values.get("day") ?? 0,
    hour: values.get("hour") ?? 0,
    minute: values.get("minute") ?? 0,
    second: values.get("second") ?? 0,
  };
}

export function resolveReportTimezone(timezone?: string | null): string {
  const candidate = timezone?.trim() || DEFAULT_REPORT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format();
    return candidate;
  } catch {
    return DEFAULT_REPORT_TIMEZONE;
  }
}

export function isValidReportDate(dateKey: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return false;
  const date = new Date(`${dateKey}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === dateKey
  );
}

export function shiftReportDate(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function reportDateInTimezone(date: Date, timezone?: string | null) {
  const parts = partsInTimezone(date, resolveReportTimezone(timezone));
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function previousReportDate(date: Date, timezone?: string | null) {
  return shiftReportDate(reportDateInTimezone(date, timezone), -1);
}

export function isParentReportDue(
  date: Date,
  timezone?: string | null,
  dueMinutes = 75,
): boolean {
  const parts = partsInTimezone(date, resolveReportTimezone(timezone));
  return parts.hour * 60 + parts.minute >= dueMinutes;
}

function localMidnightToUtc(dateKey: string, timeZone: string): Date {
  const target = Date.parse(`${dateKey}T00:00:00Z`);
  let candidate = target;
  // 两次迭代可覆盖常规时区及 DST 切换日的偏移变化。
  for (let i = 0; i < 2; i += 1) {
    const local = partsInTimezone(new Date(candidate), timeZone);
    const representedAsUtc = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
    );
    candidate += target - representedAsUtc;
  }
  return new Date(candidate);
}

export function reportDayRange(dateKey: string, timezone?: string | null) {
  const resolvedTimezone = resolveReportTimezone(timezone);
  return {
    start: localMidnightToUtc(dateKey, resolvedTimezone),
    end: localMidnightToUtc(shiftReportDate(dateKey, 1), resolvedTimezone),
  };
}
