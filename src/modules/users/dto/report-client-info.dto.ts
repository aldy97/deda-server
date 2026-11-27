import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export class ReportClientInfoDto {
  @ApiPropertyOptional({ description: "手机品牌原始值，如 Apple / HUAWEI" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  brand?: string;
}
