import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/**
 * 测试设备白名单入参。
 *
 * query 的两个老坑沿用仓库既有写法：空串视为未提供；`"false"` 经 Boolean()
 * 会变成 true，必须显式映射。理由长度在 DTO 钉下限，服务层再 assert 一次
 * （HTTP 之外的调用方也必须过同一道闸）。
 */

function emptyToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

function queryBoolean({ value }: { value: unknown }): unknown {
  const normalized = emptyToUndefined(value);
  if (normalized === undefined) return undefined;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return normalized;
}

function trimString({ value }: { value: unknown }): unknown {
  return typeof value === "string" ? value.trim() : value;
}

/** 空串视为未提供，其余先 trim；用于可选文本字段。 */
function trimOrUndefined({ value }: { value: unknown }): unknown {
  const normalized = emptyToUndefined(value);
  return typeof normalized === "string" ? normalized.trim() : normalized;
}

export class ListTestDevicesQueryDto {
  @ApiPropertyOptional({
    description: "按业务设备号 / 设备编码 / MAC 搜索，最长 50 字符",
  })
  @IsOptional()
  @Transform(trimOrUndefined)
  @IsString()
  @MaxLength(50)
  keyword?: string;

  @ApiPropertyOptional({
    description: "是否包含已撤销的记录，缺省 false（只看在册）",
  })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  includeRevoked?: boolean;

  @ApiPropertyOptional({ description: "页码，缺省 1" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: "每页条数，缺省 50，最大 200",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

export class AddTestDeviceDto {
  @ApiProperty({
    description: "业务设备号（小写 MAC）、设备编码或 MAC 地址",
  })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  deviceId: string;

  @ApiPropertyOptional({ description: "用途备注，最长 100 字" })
  @IsOptional()
  @Transform(trimOrUndefined)
  @IsString()
  @MaxLength(100)
  note?: string;

  @ApiProperty({ description: "变更理由，至少 8 个字，最长 300 字" })
  @Transform(trimString)
  @IsString()
  @MinLength(8)
  @MaxLength(300)
  reason: string;
}

export class RevokeTestDeviceDto {
  @ApiProperty({ description: "撤销理由，至少 8 个字，最长 300 字" })
  @Transform(trimString)
  @IsString()
  @MinLength(8)
  @MaxLength(300)
  reason: string;
}
