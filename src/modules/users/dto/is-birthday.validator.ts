import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from "class-validator";

/** 家长生日下限；早于该日期按录入错误处理。 */
export const BIRTHDAY_MIN = "1900-01-01";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 「今天」按产品时区 Asia/Shanghai 计算，避免服务端 UTC 在晚间把今天生日
 * 误判为未来日期。
 */
export function todayInShanghai(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 同时校验格式与真实日历日（拒 2026-02-29 / 2026-04-31）。 */
export function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

@ValidatorConstraint({ name: "isBirthday", async: false })
export class IsBirthdayConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== "string" || !isCalendarDate(value)) return false;
    return value >= BIRTHDAY_MIN && value <= todayInShanghai();
  }

  defaultMessage(_args: ValidationArguments): string {
    return `birthday must be a valid YYYY-MM-DD date between ${BIRTHDAY_MIN} and today`;
  }
}

/** 家长生日校验：YYYY-MM-DD、真实日期、1900-01-01 至今天。 */
export function IsBirthday(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: IsBirthdayConstraint,
    });
  };
}
