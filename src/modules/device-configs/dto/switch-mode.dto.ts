import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsNotEmpty, IsOptional, IsIn } from "class-validator";
import { DEVICE_MODES } from "../device-config.constants";

export class SwitchModeDto {
  @ApiProperty({
    description: "对话模式",
    enum: ["free_chat", "textbook_learning", "locked_unit", "free_textbook"],
  })
  @IsIn(DEVICE_MODES)
  mode: string;

  @ApiPropertyOptional({ description: "自由对话子模式 key" })
  @IsOptional()
  @IsString()
  conversationModeKey?: string;

  @ApiPropertyOptional({ description: "教材业务 ID" })
  @IsOptional()
  @IsString()
  textbookId?: string;

  @ApiPropertyOptional({ description: "单元业务 ID" })
  @IsOptional()
  @IsString()
  unitId?: string;

  @ApiPropertyOptional({ description: "语言：zh/en/bilingual" })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ description: "语速：slow/normal/fast" })
  @IsOptional()
  @IsString()
  speechRate?: string;
}
