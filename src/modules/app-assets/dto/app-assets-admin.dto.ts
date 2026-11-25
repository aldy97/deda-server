import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import {
  APP_ASSET_KEY_PATTERN,
  APP_ASSET_MAX_DIMENSION_DEFAULT,
  APP_ASSET_SLOT_MAX_KEY_LENGTH,
  APP_ASSET_SLOT_MAX_LABEL_LENGTH,
  APP_ASSET_SLOT_MAX_NOTE_LENGTH,
  APP_ASSET_SLOT_MAX_PAGE_LENGTH,
  APP_ASSET_SLOT_PAGE_PATTERN,
  APP_ASSET_SLOT_SUFFIX_PATTERN,
} from "../app-assets.constants";

const trimString = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

const trimOrUndefined = ({ value }: { value: unknown }) => {
  if (value === "") return undefined;
  return typeof value === "string" ? value.trim() : value;
};

/** 备注允许用空串清除；undefined 表示“这次不改”。 */
const trimNote = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") return value;
  const text = value.trim();
  return text.length > 0 ? text : null;
};

export class UploadAppAssetDto {
  @ApiProperty({
    description: "素材 key（必须在注册表内且已启用）",
    example: "diagnostics/remote-probe",
  })
  @Transform(trimString)
  @IsString()
  key!: string;

  @ApiProperty({ description: "展示宽度，1–8000", example: 512 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(APP_ASSET_MAX_DIMENSION_DEFAULT)
  width!: number;

  @ApiProperty({ description: "展示高度，1–8000", example: 512 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(APP_ASSET_MAX_DIMENSION_DEFAULT)
  height!: number;

  @ApiPropertyOptional({ description: "备注", example: "首屏探针图" })
  @IsOptional()
  @Transform(trimOrUndefined)
  @IsString()
  note?: string;
}

export class AppAssetVersionsQueryDto {
  @ApiProperty({
    description: "素材 key（含 /，用 query 而非 path param）",
    example: "diagnostics/remote-probe",
  })
  @Transform(trimString)
  @IsString()
  key!: string;
}

export class CreateAppAssetSlotDto {
  @ApiProperty({
    description: "页面短 code，必须等于 key 的第一段",
    example: "device-home",
  })
  @Transform(trimString)
  @IsString()
  @MaxLength(APP_ASSET_SLOT_MAX_PAGE_LENGTH)
  @Matches(APP_ASSET_SLOT_PAGE_PATTERN)
  page!: string;

  @ApiProperty({
    description: "展示位后缀，拼在 page 后面，可用 / 分多段",
    example: "section-hero",
  })
  @Transform(trimString)
  @IsString()
  @Matches(APP_ASSET_SLOT_SUFFIX_PATTERN)
  suffix!: string;

  @ApiProperty({ description: "中文标签", example: "首页主视觉" })
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(APP_ASSET_SLOT_MAX_LABEL_LENGTH)
  label!: string;

  @ApiPropertyOptional({
    description: "备注：用在哪 / 设计稿 / 责任人",
    example: "设计稿 A / 熊枫",
  })
  @IsOptional()
  @Transform(trimNote)
  @IsString()
  @MaxLength(APP_ASSET_SLOT_MAX_NOTE_LENGTH)
  note?: string | null;
}

export class UpdateAppAssetSlotDto {
  @ApiProperty({
    description: "要更新的展示位 key（含 /，放在 body 里）",
    example: "device-home/section-hero",
  })
  @Transform(trimString)
  @IsString()
  @MaxLength(APP_ASSET_SLOT_MAX_KEY_LENGTH)
  @Matches(APP_ASSET_KEY_PATTERN)
  key!: string;

  @ApiPropertyOptional({ description: "中文标签", example: "首页主视觉" })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(APP_ASSET_SLOT_MAX_LABEL_LENGTH)
  label?: string;

  @ApiPropertyOptional({
    description: "备注；传空串清除",
    example: "设计稿 B",
  })
  @IsOptional()
  @Transform(trimNote)
  @IsString()
  @MaxLength(APP_ASSET_SLOT_MAX_NOTE_LENGTH)
  note?: string | null;

  @ApiPropertyOptional({
    description: "启用 / 停用；停用前必须先下架线上素材",
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
