import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { AnalyticsDateRangeQueryDto } from "./analytics-query.dto";

const DATE_MESSAGE = "日期格式必须为 YYYY-MM-DD";

export class FleetSummaryQueryDto {
  @ApiPropertyOptional({ description: "查询日期 YYYY-MM-DD，缺省 = 昨天 T-1" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: DATE_MESSAGE })
  date?: string;
}

export class FleetPresenceTrendQueryDto extends AnalyticsDateRangeQueryDto {}

export class FleetChurnRiskQueryDto {
  @ApiPropertyOptional({ description: "流失判定天数，缺省 7，范围 1–90" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number = 7;
}

export class FleetDevicesQueryDto {
  @ApiPropertyOptional({
    description: "搜索关键词（deviceId/deviceCode/macAddress），最长 50 字符",
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  keyword?: string;

  @ApiPropertyOptional({ description: "页码，缺省 1" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: "每页条数，缺省 20，最大 100（超出静默 clamp，不返回 400）",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number = 20;
}

export class FleetDeviceDetailQueryDto {
  @ApiPropertyOptional({ description: "回看天数，缺省 30，范围 1–90" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number = 30;
}
