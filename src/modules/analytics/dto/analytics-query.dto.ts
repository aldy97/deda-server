import { IsIn, IsOptional, IsString, Matches } from "class-validator";

const DATE_MESSAGE = "日期格式必须为 YYYY-MM-DD";

export class AnalyticsDateQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  date?: string;
}

export class AnalyticsDateRangeQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  startDate!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  endDate!: string;
}

export class AnalyticsTrendQueryDto extends AnalyticsDateRangeQueryDto {
  @IsOptional()
  @IsString()
  granularity?: "day" | "week" | "month";

  /** 逗号分隔多选：dau,avgDuration,poweredOn,newActivated,newUsers */
  @IsOptional()
  @IsString()
  metrics?: string;

  @IsOptional()
  @IsString()
  characterKey?: string;
}

export class AnalyticsCohortsQueryDto extends AnalyticsDateRangeQueryDto {
  @IsOptional()
  @IsIn(["day", "week"])
  granularity?: "day" | "week";

  @IsOptional()
  @IsIn(["activation", "firstUse"])
  basis?: "activation" | "firstUse";
}

export class AnalyticsCurveQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  cohortStartDate?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  cohortEndDate?: string;
}
