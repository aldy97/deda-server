import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class UpsertChildProfileDto {
  @ApiPropertyOptional({ description: "孩子姓名" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @ApiPropertyOptional({ description: "生日，格式 YYYY-MM-DD" })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "birthday must be in YYYY-MM-DD format",
  })
  birthday?: string;

  @ApiPropertyOptional({ description: "孩子英文名，AI 称呼用" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  englishName?: string;

  @ApiPropertyOptional({
    description: "孩子性别；null 表示未设置或清除已填性别",
    enum: ["male", "female"],
    nullable: true,
  })
  @IsOptional()
  @IsIn(["male", "female"])
  gender?: "male" | "female" | null;
}
