import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { APP_ASSET_MAX_DIMENSION_DEFAULT } from "../app-assets.constants";

const trimString = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

const trimOrUndefined = ({ value }: { value: unknown }) => {
  if (value === "") return undefined;
  return typeof value === "string" ? value.trim() : value;
};

export class UploadAppAssetDto {
  @ApiProperty({
    description: "素材 key（必须在注册表内）",
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
